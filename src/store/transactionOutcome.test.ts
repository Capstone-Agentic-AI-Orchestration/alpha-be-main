import { describe, expect, it } from 'vitest';

import { DatabaseCommitError } from './database.js';
import { isTransactionOutcomeUnknown } from './transactionOutcome.js';

describe('isTransactionOutcomeUnknown', () => {
  it('recognizes the existing database adapter uncertain-commit error', () => {
    expect(isTransactionOutcomeUnknown(new DatabaseCommitError(new Error('commit acknowledgement lost')))).toBe(true);
  });

  it('does not treat ordinary failures as ambiguous commits', () => {
    expect(isTransactionOutcomeUnknown(new Error('connection refused'))).toBe(false);
    expect(isTransactionOutcomeUnknown({ outcome: 'unknown' })).toBe(false);
  });
});
