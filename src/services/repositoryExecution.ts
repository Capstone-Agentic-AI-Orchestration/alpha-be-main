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

/** Flags that run a package-manager command in another package directory. */
const PACKAGE_DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
/** Flags that run it across or in other workspace packages, which this preflight cannot resolve to one directory. */
const OTHER_PACKAGES_FLAGS = new Set(['--workspace', '-w', '--workspaces', '-ws', '--filter', '-F', '--recursive', '-r']);
/** Of those, the ones that take a value (the next word, or after "="). */
const VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--filter', '-F']);
const SEPARATORS = new Set(['&&', '||', ';', '|', '\n', '\r\n']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

interface PackageManagerArgs { positional: string[]; dir?: string; otherPackages: boolean }

function parsePackageManagerArgs(args: readonly string[]): PackageManagerArgs {
  const parsed: PackageManagerArgs = { positional: [], otherPackages: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) { parsed.positional.push(arg); continue; }
    const equals = arg.indexOf('=');
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    let value: string | undefined;
    if (VALUE_FLAGS.has(flag)) value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
    if (PACKAGE_DIR_FLAGS.has(flag)) parsed.dir = value;
    else if (OTHER_PACKAGES_FLAGS.has(flag)) parsed.otherPackages = true;
  }
  return parsed;
}

/**
 * Where a package-manager command runs and which script it names. `npm run test --prefix apps/api`
 * runs apps/api's own test script, not this package's: treating it as this package's script made
 * every root script that delegates to an app look like it called itself.
 */
function packageManagerTarget(bin: string, args: readonly string[], scripts: Record<string, unknown>):
  { elsewhere: 'none' | 'dir' | 'unresolved'; dir?: string; script?: string } {
  const { positional, dir, otherPackages } = parsePackageManagerArgs(args);
  if (otherPackages || ['workspace', 'workspaces'].includes(positional[0] ?? '')) return { elsewhere: 'unresolved' };
  const [first, second] = positional;
  let script: string | undefined;
  if (first === 'run' || first === 'run-script') script = second;
  else if (first === 'test' || first === 'start') script = first;
  else if (bin !== 'npm' && first && (dir !== undefined || hasScript(scripts, first))) script = first;
  return dir !== undefined ? { elsewhere: 'dir', dir, script } : { elsewhere: 'none', script };
}

