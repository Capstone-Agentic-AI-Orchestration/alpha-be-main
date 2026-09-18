import { describe, expect, it } from 'vitest';
import { classifyProcessExit } from './runLifecycle.js';

describe('classifyProcessExit', () => {
  it('only treats an un-signalled zero exit as success', () => {
    expect(classifyProcessExit(0, null)).toEqual({ kind: 'success' });
    expect(classifyProcessExit(null, 'SIGTERM')).toEqual({
      kind: 'failed',
      message: 'Process terminated by signal SIGTERM.'
    });
    expect(classifyProcessExit(null, null)).toEqual({
      kind: 'failed',
      message: 'Process exited with error code: null'
    });
  });

  it('preserves explicit cancellation and timeout reasons', () => {
    expect(classifyProcessExit(null, 'SIGTERM', 'cancelled')).toEqual({ kind: 'cancelled' });
    expect(classifyProcessExit(null, 'SIGTERM', 'timeout')).toEqual({
      kind: 'failed',
      message: 'Process timed out after SIGTERM.'
    });
  });
});
