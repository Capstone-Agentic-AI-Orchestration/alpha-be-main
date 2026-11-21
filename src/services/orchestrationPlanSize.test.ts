import { describe, expect, it } from 'vitest';
import { splitOversizedTasks } from './orchestrationPlanSize.js';
import { describePlanDecisions } from './chatService.js';
import { orchestrationPlanDocument } from './orchestrationPlanDocument.js';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `REQ-${index + 1}`);

describe('plans larger than one task can hold', () => {
  it('splits a task covering more than 12 requirements into consecutive parts instead of refusing the plan', () => {
    const { candidate, decisions } = splitOversizedTasks({ tasks: [
      { id: 'build', title: 'Build the app', requirementIds: ids(4), dependsOn: [] },
      { id: 'review', title: 'Review all work', buildStepId: 'step-review', requirementIds: ids(15), dependsOn: ['build'] },
      { id: 'validate', title: 'Validate', requirementIds: ids(2), dependsOn: ['review'] }
    ] }) as { candidate: { tasks: Array<{ id: string; title: string; requirementIds: string[]; dependsOn: string[]; buildStepId?: string }> }; decisions: unknown[] };
    const [build, first, second, validate] = candidate.tasks;
    expect(build.id).toBe('build');
    expect(first).toMatchObject({ id: 'review', buildStepId: 'step-review', dependsOn: ['build'] });
    expect(first.requirementIds).toHaveLength(12);
    expect(second).toMatchObject({ id: 'review-part-2', title: 'Review all work (part 2)', requirementIds: ['REQ-13', 'REQ-14', 'REQ-15'], dependsOn: ['build', 'review'] });
    expect(second.buildStepId).toBeUndefined();
    expect(validate.dependsOn).toEqual(['review', 'review-part-2']);
    expect(decisions).toHaveLength(1);
  });

  it('leaves a plan within the limit untouched', () => {
    const plan = { tasks: [{ id: 'a', requirementIds: ids(12), dependsOn: [] }] };
    expect(splitOversizedTasks(plan)).toEqual({ candidate: plan, decisions: [] });
  });
});

describe('decisions the Orchestrator made instead of stopping', () => {
  const decisions = [{ about: 'project-a-be', decision: 'No changes: the tasks keep expenses in browser storage.', toChange: 'Ask for backend storage to add API tasks.' }];

  it('are listed in the plan-ready reply with how to change them', () => {
    const text = describePlanDecisions(decisions)!;
    expect(text).toContain('**What the Orchestrator decided**');
    expect(text).toContain('- **project-a-be:** No changes: the tasks keep expenses in browser storage. _Ask for backend storage to add API tasks._');
    expect(describePlanDecisions([])).toBeUndefined();
  });

  it('are written into the saved plan document', () => {
    const doc = orchestrationPlanDocument({ schemaVersion: 1, goal: 'Build expenses', exclusions: [], decisions,
      requirements: [{ id: 'REQ-1', description: 'Add expenses' }],
      tasks: [{ id: 't', title: 'Add form', description: 'Form', kind: 'frontend', ownerAgentId: 'fe', dependsOn: [], requirementIds: ['REQ-1'],
        acceptanceCriteria: ['Works'], requiredChecks: [], scope: { includePaths: [], excludePaths: [] }, required: true }] } as any, 1);
    expect(doc.content).toContain('## What the Orchestrator decided');
    expect(doc.content).toContain('project\\-a\\-be');
  });
});
