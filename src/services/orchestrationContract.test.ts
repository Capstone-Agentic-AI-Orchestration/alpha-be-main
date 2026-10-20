import { describe, expect, it } from 'vitest';
import {
  orchestrationPlanSchema,
  parseOrchestrationPlan,
  roleCanOwnOrchestrationTask,
  validateOrchestrationPlan
} from './orchestrationContract.js';
import {
  allRequiredTasksAccepted,
  initialTaskRecords,
  OrchestrationTransitionError,
  selectNextReadyTask,
  transitionTask,
  type OrchestrationTaskRecord
} from './orchestrationStateMachine.js';

const plan = parseOrchestrationPlan({
  schemaVersion: 1,
  goal: 'Build a small task tracker.',
  exclusions: ['No authentication'],
  requirements: [
    { id: 'REQ-1', description: 'Users can create and list tasks.' },
    { id: 'REQ-2', description: 'Users can complete a task.' }
  ],
  tasks: [
    { id: 'design', title: 'Define task contract', description: 'Specify task fields and API behavior.', kind: 'architecture', ownerAgentId: 'architect', dependsOn: [], requirementIds: ['REQ-1', 'REQ-2'], acceptanceCriteria: ['Contract covers create, list, and completion.'] },
    { id: 'backend-create', title: 'Implement task endpoints', description: 'Implement create and list endpoints.', kind: 'backend', ownerAgentId: 'backend', dependsOn: ['design'], requirementIds: ['REQ-1'], acceptanceCriteria: ['Endpoints match the approved contract.'], requiredChecks: ['test'] },
    { id: 'backend-complete', title: 'Implement completion', description: 'Implement task completion.', kind: 'backend', ownerAgentId: 'backend', dependsOn: ['backend-create'], requirementIds: ['REQ-2'], acceptanceCriteria: ['Completion persists.'], requiredChecks: ['test'] },
    { id: 'validation', title: 'Validate task tracker', description: 'Check all requirements.', kind: 'validation', ownerAgentId: 'qa', dependsOn: ['backend-complete'], requirementIds: ['REQ-1', 'REQ-2'], acceptanceCriteria: ['All required behaviors pass.'] }
  ]
});

const eligibleAgents = [
  { id: 'architect', role: 'Architecture Agent' },
  { id: 'backend', role: 'Backend Agent' },
  { id: 'qa', role: 'Validation / Checking Agent' }
] as const;

describe('orchestration plan contract', () => {
  it('rejects unrecognized fields rather than silently accepting prompt expansion', () => {
    expect(() => orchestrationPlanSchema.parse({ ...plan, unreviewedInstruction: 'deploy to production' })).toThrow();
  });

  it('validates the example DAG and maps each task to an eligible role', () => {
    expect(validateOrchestrationPlan(plan, eligibleAgents)).toEqual([]);
  });

  it('allows the Orchestrator Agent to own requirements planning', () => {
    expect(roleCanOwnOrchestrationTask('requirements', 'Orchestrator Agent')).toBe(true);
  });

  it('detects role mismatch, missing requirements, unknown dependencies, and cycles', () => {
    const invalid = parseOrchestrationPlan({
      ...plan,
      tasks: plan.tasks.map(task => task.id === 'backend-create'
        ? { ...task, ownerAgentId: 'architect', dependsOn: ['backend-complete'] }
        : task.id === 'backend-complete' ? { ...task, dependsOn: ['backend-create', 'missing'] } : task)
    });
    const issues = validateOrchestrationPlan(invalid, eligibleAgents);
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'role_mismatch', 'dependency_cycle', 'unknown_dependency'
    ]));
  });
});

describe('orchestration task state machine', () => {
  it('keeps two tasks for the same specialist distinct and dispatches by dependencies', () => {
    const tasks = initialTaskRecords(plan);
    expect(tasks.filter(task => task.ownerAgentId === 'backend')).toHaveLength(2);
    expect(selectNextReadyTask(plan, tasks)?.id).toBe('design');
  });

  it('only makes a dependent task ready after its prerequisite is accepted', () => {
    let task = initialTaskRecords(plan).find(item => item.id === 'backend-create')!;
    expect(() => transitionTask(task, 'ready', task.revision, new Set())).toThrow(OrchestrationTransitionError);
    task = transitionTask(task, 'ready', task.revision, new Set(['design']));
    expect(task.status).toBe('ready');
  });

  it('rejects stale updates and accepts a task only from submitted state', () => {
    let task = initialTaskRecords(plan)[0];
    task = transitionTask(task, 'running', task.revision, new Set());
    expect(task.attemptCount).toBe(1);
    task = transitionTask(task, 'submitted', task.revision, new Set());
    task = transitionTask(task, 'accepted', task.revision, new Set());
    expect(task.acceptedRevision).toBe(task.revision);
    expect(() => transitionTask(task, 'ready', task.revision - 1, new Set())).toThrow(OrchestrationTransitionError);
  });

  it('marks completion only when every required task is accepted', () => {
    const tasks = initialTaskRecords(plan);
    expect(allRequiredTasksAccepted(tasks)).toBe(false);
    const accepted = tasks.map(task => ({ ...task, status: 'accepted' as const } as OrchestrationTaskRecord));
    expect(allRequiredTasksAccepted(accepted)).toBe(true);
  });
});
