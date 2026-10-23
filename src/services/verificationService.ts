import fs from 'node:fs';
import path from 'node:path';
import { processManager } from './processManager.js';

/**
 * Commands Alpha is willing to discover from a repository's package manifest.
 *
 * The command is still authored by the repository owner, but the script name
 * is passed as an argument to the package manager rather than through a shell.
 * That keeps issue text and package metadata from becoming shell syntax.
 */
const COMBINED_CHECK_SCRIPTS = ['verify', 'check', 'validate', 'ci'] as const;
const INDIVIDUAL_CHECK_SCRIPTS = ['test', 'typecheck', 'lint'] as const;
const MAX_OUTPUT_CHARS = 12_000;
/** Install errors that mean the cached package listings are out of date, not that the lockfile is wrong. */
const STALE_METADATA = /\bETARGET\b|notarget|No matching version found|ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_META_FETCH/i;

export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'cancelled';

export interface VerificationCommand {
  script: string;
  bin: string;
  args: string[];
  display: string;
}

export interface VerificationCommandResult {
  command: VerificationCommand;
  exitCode: number | null;
  signal: string | null;
  output: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  commands: VerificationCommandResult[];
  /** Dependency preparation is reported separately from the repository's checks. */
  preparation?: VerificationCommandResult;
  /** Requested scripts missing from the repository manifest, never treated as passed. */
  missingScripts: string[];
  summary: string;
}

interface PackageManifest {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function readManifest(cwd: string): PackageManifest | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as PackageManifest;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function packageManagerFor(cwd: string, manifest: PackageManifest): string {
  const declared = typeof manifest.packageManager === 'string'
    ? manifest.packageManager.split('@')[0]
    : '';

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

function packageManagerBinary(manager: string): string {
  return process.platform === 'win32' ? `${manager}.cmd` : manager;
}

function dependencyInstallCommand(cwd: string, manifest: PackageManifest): VerificationCommand | undefined {
  const hasDependencies = [manifest.dependencies, manifest.devDependencies].some(value =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length)
  );
  if (!hasDependencies) return undefined;

  const manager = packageManagerFor(cwd, manifest);
  const hasLock = manager === 'npm'
    ? fs.existsSync(path.join(cwd, 'package-lock.json')) || fs.existsSync(path.join(cwd, 'npm-shrinkwrap.json'))
    : manager === 'pnpm'
      ? fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))
      : manager === 'yarn'
        ? fs.existsSync(path.join(cwd, 'yarn.lock'))
        : fs.existsSync(path.join(cwd, 'bun.lock')) || fs.existsSync(path.join(cwd, 'bun.lockb'));

  const yarnVersion = typeof manifest.packageManager === 'string' && manifest.packageManager.startsWith('yarn@')
    ? Number.parseInt(manifest.packageManager.slice('yarn@'.length).split('.')[0], 10)
    : 1;
  const args = manager === 'npm'
    ? hasLock ? ['ci', '--no-audit', '--no-fund', '--prefer-offline'] : ['install', '--no-audit', '--no-fund', '--package-lock=false', '--prefer-offline']
    : manager === 'pnpm'
      ? ['install', ...(hasLock ? ['--frozen-lockfile'] : []), '--prefer-offline']
      : manager === 'yarn'
        ? ['install', ...(hasLock ? [yarnVersion >= 2 ? '--immutable' : '--frozen-lockfile'] : [])]
        : ['install', ...(hasLock ? ['--frozen-lockfile'] : [])];

  return {
    script: 'dependency-install',
    bin: packageManagerBinary(manager),
    args,
    display: `${manager} ${args.join(' ')}`
  };
}

function hasScript(scripts: Record<string, unknown>, name: string): boolean {
  return typeof scripts[name] === 'string' && scripts[name].trim().length > 0;
}

/**
 * Discover a small, deterministic set of repository-owned checks.
 *
 * A combined `verify`/`check`/`validate`/`ci` script is authoritative: it is
 * normally the project's own composition of tests, linting, and typechecks, so
 * running the individual scripts as well would duplicate work. Without one,
 * run the conventional checks that actually exist, in a stable order.
 */
export function discoverVerificationCommands(cwd: string, requestedScripts?: readonly string[]): VerificationCommand[] {
  const manifest = readManifest(cwd);
  const scripts = manifest?.scripts;
  if (!scripts) return [];

  const manager = packageManagerFor(cwd, manifest);
  const bin = packageManagerBinary(manager);
  const requested = [...new Set(requestedScripts ?? [])];
  const selected = requested.length ? undefined : COMBINED_CHECK_SCRIPTS.find(name => hasScript(scripts, name));
  const scriptsToRun = requested.length
    ? requested.filter(name => hasScript(scripts, name))
    : selected
      ? [selected]
      : INDIVIDUAL_CHECK_SCRIPTS.filter(name => hasScript(scripts, name));

  return scriptsToRun.map(script => ({
    script,
    bin,
    args: ['run', script],
    display: `${manager} run ${script}`
  }));
}

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  return `${next.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated by Alpha]`;
}

