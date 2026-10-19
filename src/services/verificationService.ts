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
  /** Requested scripts missing from the repository manifest, never treated as passed. */
  missingScripts: string[];
  summary: string;
}

interface PackageManifest {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
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
  const scripts = readManifest(options.cwd)?.scripts ?? {};
  const missingScripts = requestedScripts.filter(script => !hasScript(scripts, script));
  if (!commands.length) {
    const summary = missingScripts.length
      ? `Required checks unavailable: ${missingScripts.join(', ')}.`
      : resultSummary([], 'skipped');
    return { status: 'skipped', commands: [], missingScripts, summary };
  }

  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'cancelled', commands: results, missingScripts, summary: resultSummary(results, 'cancelled') };
    }

    const result = await runCommand(options.runId, options.cwd, command);
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: 'cancelled', commands: results, missingScripts, summary: resultSummary(results, 'cancelled') };
    }
    results.push(result);
    if (result.exitCode !== 0) {
      return { status: 'failed', commands: results, missingScripts, summary: resultSummary(results, 'failed') };
    }
  }

  const summary = resultSummary(results, 'passed');
  return {
    status: 'passed',
    commands: results,
    missingScripts,
    summary: missingScripts.length ? `${summary} Required checks unavailable: ${missingScripts.join(', ')}.` : summary
  };
}

export const verificationOutputLimit = MAX_OUTPUT_CHARS;
