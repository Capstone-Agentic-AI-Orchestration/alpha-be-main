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
  const auditPlan = () => parseOrchestrationPlan({ schemaVersion: 1, roleContractVersion: 2, goal: 'Audit and remediate dependencies',
    requirements: [{ id: 'SEC', description: 'Resolve dependency vulnerabilities.' }], tasks: [
      { id: 'baseline', kind: 'audit', ownerAgentId: 'security', dependsOn: [], dependencyAudit: { scanner: 'npm', purpose: 'baseline', level: 'low' } },
      { id: 'fix', kind: 'backend', ownerAgentId: 'backend', dependsOn: ['baseline'] },
      { id: 'verify', kind: 'review', ownerAgentId: 'security', dependsOn: ['fix'], dependencyAudit: { scanner: 'npm', purpose: 'verification', level: 'low' } },
      { id: 'test', kind: 'validation', ownerAgentId: 'qa', dependsOn: ['verify'] }
    ].map(task => ({ ...task, title: task.id, description: 'Perform assigned work.', repository: 'acme/api', requirementIds: ['SEC'], acceptanceCriteria: ['Evidence is recorded.'] })) });
  const auditAgents = [...eligibleAgents, { id: 'security', role: 'Security / Code Quality Agent' }] as const;
  it('requires Security evidence before fixes and independent verification before functional validation', () => {
    const candidate = auditPlan();
    expect(validateOrchestrationPlan(candidate, auditAgents, { initialPlan: true, repositories: ['acme/api'] })).toEqual([]);
    candidate.tasks[1].dependsOn = [];
    candidate.tasks[3].dependsOn = ['fix'];
    expect(validateOrchestrationPlan(candidate, auditAgents).filter(issue => issue.code === 'audit_dependency_missing').map(issue => issue.taskId)).toEqual(expect.arrayContaining(['fix', 'test']));
    candidate.tasks[0].ownerAgentId = 'backend';
    candidate.tasks[2].dependencyAudit!.level = 'critical';
    expect(validateOrchestrationPlan(candidate, auditAgents).filter(issue => issue.code === 'audit_authority')).toHaveLength(2);
  });
  it('does not let one repository audit stand in for another repository', () => {
    const candidate = auditPlan(); candidate.tasks[2].repository = 'acme/client';
    expect(validateOrchestrationPlan(candidate, auditAgents).some(issue => issue.code === 'audit_verification_missing')).toBe(true);
  });
  it('allows a baseline-only adaptive milestone while direct plans require final verification', () => {
    const candidate = auditPlan(); candidate.tasks = candidate.tasks.slice(0, 1);
    expect(validateOrchestrationPlan(candidate, auditAgents).some(issue => issue.code === 'audit_verification_missing')).toBe(true);
    expect(validateOrchestrationPlan(candidate, auditAgents, { auditMilestone: true })).toEqual([]);
    const adaptive = auditPlan(); adaptive.schemaVersion = 2;
    adaptive.milestones = [
      { id: 'inspect', title: 'Inspect', objective: 'Gather evidence.', requirementIds: ['SEC'], repositories: ['acme/api'] },
      { id: 'remediate', title: 'Remediate', objective: 'Use evidence to fix and verify.', requirementIds: ['SEC'], repositories: ['acme/api'] }
    ];
    adaptive.tasks.forEach(task => { task.milestoneId = task.id === 'baseline' ? 'inspect' : 'remediate'; });
    adaptive.tasks[1].dependsOn = [];
    expect(validateOrchestrationPlan(adaptive, auditAgents)).toEqual([]);
  });
  it('requires a single Manager brief to precede implementation under the new contract', () => {
    const brief = { ...plan.tasks[0], id: 'brief', kind: 'requirements' as const, ownerAgentId: 'manager', dependsOn: [] };
    const current = { ...plan, roleContractVersion: 1 as const, tasks: [brief, ...plan.tasks] };
    const roster = [...eligibleAgents, { id: 'manager', role: 'Manager Agent' as const }];
    expect(validateOrchestrationPlan(current, roster).some(issue => issue.code === 'requirements_dependency_missing')).toBe(true);
    current.tasks = current.tasks.map(task => task.id === 'design' ? { ...task, dependsOn: ['brief'] } : task);
    expect(validateOrchestrationPlan(current, roster)).toEqual([]);
    current.tasks.push({ ...brief, id: 'duplicate-brief' });
    expect(validateOrchestrationPlan(current, roster).some(issue => issue.code === 'duplicate_requirements_brief')).toBe(true);
  });
  it('rejects unrecognized fields rather than silently accepting prompt expansion', () => {
    expect(() => orchestrationPlanSchema.parse({ ...plan, unreviewedInstruction: 'deploy to production' })).toThrow();
  });

  it('validates the example DAG and maps each task to an eligible role', () => {
    expect(validateOrchestrationPlan(plan, eligibleAgents)).toEqual([]);
  });

  it('keeps the Orchestrator a planner rather than a requirements worker', () => {
    expect(roleCanOwnOrchestrationTask('requirements', 'Orchestrator Agent')).toBe(false);
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
