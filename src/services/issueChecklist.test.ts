import { describe, expect, it } from 'vitest';
import type { IssueSubtask } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { checklistRequirementId, manualChecklistRequirements } from './issueChecklist.js';
import { tickSpecChecklist } from './orchestrationFinalization.js';

const item: IssueSubtask = { id: 'pm-check-1', title: 'Invalid email shows a field error.', completed: false };

function validatedSnapshot(items = [item]): OrchestrationSnapshot {
  const requirements = manualChecklistRequirements(items);
  return {
    run: { plan: { requirements } },
    tasks: ['backend', 'validation'].map(kind => ({
      id: kind, kind, required: true, status: 'accepted', requirementIds: requirements.map(entry => entry.id)
    })),
    attempts: ['backend', 'validation'].map(taskId => ({
      id: taskId, taskId, attemptNumber: 1, status: 'accepted',
      result: { agentReport: { requirementCoverage: requirements.map(entry => ({ requirementId: entry.id, evidence: 'tests/email.test.ts proves the field error.' })) } }
    }))
  } as unknown as OrchestrationSnapshot;
}

describe('manual acceptance checklist', () => {
  it('uses stable identity and full wording, omitting completed and spec items', () => {
    expect(manualChecklistRequirements([item, { ...item, id: 'done', completed: true }, { ...item, id: 'spec', source: 'spec', requirementId: 'REQ-1' }]))
      .toEqual([{ id: checklistRequirementId(item), description: item.title }]);
    expect(checklistRequirementId({ ...item })).toBe(checklistRequirementId(item));
    expect(checklistRequirementId({ ...item, title: 'A different criterion.' })).not.toBe(checklistRequirementId(item));
    expect(checklistRequirementId({ ...item, id: 'another' })).not.toBe(checklistRequirementId(item));
  });

  it('ticks validated manual work while preserving user wording and unrelated items', () => {
    const unrelated = { ...item, id: 'another', title: 'The PM approves the wording.' };
    const completed = { ...item, id: 'already-done', completed: true };
    const result = tickSpecChecklist([item, unrelated, completed], validatedSnapshot());
    expect(result).toEqual([{ ...item, completed: true }, unrelated, completed]);
    expect(item.completed).toBe(false);
    expect(tickSpecChecklist(result, validatedSnapshot())).toEqual(result);
  });

  it('does not apply an old build to a renamed or replaced checklist item', () => {
    const renamed = { ...item, title: 'Invalid email blocks submission and sends no request.' };
    const replaced = { ...item, id: 'new-item' };
    expect(tickSpecChecklist([renamed, replaced], validatedSnapshot())).toEqual([renamed, replaced]);
  });

  it.each(['missing_validation', 'failed_validation', 'missing_evidence', 'partial_implementation', 'newer_failed_attempt'])(
    'leaves the item open for %s', scenario => {
      const snapshot = validatedSnapshot();
      if (scenario === 'missing_validation') snapshot.tasks.pop();
      if (scenario === 'failed_validation') snapshot.tasks[1].status = 'failed';
      if (scenario === 'partial_implementation') snapshot.tasks.push({ ...snapshot.tasks[0], id: 'frontend', status: 'pending' });
      if (scenario === 'missing_evidence') snapshot.attempts[1].result = { agentReport: { requirementCoverage: [] } };
      if (scenario === 'newer_failed_attempt') snapshot.attempts.push({ ...snapshot.attempts[1], id: 'retry', attemptNumber: 2, status: 'failed' });
      expect(tickSpecChecklist([item], snapshot)[0].completed).toBe(false);
    }
  );

  it('ignores superseded tasks while requiring their current replacement', () => {
    const snapshot = validatedSnapshot();
    snapshot.tasks.push({ ...snapshot.tasks[0], id: 'old', status: 'superseded' });
    expect(tickSpecChecklist([item], snapshot)[0].completed).toBe(true);
    snapshot.tasks.push({ ...snapshot.tasks[0], id: 'correction', status: 'running' });
    expect(tickSpecChecklist([item], snapshot)[0].completed).toBe(false);
  });
});
