import fs from 'node:fs';
import path from 'node:path';
import { CI_CHECKS, orchestrationRequiredCheckSchema, type OrchestrationRequiredCheck } from './orchestrationContract.js';

export interface PackageManifest {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}
export interface VerificationCommand {
  script: string;
  bin: string;
  args: string[];
  display: string;
}
export const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

export function readManifest(cwd: string): PackageManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
export function packageManagerFor(cwd: string, manifest: PackageManifest): string {
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : '';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}
export function packageManagerBinary(manager: string): string {
  return process.platform === 'win32' ? manager + '.cmd' : manager;
}
export function hasScript(scripts: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(scripts, name) && typeof scripts[name] === 'string' && (scripts[name] as string).trim().length > 0;
}
/** The checkable scripts a repository defines (orchestrationRequiredCheckSchema names with a command). */
export function definedCheckScripts(cwd: string): OrchestrationRequiredCheck[] {
  const scripts = readManifest(cwd)?.scripts ?? {};
  return orchestrationRequiredCheckSchema.options.filter(name => hasScript(scripts, name));
}
export function discoverVerificationCommands(cwd: string, requestedScripts?: readonly string[]): VerificationCommand[] {
  const manifest = readManifest(cwd);
  if (!manifest?.scripts) return [];
  const scripts = manifest.scripts;
  const manager = packageManagerFor(cwd, manifest);
  const requested = [...new Set(requestedScripts ?? [])];
  const combined = requested.length ? undefined : ['verify', 'check', 'validate', 'ci'].find(name => hasScript(scripts, name));
  const defaults = combined ? [combined] : CI_CHECKS.filter(name => hasScript(scripts, name));
  const selected = requested.length ? requested.filter(name => hasScript(scripts, name)) : defaults;
  return selected.map(script => ({
    script, bin: packageManagerBinary(manager), args: ['run', script], display: manager + ' run ' + script
  }));
}

/**
 * Preflight for common accidental servers/watchers, including script aliases and
 * lifecycle hooks. This is not a shell sandbox: arbitrary JS and external tools
 * remain opaque and are bounded by the process manager's timeout.
 */
export function verificationScriptProblem(scripts: Record<string, unknown>, script: string, visiting = new Set<string>(), budget = { remaining: 128 }): string | undefined {
  if (--budget.remaining < 0) return 'Verification script graph exceeds the bounded inspection limit.';
  if (visiting.size >= 16) return 'Verification script alias depth exceeds the bounded inspection limit.';
  if (visiting.has(script)) return 'Cyclic verification script reference: ' + script;
  if (!hasScript(scripts, script)) return 'Missing referenced verification script: ' + script;
  const next = new Set(visiting).add(script);
  const body = scripts[script] as string;
  if (body.length > 8_000) return 'Verification script exceeds the bounded inspection limit.';
  // Preserve quoted arguments so an echoed command is not mistaken for execution.
  const tokens: string[] = body.match(/"[^"]*"|'[^']*'|\d*>&\d+|&&|\|\||\r?\n|[;&|]|[^\s;&|]+/g) ?? [];
  const words = tokens.map(word => word.replace(/^(['"])(.*)\1$/, '$2'));
  if (tokens.includes('&')) return 'Background commands are not bounded verification; use the managed preview.';
  let start = 0;
  for (let end = 0; end <= words.length; end++) {
    if (end < words.length && !['&&', '||', ';', '|', '\n', '\r\n'].includes(words[end])) continue;
    let command = words.slice(start, end);
    start = end + 1;
    while (command.length && (/^[A-Za-z_][\w]*=/.test(command[0]) || command[0] === 'cross-env')) command = command.slice(1);
    if (['npx', 'bunx'].includes(command[0])) command = command.slice(1);
    const bin = (command[0] ?? '').replace(/.*[\\/]/, '').replace(/\.(cmd|exe)$/, '');
    const args = command.slice(1);
    if (['echo', 'printf'].includes(bin)) continue;
    if (args.some(arg => /^--watch(?:All)?(?:=true)?$/.test(arg)) ||
        (['tsc', 'vitest'].includes(bin) && args.includes('-w')) ||
        (bin === 'tsx' && args[0] === 'watch') ||
        (bin === 'vitest' && !args.includes('run') && !args.includes('--run'))) {
      return 'Watch mode is not bounded verification (' + script + '); configure a one-shot check.';
    }
    if ((['vite', 'next', 'nuxt'].includes(bin) && !['build', 'lint', 'typegen', 'typecheck'].includes(args[0])) ||
        ['serve', 'http-server', 'nodemon'].includes(bin) ||
        (/^python(?:3)?$/.test(bin) && args.includes('http.server')) ||
        (bin === 'php' && args.includes('-S')) || (bin === 'flask' && args[0] === 'run')) {
      return 'Development servers belong to the managed preview, not verification (' + script + ').';
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin)) {
      const target = args[0] === 'run' || args[0] === 'run-script' ? args[1]
        : args[0] === 'test' || args[0] === 'start' ? args[0]
        : ['pnpm', 'yarn', 'bun'].includes(bin) && hasScript(scripts, args[0]) ? args[0] : undefined;
      if (target) {
        const problem = verificationScriptProblem(scripts, target, next, budget);
        if (problem) return problem;
      }
    }
  }
  for (const hook of ['pre' + script, 'post' + script]) {
    if (!hasScript(scripts, hook)) continue;
    const problem = verificationScriptProblem(scripts, hook, next, budget);
    if (problem) return problem;
  }
  return undefined;
}

/** Read afresh for each attempt; never invent commands for unsupported projects. */
export function describeRepositoryExecution(cwd: string, requiredScripts?: readonly string[]): string {
  const manifest = readManifest(cwd);
  const commands = discoverVerificationCommands(cwd, requiredScripts);
  const scripts = manifest?.scripts ?? {};
  const checks = commands.map(command => {
    const problem = verificationScriptProblem(scripts, command.script);
    return command.script + ': ' + command.display + (problem ? ' — unavailable: ' + problem : '');
  });
  const missing = (requiredScripts ?? []).filter(name => !hasScript(scripts, name));
  return [
    'Repository execution facts (observed by Alpha for this attempt):',
    'Operating system: ' + process.platform + '; repository: ' + path.basename(cwd) + '. Use the assigned repository tools.',
    manifest ? 'Package manager: ' + packageManagerFor(cwd, manifest) + '.' : 'No readable package.json; automatic package-script verification is unavailable.',
    checks.length ? 'Registered checks:\n' + checks.join('\n') : 'No conventional verification scripts were found. Do not invent commands or claim verification passed.',
    missing.length ? 'Missing assigned checks: ' + missing.join(', ') + '.' : '',
    'Specialists request only assigned checks through project_run_check; commands shown here describe what Alpha executes, not shell permission.',
    'Checks use CI=true and a five-minute process limit. No watch mode or unmanaged servers. Alpha owns Git checkpoints.',
    'Alpha manages website previews from accepted frontend checkpoints. Readiness does not establish browser correctness; report missing configuration and preview errors explicitly.'
  ].filter(Boolean).join('\n');
}
