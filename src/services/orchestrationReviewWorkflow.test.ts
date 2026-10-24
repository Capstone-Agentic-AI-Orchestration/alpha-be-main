import { describe, expect, it } from 'vitest';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { buildOrchestrationReviewAmendment, OrchestrationReviewPlanError } from './orchestrationReviewWorkflow.js';
import { initialTaskRecords, type OrchestrationSnapshot, type OrchestrationTaskRecord } from './orchestrationStateMachine.js';

const plan = parseOrchestrationPlan({
  schemaVersion: 1,
  goal: 'Build a small task tracker.',
  exclusions: ['No authentication.'],
  requirements: [{ id: 'REQ-1', description: 'Users can create tasks.' }],
  tasks: [
    { id: 'backend-create', title: 'Implement task creation', description: 'Persist new tasks.', kind: 'backend', ownerAgentId: 'backend', dependsOn: [], requirementIds: ['REQ-1'], acceptanceCriteria: ['Created tasks persist.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] } },
    { id: 'review-1', title: 'Review task creation', description: 'Inspect the accepted implementation.', kind: 'review', ownerAgentId: 'reviewer', dependsOn: ['backend-create'], requirementIds: ['REQ-1'], acceptanceCriteria: ['Review all relevant changes and report evidence.'] },
    { id: 'validation-1', title: 'Validate task creation', description: 'Run integration checks.', kind: 'validation', ownerAgentId: 'qa', dependsOn: ['review-1'], requirementIds: ['REQ-1'], acceptanceCriteria: ['The application checks pass.'], requiredChecks: ['test'] },
    { id: 'delivery-1', title: 'Prepare delivery summary', description: 'Record local readiness.', kind: 'delivery', ownerAgentId: 'devops', dependsOn: ['validation-1'], requirementIds: ['REQ-1'], acceptanceCriteria: ['Readiness is documented.'] }
  ]
});

const eligibleAgents = [
  { id: 'backend', role: 'Backend Agent' },
  { id: 'reviewer', role: 'Security / Code Quality Agent' },
  { id: 'qa', role: 'Validation / Checking Agent' },
  { id: 'devops', role: 'GitHub Finalization Agent' }
] as const;

function snapshot(): OrchestrationSnapshot {
  const tasks = initialTaskRecords(plan).map(task => ({
    ...task,
    status: task.id === 'backend-create' ? 'accepted' as const
      : task.id === 'review-1' ? 'submitted' as const : 'pending' as const,
    revision: task.id === 'review-1' ? 2 : task.id === 'backend-create' ? 2 : 0,
    attemptCount: task.id === 'backend-create' || task.id === 'review-1' ? 1 : 0
  }));
  return {
    run: {
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', issueId: 'issue-1', repository: 'acme/tasks',
      requestKey: 'request-1', requestFingerprint: 'fingerprint', createdBy: 'user-1', executorId: 'desktop-1',
      ownershipEpoch: 1, workflowVersion: 1, planVersion: 1, plan, status: 'executing', revision: 5,
      currentTaskId: 'review-1', baseCommit: 'a'.repeat(40), createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z'
    },
    tasks,
    attempts: [], artifacts: [], findings: []
  };
}

describe('independent review correction planning', () => {
  it('keeps earlier milestone validation gates intact when correcting a later milestone', () => {
    const current = snapshot();
    const priorTasks = current.run.plan.tasks.map(task => ({ ...task, id: `old-${task.id}`, milestoneId: 'first', repository: 'acme/tasks', dependsOn: task.dependsOn.map(id => `old-${id}`) }));
    const activeTasks = current.run.plan.tasks.map(task => ({ ...task, milestoneId: 'second', repository: 'acme/tasks' }));
    current.run.plan = parseOrchestrationPlan({ ...current.run.plan, schemaVersion: 2,
      milestones: ['first', 'second'].map(id => ({ id, title: id, objective: 'Implement and verify tasks.', requirementIds: ['REQ-1'], repositories: ['acme/tasks'] })), tasks: [...priorTasks, ...activeTasks] });
    current.tasks = [...initialTaskRecords({ ...current.run.plan, tasks: priorTasks }).map(task => ({ ...task, status: 'accepted' as const })),
      ...current.tasks.map(task => ({ ...task, milestoneId: 'second', repository: 'acme/tasks' }))];
    const review = current.tasks.find(task => task.id === 'review-1')!;
    const amended = buildOrchestrationReviewAmendment(current, review, [{ targetTaskId: 'backend-create', severity: 'blocking', title: 'Fix task behavior', requirementId: 'REQ-1', evidence: 'Task behavior is incorrect.', instruction: 'Correct task behavior.' }], eligibleAgents);
    expect(amended.plan.tasks.find(task => task.id === 'old-validation-1')?.required).toBe(true);
    expect(amended.addedTasks.every(task => task.milestoneId === 'second')).toBe(true);
    expect(amended.plan.milestones).toEqual(current.run.plan.milestones);
  });
  it('creates a separate owner correction and a fresh independent review and validation chain', () => {
    const current = snapshot();
    const reviewTask = current.tasks.find(task => task.id === 'review-1')!;
    const result = buildOrchestrationReviewAmendment(current, reviewTask, [{
      targetTaskId: 'backend-create', severity: 'blocking', title: 'Unknown task IDs are accepted',
      requirementId: 'REQ-1', path: 'src/tasks/create.ts', evidence: 'The handler returns success for an ID that does not exist.',
      instruction: 'Return the documented not-found response and add a regression test.'
    }], eligibleAgents);

    expect(result.plan.tasks).toHaveLength(7);
    expect(result.addedTasks.map(task => [task.kind, task.ownerAgentId, task.status])).toEqual([
      ['backend', 'backend', 'ready'], ['review', 'reviewer', 'pending'], ['validation', 'qa', 'pending']
    ]);
    expect(result.addedTasks[0]).toMatchObject({ correctionOfTaskId: 'backend-create', correctionCycle: 1 });
    expect(result.addedTasks[1].dependsOn).toEqual([result.addedTasks[0].id]);
    expect(result.addedTasks[2].dependsOn).toEqual([result.addedTasks[1].id]);
    expect(result.plan.tasks.find(task => task.id === 'validation-1')?.required).toBe(false);
    expect(result.plan.tasks.find(task => task.id === 'delivery-1')?.dependsOn).toEqual(['validation-2']);
    expect(result.findings).toMatchObject([{
      taskId: 'backend-create', sourceTaskId: 'review-1', severity: 'blocking',
      correctionTaskId: result.addedTasks[0].id, evidence: { origin: 'independent_review' }
    }]);
  });

  it('records warnings without dispatching unnecessary correction tasks', () => {
    const current = snapshot();
    const result = buildOrchestrationReviewAmendment(current, current.tasks.find(task => task.id === 'review-1')!, [{
      targetTaskId: 'backend-create', severity: 'warning', title: 'Consider a clearer error message',
      requirementId: 'REQ-1', evidence: 'The response is technically correct but terse.', instruction: 'Consider a clearer message if the contract changes.'
    }], eligibleAgents);
    expect(result.plan).toBe(current.run.plan);
    expect(result.addedTasks).toEqual([]);
    expect(result.findings[0].correctionTaskId).toBeUndefined();
  });

  it('refuses to route a finding to the reviewer’s own code or exceed the correction ceiling', () => {
    const current = snapshot();
    const reviewTask = current.tasks.find(task => task.id === 'review-1')!;
    expect(() => buildOrchestrationReviewAmendment(current, reviewTask, [{
      targetTaskId: 'review-1', severity: 'blocking', title: 'Invalid target', evidence: 'x', instruction: 'y'
    }], eligibleAgents)).toThrow(OrchestrationReviewPlanError);

    const exhausted: OrchestrationSnapshot = {
      ...current,
      tasks: current.tasks.map(task => task.id === 'backend-create'
        ? { ...task, correctionOfTaskId: undefined }
        : task)
    };
    exhausted.tasks.push({
      ...current.tasks[0], id: 'correction-old', correctionOfTaskId: 'backend-create', correctionCycle: 2,
      status: 'accepted', revision: 2, attemptCount: 1, dependsOn: ['review-1']
    } as OrchestrationTaskRecord);
    const newReview = { ...reviewTask, id: 'review-3', status: 'submitted' as const, dependsOn: ['correction-old'] };
    exhausted.tasks[exhausted.tasks.findIndex(task => task.id === 'review-1')] = newReview;
    exhausted.run.currentTaskId = newReview.id;
    exhausted.run.planVersion = 3;
    expect(() => buildOrchestrationReviewAmendment(exhausted, newReview, [{
      targetTaskId: 'backend-create', severity: 'critical', title: 'Still broken', evidence: 'x', instruction: 'y'
    }], eligibleAgents)).toThrow(/2-cycle review-correction limit/);
  });
});