/** The commands of a script body, split at shell separators, with env assignments and npx removed. */
function scriptCommands(body: string): Array<{ bin: string; args: string[] }> | 'background' {
  // Preserve quoted arguments so an echoed command is not mistaken for execution.
  const tokens: string[] = body.match(/"[^"]*"|'[^']*'|\d*>&\d+|&&|\|\||\r?\n|[;&|]|[^\s;&|]+/g) ?? [];
  if (tokens.includes('&')) return 'background';
  const words = tokens.map(word => word.replace(/^(['"])(.*)\1$/, '$2'));
  const commands: Array<{ bin: string; args: string[] }> = [];
  let start = 0;
  for (let end = 0; end <= words.length; end++) {
    if (end < words.length && !SEPARATORS.has(words[end])) continue;
    let command = words.slice(start, end);
    start = end + 1;
    while (command.length && (/^[A-Za-z_]\w*=/.test(command[0]) || command[0] === 'cross-env')) command = command.slice(1);
    if (['npx', 'bunx'].includes(command[0])) command = command.slice(1);
    const name = (command[0] ?? '').split(/[\\/]/).pop() ?? '';
    commands.push({ bin: name.replace(/\.(cmd|exe)$/, ''), args: command.slice(1) });
  }
  return commands;
}

/** A watcher or a development server, which never finishes on its own. */
function unboundedCommand(script: string, bin: string, args: readonly string[]): string | undefined {
  const watches = args.some(arg => /^--watch(?:All)?(?:=true)?$/.test(arg)) ||
    (['tsc', 'vitest'].includes(bin) && args.includes('-w')) ||
    (bin === 'tsx' && args[0] === 'watch') ||
    (bin === 'vitest' && !args.includes('run') && !args.includes('--run'));
  if (watches) return 'Watch mode is not bounded verification (' + script + '); configure a one-shot check.';
  const serves = (['vite', 'next', 'nuxt'].includes(bin) && !['build', 'lint', 'typegen', 'typecheck'].includes(args[0])) ||
    ['serve', 'http-server', 'nodemon'].includes(bin) ||
    (/^python(?:3)?$/.test(bin) && args.includes('http.server')) ||
    (bin === 'php' && args.includes('-S')) || (bin === 'flask' && args[0] === 'run');
  return serves ? 'Development servers belong to the managed preview, not verification (' + script + ').' : undefined;
}

interface Inspection { visiting: Set<string>; budget: { remaining: number }; packageDir?: string; repositoryRoot?: string }

/** The limits and lookups that refuse a script before its commands are read. */
function scriptGuardProblem(scripts: Record<string, unknown>, script: string, key: string, visiting: Set<string>, budget: { remaining: number }): string | undefined {
  if (--budget.remaining < 0) return 'Verification script graph exceeds the bounded inspection limit.';
  if (visiting.size >= 16) return 'Verification script alias depth exceeds the bounded inspection limit.';
  if (visiting.has(key)) return 'Cyclic verification script reference: ' + script;
  if (!hasScript(scripts, script)) return 'Missing referenced verification script: ' + script;
  if ((scripts[script] as string).length > 8_000) return 'Verification script exceeds the bounded inspection limit.';
  return undefined;
}

/** The script's pre and post lifecycle hooks, which npm runs around it. */
function hookProblem(scripts: Record<string, unknown>, script: string, at: Inspection): string | undefined {
  for (const hook of ['pre' + script, 'post' + script]) {
    if (!hasScript(scripts, hook)) continue;
    const problem = verificationScriptProblem(scripts, hook, at.visiting, at.budget, at.packageDir, at.repositoryRoot);
    if (problem) return problem;
  }
  return undefined;
}

/** The script a package-manager command runs, inspected where it runs. */
function delegatedProblem(bin: string, args: readonly string[], scripts: Record<string, unknown>, at: Inspection): string | undefined {
  const target = packageManagerTarget(bin, args, scripts);
  if (!target.script || target.elsewhere === 'unresolved') return undefined;
  if (target.elsewhere === 'none') {
    return verificationScriptProblem(scripts, target.script, at.visiting, at.budget, at.packageDir, at.repositoryRoot);
  }
  // Another package: inspected only inside this repository, with its own scripts.
  if (!at.packageDir || !at.repositoryRoot || !target.dir) return undefined;
  const otherDir = path.resolve(at.packageDir, target.dir);
  const inside = path.relative(path.resolve(at.repositoryRoot), otherDir);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
  const otherScripts = readManifest(otherDir)?.scripts;
  if (!otherScripts) return 'Missing referenced verification package: ' + target.dir;
  return verificationScriptProblem(otherScripts, target.script, at.visiting, at.budget, otherDir, at.repositoryRoot);
}

/**
 * Preflight for common accidental servers/watchers, including script aliases and
 * lifecycle hooks. This is not a shell sandbox: arbitrary JS and external tools
 * remain opaque and are bounded by the process manager's timeout.
 *
 * `packageDir` is the package these scripts belong to. With it, a script run in another
 * package of the repository (`--prefix apps/api`) is inspected in that package's own
 * manifest; without it, or for workspace-wide commands, such a script is left opaque.
 */
export function verificationScriptProblem(scripts: Record<string, unknown>, script: string, visiting = new Set<string>(), budget = { remaining: 128 },
  packageDir?: string, repositoryRoot = packageDir): string | undefined {
  const key = (packageDir ? path.resolve(packageDir) : '') + '\0' + script;
  const refused = scriptGuardProblem(scripts, script, key, visiting, budget);
  if (refused) return refused;
  const commands = scriptCommands(scripts[script] as string);
  if (commands === 'background') return 'Background commands are not bounded verification; use the managed preview.';
  const at: Inspection = { visiting: new Set(visiting).add(key), budget, packageDir, repositoryRoot };
  for (const { bin, args } of commands) {
    if (['echo', 'printf'].includes(bin)) continue;
    const problem = unboundedCommand(script, bin, args) ?? (PACKAGE_MANAGERS.has(bin) ? delegatedProblem(bin, args, scripts, at) : undefined);
    if (problem) return problem;
  }
  return hookProblem(scripts, script, at);
}

/** Read afresh for each attempt; never invent commands for unsupported projects. */
export function describeRepositoryExecution(cwd: string, requiredScripts?: readonly string[]): string {
  const manifest = readManifest(cwd);
  const commands = discoverVerificationCommands(cwd, requiredScripts);
  const scripts = manifest?.scripts ?? {};
  const checks = commands.map(command => {
    const problem = verificationScriptProblem(scripts, command.script, undefined, undefined, cwd);
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
