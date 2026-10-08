/**
 * Provider-neutral signal for a transaction whose commit result is unknown.
 * Application services use this contract to request operation reconciliation
 * without importing a concrete database driver or its runtime configuration.
 */
export interface TransactionOutcomeUnknown extends Error {
  readonly outcome: 'unknown';
}

export function isTransactionOutcomeUnknown(error: unknown): error is TransactionOutcomeUnknown {
  return error instanceof Error
    && (error as Error & { outcome?: unknown }).outcome === 'unknown';
}
