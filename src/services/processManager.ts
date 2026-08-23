import { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import treeKill from 'tree-kill';
import { sqliteService } from './sqliteService.js';
import { logAudit, logInfo, logError } from '../utils/logger.js';
import { EXECUTION_LIMITS } from '../config/constants.js';

export interface SpawnOptions {
  runId: string;
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onExit?: (code: number | null, signal: string | null) => void;
}

export class ProcessManager {
  private activeProcesses = new Map<string, { child: ChildProcess; timer?: NodeJS.Timeout; idleTimer?: NodeJS.Timeout }>();

  /**
   * Spawns a process in a registered allowlisted directory with tree-kill tracking and timeouts.
   */
  spawnProcess(options: SpawnOptions): ChildProcess {
    const { runId, bin, args, cwd, env, onStdout, onStderr, onExit } = options;

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
    const child = crossSpawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const resetIdleTimer = () => {
      const entry = this.activeProcesses.get(runId);
      if (entry?.idleTimer) clearTimeout(entry.idleTimer);
      if (entry) {
        entry.idleTimer = setTimeout(() => {
          logError(`Run ${runId} timed out due to idle output (no output for ${EXECUTION_LIMITS.IDLE_TIMEOUT_MS / 1000}s)`);
          logAudit('PROCESS_IDLE_TIMEOUT', { runId, bin });
          this.killProcess(runId, 'SIGTERM');
        }, EXECUTION_LIMITS.IDLE_TIMEOUT_MS);
      }
    };

    // 2. Set hard wall-clock timeout
    const timer = setTimeout(() => {
      logError(`Run ${runId} exceeded wall-clock timeout (${EXECUTION_LIMITS.WALL_CLOCK_TIMEOUT_MS / 1000}s)`);
      logAudit('PROCESS_WALL_CLOCK_TIMEOUT', { runId, bin });
      this.killProcess(runId, 'SIGTERM');
    }, EXECUTION_LIMITS.WALL_CLOCK_TIMEOUT_MS);

    this.activeProcesses.set(runId, { child, timer });
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

    child.on('exit', (code, signal) => {
      const entry = this.activeProcesses.get(runId);
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry?.idleTimer) clearTimeout(entry.idleTimer);
      this.activeProcesses.delete(runId);

      logInfo(`Process for run ${runId} exited with code ${code}, signal ${signal}`);
      logAudit('PROCESS_EXIT', { runId, code, signal });

      if (onExit) onExit(code, signal);
    });

    child.on('error', (err) => {
      logError(`Process error in run ${runId}:`, err);
      logAudit('PROCESS_ERROR', { runId, error: err.message });
    });

    return child;
  }

  /**
   * Terminate entire child process tree cleanly
   */
  async killProcess(runId: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    const entry = this.activeProcesses.get(runId);
    if (!entry || !entry.child || !entry.child.pid) {
      this.activeProcesses.delete(runId);
      return;
    }

    const pid = entry.child.pid;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    logInfo(`Killing process tree for run ${runId} (PID: ${pid}) with ${signal}`);
    logAudit('PROCESS_KILL', { runId, pid, signal });

    return new Promise((resolve) => {
      treeKill(pid, signal, (err) => {
        if (err) {
          logError(`Failed to kill process tree (PID: ${pid}):`, err);
        }
        this.activeProcesses.delete(runId);
        resolve();
      });
    });
  }

  isRunActive(runId: string): boolean {
    return this.activeProcesses.has(runId);
  }
}

export const processManager = new ProcessManager();
