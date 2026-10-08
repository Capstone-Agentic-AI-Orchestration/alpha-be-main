import type { ProcessTerminationReason } from './processManager.js';

export type ProcessExitDecision =
  | { kind: 'success' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * Convert Node's child-process exit tuple into the runner's terminal decision.
 *
 * A process killed by SIGTERM commonly reports `{ code: null, signal:
 * 'SIGTERM' }`. `null` is therefore not a successful exit code; it is only
 * meaningful together with the signal/reason that caused it.
 */
export function classifyProcessExit(
  code: number | null,
  signal: string | null,
  terminationReason?: ProcessTerminationReason
): ProcessExitDecision {
  if (terminationReason === 'cancelled') return { kind: 'cancelled' };
  if (terminationReason === 'timeout') {
    return { kind: 'failed', message: `Process timed out${signal ? ` after ${signal}` : ''}.` };
  }
  if (terminationReason === 'provider_error') {
    return { kind: 'failed', message: 'The provider reported an error.' };
  }
  if (terminationReason === 'spawn_error') {
    return { kind: 'failed', message: 'The agent process could not be started. Check its runtime installation and configuration.' };
  }
  if (signal) return { kind: 'failed', message: `Process terminated by signal ${signal}.` };
  if (code === 0) return { kind: 'success' };
  return { kind: 'failed', message: `Process exited with error code: ${code}` };
}
