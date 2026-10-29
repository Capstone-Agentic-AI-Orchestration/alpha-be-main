import { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import treeKill from 'tree-kill';
import { sqliteService } from './sqliteService.js';
import { logAudit, logInfo, logError } from '../utils/logger.js';
import { EXECUTION_LIMITS } from '../config/constants.js';

export type ProcessTerminationReason = 'cancelled' | 'timeout' | 'provider_error' | 'spawn_error';

export interface SpawnOptions {
  runId: string;
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** A bounded operation may shorten, but never extend, the global deadline. */
  timeoutMs?: number;
  /**
   * Text to write to the child's stdin, then close it.
   *
   * This is how a multi-line prompt reaches a CLI on Windows. `claude` and
   * `codex` are installed as `.cmd` shims, which cross-spawn necessarily runs
   * through cmd.exe — and cmd.exe ends its command line at the first newline,
   * so a multi-line argv value is truncated there and every argument after it
   * is discarded. Measured: an inline multi-line `--append-system-prompt`
   * silently took `--output-format`, `--setting-sources` and `--model` down
   * with it. See buildTurnInvocation.
   */
  stdin?: string;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onExit?: (code: number | null, signal: string | null, terminationReason?: ProcessTerminationReason) => void;
}

export class ProcessManager {
  private activeProcesses = new Map<string, {
    child: ChildProcess;
    timer?: NodeJS.Timeout;
    idleTimer?: NodeJS.Timeout;
    terminationReason?: ProcessTerminationReason;
    exitedConfirmed: boolean;
    exited: Promise<void>;
    resolveExited: () => void;
    terminationPromise?: Promise<void>;
  }>();
  /** Keep termination reason until the child emits its exit event. */
  private terminationReasons = new Map<string, ProcessTerminationReason>();

  /**
   * Spawns a process in a registered allowlisted directory with tree-kill tracking and timeouts.
   */
  spawnProcess(options: SpawnOptions): ChildProcess {
    const { runId, bin, args, cwd, env, stdin, onStdout, onStderr, onExit } = options;
    const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, EXECUTION_LIMITS.WALL_CLOCK_TIMEOUT_MS)
      : EXECUTION_LIMITS.WALL_CLOCK_TIMEOUT_MS;

    // 1. Verify working directory allowlist
    if (!sqliteService.isPathAllowed(cwd)) {
      const err = new Error(`Security Violation: Working directory "${cwd}" is not on the allowed paths list.`);
      logError(err.message, { runId, cwd });
      logAudit('SPAWN_SECURITY_VIOLATION', { runId, bin, args, cwd });
      throw err;
    }

    logInfo(`Spawning process for run: ${runId}`, { bin, args, cwd });
    logAudit('PROCESS_SPAWN', { runId, bin, args, cwd });

    /**
     * `cross-spawn`, never `shell: true`.
     *
     * Windows needs a shell to run npm's `.cmd` wrappers (`claude.cmd`,
     * `codex.cmd`) — Node refuses to spawn `.cmd` directly since the CVE-2024-27980
     * fix. But `shell: true` hands the whole command line to cmd.exe as a
     * STRING, and cmd.exe then word-splits on spaces. A prompt like
     *
     *     -p "Reply with exactly: PONG. Nothing else."
     *
     * arrived at the CLI as just `-p Reply`, and the agent answered a question
     * nobody asked. It is also an injection vector: prompt text reaches us from
     * an HTTP body, and `& del ...` inside it would be interpreted by the shell.
     *
     * cross-spawn resolves the `.cmd` wrapper itself and passes argv as a real
     * array, so arguments survive verbatim and nothing is interpreted.
     */
    /**
     * A batch shim must never be handed a multi-line argument.
     *
     * `claude` and `codex` install as `.cmd` wrappers, so cross-spawn runs them
     * through cmd.exe, whose command line ends at the first newline —
     * everything after it, including later flags, is silently discarded. That
     * cost `--output-format stream-json`, `--setting-sources ''` and `--model`
     * on every Claude turn whose persona or prompt spanned lines, which is all
     * of them.
     *
     * Scoped to shims deliberately. `agy` is a real executable, takes its argv
     * directly, and its multi-line prompt is verified to arrive intact — so
     * refusing it here would break a path that works.
     */
    const isShim = /\.(cmd|bat)$/i.test(bin);
    const multiline = isShim ? args.findIndex(a => /[\r\n]/.test(a)) : -1;
    if (multiline !== -1) {
      const err = new Error(
        `Argument ${multiline} for "${bin}" contains a newline. Pass long text on stdin or in a file instead — cmd.exe truncates the command line there and drops every later flag.`
      );
      logError(err.message, { runId, bin });
      throw err;
    }

    const child = crossSpawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });

    if (stdin !== undefined && child.stdin) {
      // The CLIs read the prompt until EOF, so the close is what starts the turn.
      child.stdin.on('error', err => logError(`stdin write failed for ${runId}`, err));
      child.stdin.end(stdin);
    }

    const resetIdleTimer = () => {
      const entry = this.activeProcesses.get(runId);
      if (entry?.idleTimer) clearTimeout(entry.idleTimer);
      if (entry) {
        entry.idleTimer = setTimeout(() => {
          logError(`Run ${runId} timed out due to idle output (no output for ${EXECUTION_LIMITS.IDLE_TIMEOUT_MS / 1000}s)`);
          logAudit('PROCESS_IDLE_TIMEOUT', { runId, bin });
          void this.terminateProcessAndWait(runId, 'timeout').catch(error =>
            logError(`Could not confirm timeout termination for run ${runId}:`, error)
          );
        }, EXECUTION_LIMITS.IDLE_TIMEOUT_MS);
      }
    };

    // 2. Set hard wall-clock timeout
    const timer = setTimeout(() => {
      logError(`Run ${runId} exceeded wall-clock timeout (${timeoutMs / 1000}s)`);
      logAudit('PROCESS_WALL_CLOCK_TIMEOUT', { runId, bin });
      void this.terminateProcessAndWait(runId, 'timeout').catch(error =>
        logError(`Could not confirm timeout termination for run ${runId}:`, error)
      );
    }, timeoutMs);

    this.terminationReasons.delete(runId);
    let resolveExited!: () => void;
    const exited = new Promise<void>(resolve => { resolveExited = resolve; });
    const entry: {
      child: ChildProcess;
      timer?: NodeJS.Timeout;
      idleTimer?: NodeJS.Timeout;
      terminationReason?: ProcessTerminationReason;
      exitedConfirmed: boolean;
      exited: Promise<void>;
      resolveExited: () => void;
      terminationPromise?: Promise<void>;
    } = { child, timer, exitedConfirmed: false, exited, resolveExited };
    this.activeProcesses.set(runId, entry);
    resetIdleTimer();

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        resetIdleTimer();
        if (onStdout) onStdout(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        resetIdleTimer();
        if (onStderr) onStderr(chunk);
      });
    }

    let settled = false;
    const finish = (code: number | null, signal: string | null, failureReason?: ProcessTerminationReason) => {
      if (settled) return;
      settled = true;
      entry.exitedConfirmed = true;
      entry.resolveExited();
      const activeEntry = this.activeProcesses.get(runId);
      if (activeEntry?.timer) clearTimeout(activeEntry.timer);
      if (activeEntry?.idleTimer) clearTimeout(activeEntry.idleTimer);
      this.activeProcesses.delete(runId);
      const terminationReason = failureReason ?? this.terminationReasons.get(runId);
      this.terminationReasons.delete(runId);

      logInfo(`Process for run ${runId} exited with code ${code}, signal ${signal}`);
      logAudit('PROCESS_EXIT', { runId, code, signal });

      if (onExit) onExit(code, signal, terminationReason);
    };
    child.on('exit', (code, signal) => finish(code, signal));

    child.on('error', (err) => {
      logError(`Process error in run ${runId}:`, err);
      logAudit('PROCESS_ERROR', { runId, error: err.message });
      // Failed spawn (e.g. missing CLI) has no PID and may never emit exit.
      // Clear timers and notify completion exactly once. Errors on a live PID
      // are NOT proof of termination; keep its queue/ownership until exit.
      if (!child.pid) finish(null, null, 'spawn_error');
    });

    return child;
  }

  /**
   * Terminate entire child process tree cleanly
   */
  async killProcess(
    runId: string,
    signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
    terminationReason: ProcessTerminationReason = 'cancelled'
  ): Promise<void> {
    const entry = this.activeProcesses.get(runId);
    if (!entry || !entry.child || !entry.child.pid) {
      this.activeProcesses.delete(runId);
      return;
    }

    const pid = entry.child.pid;
    entry.terminationReason = terminationReason;
    this.terminationReasons.set(runId, terminationReason);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    logInfo(`Killing process tree for run ${runId} (PID: ${pid}) with ${signal}`);
    logAudit('PROCESS_KILL', { runId, pid, signal });

    return new Promise((resolve) => {
      treeKill(pid, signal, (err) => {
        if (err) {
          logError(`Failed to kill process tree (PID: ${pid}):`, err);
        }
        resolve();
      });
    });
  }

  /**
   * Stop a child and wait for its exit event before releasing orchestration
   * ownership. A successful tree-kill callback only confirms that the signal
   * request was sent; it does not confirm that the child has stopped running.
   */
  async terminateProcessAndWait(
    runId: string,
    terminationReason: ProcessTerminationReason = 'cancelled',
    gracefulTimeoutMs = 8_000,
    forceTimeoutMs = 5_000
  ): Promise<void> {
    const entry = this.activeProcesses.get(runId);
    if (!entry || !entry.child?.pid) return;
    if (entry.terminationPromise) return entry.terminationPromise;

    const operation = (async () => {
      entry.terminationReason = terminationReason;
      this.terminationReasons.set(runId, terminationReason);
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);

      const signal = (name: 'SIGTERM' | 'SIGKILL') => new Promise<void>(resolve => {
        if (entry.exitedConfirmed) return resolve();
        const pid = entry.child.pid!;
        logInfo(`Killing process tree for run ${runId} (PID: ${pid}) with ${name}`);
        logAudit('PROCESS_KILL', { runId, pid, signal: name });
        treeKill(pid, name, error => {
          if (error) logError(`Failed to kill process tree (PID: ${pid}):`, error);
          resolve();
        });
      });
      const waitForExit = async (timeoutMs: number): Promise<boolean> => {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        });
        const exited = entry.exited.then(() => true);
        const result = await Promise.race([exited, timedOut]);
        if (timer) clearTimeout(timer);
        return result;
      };

      await signal('SIGTERM');
      if (await waitForExit(gracefulTimeoutMs) || entry.exitedConfirmed) return;

      await signal('SIGKILL');
      if (await waitForExit(forceTimeoutMs) || entry.exitedConfirmed) return;

      throw new Error(`Could not confirm that the specialist process for ${runId} stopped. The process remains tracked; retry stop after checking its state.`);
    })();
    entry.terminationPromise = operation;
    try {
      await operation;
    } finally {
      if (entry.terminationPromise === operation) entry.terminationPromise = undefined;
    }
  }

  isRunActive(runId: string): boolean {
    return this.activeProcesses.has(runId);
  }
}

export const processManager = new ProcessManager();