function runCommand(
  runId: string,
  cwd: string,
  command: VerificationCommand
): Promise<VerificationCommandResult> {
  return new Promise(resolve => {
    let output = '';
    let settled = false;

    const finish = (exitCode: number | null, signal: string | null, extra = '') => {
      if (settled) return;
      settled = true;
      output = appendOutput(output, extra);
      resolve({ command, exitCode, signal, output: output.trim() });
    };

    try {
      const child = processManager.spawnProcess({
        runId,
        bin: command.bin,
        args: command.args,
        cwd,
        onStdout: chunk => { output = appendOutput(output, chunk); },
        onStderr: chunk => { output = appendOutput(output, chunk); },
        onExit: (exitCode, signal, terminationReason) => {
          if (terminationReason === 'cancelled') {
            finish(null, signal, 'Verification process cancelled by the user.');
          } else {
            finish(exitCode, signal);
          }
        }
      });

      // A missing package-manager executable emits `error` before an exit
      // callback on some Node versions. Resolve it as a failed verification
      // instead of leaving the run in a permanent "running" state.
      child.once('error', error => finish(null, null, `Process error: ${error.message}`));
    } catch (error) {
      finish(null, null, `Could not start ${command.display}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function resultSummary(results: VerificationCommandResult[], status: VerificationStatus): string {
  if (status === 'skipped') return 'No configured verification commands were found in package.json.';
  if (status === 'cancelled') return 'Verification was cancelled before all configured commands completed.';

  const details = results.map(result => {
    const exit = result.exitCode === null ? `signal ${result.signal || 'unknown'}` : `exit ${result.exitCode}`;
    return `${result.command.display} (${exit})`;
  }).join('; ');

  return status === 'passed'
    ? `Verification passed: ${details}.`
    : `Verification failed: ${details}. See the verification output in Run details.`;
}

export async function runVerification(options: {
  runId: string;
  cwd: string;
  requiredScripts?: readonly string[];
  shouldContinue?: () => boolean;
}): Promise<VerificationResult> {
  const requestedScripts = [...new Set(options.requiredScripts ?? [])];
  const commands = discoverVerificationCommands(options.cwd, requestedScripts.length ? requestedScripts : undefined);
  const manifest = readManifest(options.cwd);
  const scripts = manifest?.scripts ?? {};
  const missingScripts = requestedScripts.filter(script => !hasScript(scripts, script));
  if (!commands.length) {
    const summary = missingScripts.length
      ? `Required checks unavailable: ${missingScripts.join(', ')}.`
      : resultSummary([], 'skipped');
    return { status: 'skipped', commands: [], missingScripts, summary };
  }

  let preparation: VerificationCommandResult | undefined;
  const install = manifest ? dependencyInstallCommand(options.cwd, manifest) : undefined;
  if (install) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'cancelled', commands: [], missingScripts, summary: resultSummary([], 'cancelled') };
    }
    preparation = await runCommand(`${options.runId}-dependencies`, options.cwd, install);
    // --prefer-offline trusts cached package listings, and a stale cache does not know a
    // version the agent's lockfile pins from fresh registry data ("ETARGET No matching
    // version"). Ask the registry again once before calling the dependencies broken.
    if (preparation.exitCode !== 0 && install.args.includes('--prefer-offline') && STALE_METADATA.test(preparation.output)) {
      const online = { ...install, args: install.args.map(arg => arg === '--prefer-offline' ? '--prefer-online' : arg) };
      online.display = `${install.display.split(' ')[0]} ${online.args.join(' ')}`;
      preparation = await runCommand(`${options.runId}-dependencies-online`, options.cwd, online);
    }
    if (preparation.exitCode !== 0) {
      const detail = preparation.output.split(/\r?\n/).slice(-8).join('\n').slice(-1_500);
      return {
        status: 'failed', commands: [], preparation, missingScripts,
        summary: `Alpha could not prepare this repository's dependencies with ${install.display}.${detail ? ` ${detail}` : ''}`
      };
    }
  }

  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'cancelled', commands: results, preparation, missingScripts, summary: resultSummary(results, 'cancelled') };
    }

    const result = await runCommand(options.runId, options.cwd, command);
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'cancelled', commands: results, preparation, missingScripts, summary: resultSummary(results, 'cancelled') };
    }
    results.push(result);
    if (result.exitCode !== 0) {
      return { status: 'failed', commands: results, preparation, missingScripts, summary: resultSummary(results, 'failed') };
    }
  }

  const summary = resultSummary(results, 'passed');
  return {
    status: 'passed',
    commands: results,
    preparation,
    missingScripts,
    summary: missingScripts.length ? `${summary} Required checks unavailable: ${missingScripts.join(', ')}.` : summary
  };
}

export const verificationOutputLimit = MAX_OUTPUT_CHARS;
