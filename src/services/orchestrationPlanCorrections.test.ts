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

  /** The refused Project A plan: milestone 2's frontend tasks were detailed in the first plan. */
  it('keeps only the first milestone\'s tasks, and leaves the roadmap alone', () => {
    const original = phasedPlan();
    const early = { ...original, tasks: [...original.tasks,
      task({ id: 't2-edit', kind: 'frontend', ownerAgentId: 'frontend', milestoneId: 'M2', repository: 'acme/web', requirementIds: ['R-EDIT'], dependsOn: ['t1-review'] })] } as OrchestrationPlan;
    const { plan, corrections } = correctPlanSafely(early, agents);
    expect(plan.tasks.map(item => item.id)).toEqual(['t1-board-brief', 't1-storage', 't1-review']);
    expect(plan.milestones?.map(item => item.id)).toEqual(['M1', 'M2']);
    expect(corrections.some(item => item.includes('later task'))).toBe(true);
  });

  it('does not trim when a first-milestone task depends on a later one', () => {
    const original = phasedPlan();
    const tangled = { ...original, tasks: [...original.tasks.map(item => item.id === 't1-review' ? { ...item, dependsOn: ['t1-storage', 't2-edit'] } : item),
      task({ id: 't2-edit', kind: 'frontend', ownerAgentId: 'frontend', milestoneId: 'M2', repository: 'acme/web', requirementIds: ['R-EDIT'] })] } as OrchestrationPlan;
    expect(correctPlanSafely(tangled, agents).plan.tasks.map(item => item.id)).toContain('t2-edit');
  });

  it('leaves a plan with nothing to correct exactly as it was', () => {
    const corrected = correctPlanSafely(phasedPlan(), agents).plan;
    const again = correctPlanSafely(corrected, agents);
    expect(again.corrections).toEqual([]);
    expect(again.plan).toBe(corrected);
  });

  it('gives every code task all the checks its repository runs, and leaves other repositories and report tasks alone', () => {
    // Lint covers the whole repository: a first task accepted without it leaves errors no later task may fix.
    const plan = {
      schemaVersion: 1, goal: 'Accounts and sign-in.', exclusions: [],
      requirements: [{ id: 'R-AUTH', description: 'Sign in.' }],
      tasks: [
        task({ id: 'data', kind: 'database', ownerAgentId: 'frontend', repository: 'acme/api', requirementIds: ['R-AUTH'], requiredChecks: ['test', 'typecheck'] }),
        task({ id: 'auth', kind: 'backend', ownerAgentId: 'frontend', repository: 'https://github.com/Acme/API.git', requirementIds: ['R-AUTH'], requiredChecks: ['test', 'typecheck', 'lint'], dependsOn: ['data'] }),
        task({ id: 'pages', kind: 'frontend', ownerAgentId: 'frontend', repository: 'acme/web', requirementIds: ['R-AUTH'], requiredChecks: ['test'] }),
        task({ id: 'review', kind: 'review', ownerAgentId: 'reviewer', repository: 'acme/api', requirementIds: ['R-AUTH'], dependsOn: ['auth'] })
      ]
    } as unknown as OrchestrationPlan;
    const { plan: corrected, corrections } = correctPlanSafely(plan, agents);
    const checks = (id: string) => corrected.tasks.find(item => item.id === id)!.requiredChecks;
    expect(checks('data')).toEqual(['test', 'typecheck', 'lint']);
    expect(checks('auth')).toEqual(['test', 'typecheck', 'lint']);
    expect(checks('pages')).toEqual(['test']);
    expect(checks('review')).toEqual([]);
    expect(corrections).toEqual(['Gave data every check its repository runs: test, typecheck, lint.']);
    expect(correctPlanSafely(corrected, agents).corrections).toEqual([]);

    // With the repositories' scripts known, each code task also gets the CI checks its repository defines.
    const scripts = (repository: string | undefined) => repository === 'acme/web' ? ['test', 'lint', 'build'] : ['test', 'typecheck', 'lint'];
    const withCi = correctPlanSafely(plan, agents, scripts).plan;
    expect(withCi.tasks.find(item => item.id === 'pages')!.requiredChecks).toEqual(['test', 'lint', 'build']);
    expect(withCi.tasks.find(item => item.id === 'data')!.requiredChecks).toEqual(['test', 'typecheck', 'lint']);
    expect(withCi.tasks.find(item => item.id === 'review')!.requiredChecks).toEqual([]);
  });
});
