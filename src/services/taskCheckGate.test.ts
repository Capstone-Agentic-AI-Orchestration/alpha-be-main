import { describe, expect, it } from 'vitest';
import { TaskCheckGate } from './taskCheckGate.js';

describe('checks before handing in', () => {
  it('waits until every assigned check ran on the latest changes', () => {
    const gate = new TaskCheckGate(['test', 'typecheck', 'lint']);
    expect(gate.refusal()).toBeUndefined(); // nothing changed yet
    gate.recordChange();
    expect(gate.missing()).toEqual(['test', 'typecheck', 'lint']);
    gate.recordRun(['test', 'typecheck']);
    expect(gate.refusal()).toContain('["lint"]');
    gate.recordRun(['lint']);
    expect(gate.refusal()).toBeUndefined();
  });

  it('asks again after a later edit, so the checks cover the final code', () => {
    const gate = new TaskCheckGate(['typecheck']);
    gate.recordChange();
    gate.recordRun(['typecheck']);
    gate.recordChange();
    expect(gate.missing()).toEqual(['typecheck']);
  });
});
