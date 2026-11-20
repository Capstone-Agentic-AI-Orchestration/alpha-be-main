import { describe, expect, it } from 'vitest';
import type { OrchestrationPlan } from './orchestrationContract.js';
import { correctPlanSafely } from './orchestrationPlanCorrections.js';

const agents = [
  { id: 'manager', role: 'Manager Agent' },
  { id: 'frontend', role: 'Frontend Agent' },
  { id: 'reviewer', role: 'Security / Code Quality Agent' }
];

function task(overrides: Record<string, unknown>) {
  return {
    title: 'Task', description: 'Do the task.', dependsOn: [], acceptanceCriteria: ['Done.'], requiredChecks: [],
    scope: { includePaths: ['src/**'], excludePaths: [] }, required: true, ...overrides
  };
}

/** The reported plan: a phased roadmap whose Manager brief covered the whole board, not just milestone one. */
function phasedPlan(): OrchestrationPlan {
  return {
    schemaVersion: 2,
    goal: 'Complete the remaining expense tasks in phases.',
    exclusions: [],
    requirements: [
      { id: 'R-STORE', description: 'Expenses persist in localStorage.' },
      { id: 'R-EDIT', description: 'People add, edit and delete expenses.' },
      { id: 'R-SUMMARY', description: 'Spending and category summaries.' }
    ],
    milestones: [
      { id: 'M1', title: 'Foundation', objective: 'Storage and model.', requirementIds: ['R-STORE'], repositories: ['acme/web'] },
      { id: 'M2', title: 'Workflow', objective: 'Editing and summaries.', requirementIds: ['R-EDIT', 'R-SUMMARY'], repositories: ['acme/web'] }
    ],
    tasks: [
      task({ id: 't1-board-brief', kind: 'requirements', ownerAgentId: 'manager', milestoneId: 'M1', repository: 'acme/api',
        requirementIds: ['R-STORE', 'R-EDIT', 'R-SUMMARY'], scope: undefined }),
      task({ id: 't1-storage', kind: 'frontend', ownerAgentId: 'frontend', milestoneId: 'M1', repository: 'acme/web', requirementIds: ['R-STORE'] }),
      task({ id: 't1-review', kind: 'review', ownerAgentId: 'reviewer', milestoneId: 'M1', repository: 'acme/web', requirementIds: ['R-STORE'], dependsOn: ['t1-storage'] })
    ]
  } as unknown as OrchestrationPlan;
}

describe('safe plan corrections', () => {
  it('narrows a board-wide Manager brief to its milestone, and makes the milestone code wait for it', () => {
    const { plan, corrections } = correctPlanSafely(phasedPlan(), agents);
    const brief = plan.tasks.find(item => item.id === 't1-board-brief')!;
    expect(brief.requirementIds).toEqual(['R-STORE']);
    expect(brief.repository).toBe('acme/web');
    expect(plan.tasks.find(item => item.id === 't1-storage')!.dependsOn).toEqual(['t1-board-brief']);
    expect(corrections).toHaveLength(3);
  });

  it('never changes what a code task may touch', () => {
    const original = phasedPlan();
    const outOfBounds = { ...original, tasks: original.tasks.map(item => item.id === 't1-storage'
      ? { ...item, requirementIds: ['R-STORE', 'R-EDIT'], repository: 'acme/api' } : item) } as OrchestrationPlan;
    const code = correctPlanSafely(outOfBounds, agents).plan.tasks.find(item => item.id === 't1-storage')!;
    // Still out of bounds, so the plan check refuses it; widening or moving code work is the planner's job.
    expect(code.requirementIds).toEqual(['R-STORE', 'R-EDIT']);
    expect(code.repository).toBe('acme/api');
  });

  it('does not add a dependency that would close a cycle', () => {
    const original = phasedPlan();
    const cyclic = { ...original, tasks: original.tasks.map(item => item.id === 't1-board-brief'
      ? { ...item, dependsOn: ['t1-storage'] } : item) } as OrchestrationPlan;
    expect(correctPlanSafely(cyclic, agents).plan.tasks.find(item => item.id === 't1-storage')!.dependsOn).toEqual([]);
  });

  it('adds no review: missing work stays for the planner and the check', () => {
    const original = phasedPlan();
    const unreviewed = { ...original, tasks: original.tasks.filter(item => item.id !== 't1-review') } as OrchestrationPlan;
    expect(correctPlanSafely(unreviewed, agents).plan.tasks.map(item => item.id)).toEqual(['t1-board-brief', 't1-storage']);
  });

  it('leaves a plan with nothing to correct exactly as it was', () => {
    const corrected = correctPlanSafely(phasedPlan(), agents).plan;
    const again = correctPlanSafely(corrected, agents);
    expect(again.corrections).toEqual([]);
    expect(again.plan).toBe(corrected);
  });
});
