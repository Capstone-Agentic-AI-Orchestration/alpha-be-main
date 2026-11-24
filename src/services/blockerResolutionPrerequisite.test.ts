import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import type { CliTurnResult } from './cliRunner.js';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import { OrchestrationRecoveryService } from './orchestrationRecoveryService.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import { BlockerResolutionService } from './blockerResolution.js';
import { resolutionOf, withResolution } from './blockerResolutionRecord.js';
import { resolvedWithoutYou } from './resolvedWithoutYou.js';
import { buildPrerequisiteAmendment } from './prerequisiteTasks.js';
import { blockerResolutionSchema, type PrerequisiteAnswer } from './blockerResolutionTurn.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

/**
 * Missing prerequisite tasks end to end (BLOCKER_RESOLUTION_PLAN phase 3): the real store, the
 * real orchestration and recovery services, the real planner parsing a scripted Orchestrator turn,
 * and the real verifier and classifier. No model runs and no specialist starts: launches are
 * recorded, and results are submitted the way a finished specialist's are.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args
], { cwd, stdio: 'pipe' }).toString().trim();
const agents = [
  { id: 'fe-agent', role: 'Frontend Agent' }, { id: 'be-agent', role: 'Backend Agent' }, { id: 'db-agent', role: 'Database Agent' },
  { id: 'reviewer', role: 'Security / Code Quality Agent' }, { id: 'orchestrator', role: 'Orchestrator Agent' }
] as const;
const API_BLOCKER = 'The specialist reported a blocker: The API contract for GET /api/bookings is not defined, so the booking fields are unknown.';
const STORE_BLOCKER = 'The specialist reported a blocker: There is no account store: the repository has no data layer to keep accounts, so sign-up cannot save them.';

function fits(...subjects: string[]) {
  return subjects.map(subject => ({ subject, subjectType: 'task' as const, verdict: 'fits' as const, reason: 'Serves R1 as the brief asks.' }));
}

/** A frontend that lists bookings, planned without the API it calls (the backend has no task). */
const bookingsPlan = {
  schemaVersion: 1, roleContractVersion: 2, goal: 'Let guests see their bookings.', exclusions: [],
  requirements: [{ id: 'R1', description: 'Guests see their bookings.' }],
  fitCheck: fits('booking-ui', 'review-fe'),
  tasks: [
    { id: 'booking-ui', title: 'Show bookings', description: 'List bookings from the API.', kind: 'frontend', repository: 'acme/shop-fe',
      ownerAgentId: 'fe-agent', requirementIds: ['R1'], acceptanceCriteria: ['The bookings list renders.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'] } },
    { id: 'review-fe', title: 'Review the bookings list', description: 'Review the frontend change.', kind: 'review', repository: 'acme/shop-fe',
      ownerAgentId: 'reviewer', dependsOn: ['booking-ui'], requirementIds: ['R1'], acceptanceCriteria: ['The change is reviewed.'] }
  ]
};

/** Sign-up planned with no place to keep accounts. */
const signUpPlan = {
  schemaVersion: 1, roleContractVersion: 2, goal: 'Let guests create an account.', exclusions: [],
  requirements: [{ id: 'R1', description: 'Guests sign up with email and password.' }],
  fitCheck: fits('sign-up', 'review-be'),
  tasks: [
    { id: 'sign-up', title: 'Sign up', description: 'Add the sign-up endpoint.', kind: 'backend', repository: 'acme/shop-be',
      ownerAgentId: 'be-agent', requirementIds: ['R1'], acceptanceCriteria: ['A guest can sign up.'], requiredChecks: ['test'], scope: { includePaths: ['src/routes/**'] } },
    { id: 'review-be', title: 'Review sign-up', description: 'Review the backend change.', kind: 'review', repository: 'acme/shop-be',
      ownerAgentId: 'reviewer', dependsOn: ['sign-up'], requirementIds: ['R1'], acceptanceCriteria: ['The change is reviewed.'] }
  ]
};

function bookingsApi(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bookings-api', title: 'Bookings API', description: 'Add GET /api/bookings returning id, date and guests for the frontend list.',
    kind: 'backend', repository: 'acme/shop-be', ownerAgentId: 'be-agent', requirementIds: ['R1'],
    acceptanceCriteria: ['GET /api/bookings returns id, date and guests.'], scope: { includePaths: ['src/routes/**', 'tests/**'] }, ...overrides
  };
}

function prerequisite(tasks: unknown[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    outcome: 'prerequisite',
    diagnosis: 'The frontend calls GET /api/bookings, and no task of the plan builds it; the backend has only a health route.',
    whyMissing: 'The plan has no backend task, and src/server.ts defines only the health route.',
    tasks,
    fitCheck: fits(...tasks.map(task => (task as { id: string }).id)),
    citations: [{ source: 'repository', repository: 'acme/shop-be', path: 'src/server.ts', quote: 'app.get("/health", health);' }],
    ...overrides
  });
}

/** The answer as the planner hands it over: parsed, with the schema's defaults. */
const parsed = (raw: string) => blockerResolutionSchema.parse(JSON.parse(raw)) as PrerequisiteAnswer;

const accountStore = JSON.stringify({
  outcome: 'prerequisite',
  diagnosis: 'Sign-up needs a place to keep accounts, and the backend has no data layer.',
  whyMissing: 'package.json has no database dependency and the plan has no database task.',
  tasks: [{ id: 'account-store', title: 'Account store', description: 'Set up repository-local storage for guest accounts and a data-access module for sign-up.',
    kind: 'database', repository: 'acme/shop-be', ownerAgentId: 'db-agent', requirementIds: ['R1'],
    acceptanceCriteria: ['Accounts can be created and read through the data-access module.'], scope: { includePaths: ['src/db/**', 'package.json', 'package-lock.json'] } }],
  fitCheck: fits('account-store'),
  citations: [{ source: 'repository', repository: 'acme/shop-be', path: 'package.json', quote: '"dependencies": { "express": "4.21.2" }' }]
});

describe('missing prerequisite tasks', () => {
  let directory = '';
  let store: SQLiteService | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./orchestrationRuntime.js');
    delete process.env.ALPHA_ORCHESTRATION_ENABLED;
    store?.close(); store = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  async function setup(plan: unknown, answers: string[], options: { autonomy?: 'standard' | 'strict' } = {}) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-prerequisites-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const db = store;
    vi.spyOn(db, 'getAgents').mockReturnValue(agents as never);
    vi.spyOn(db, 'getProjectOrchestrationSetting').mockReturnValue({ enabled: true, autonomy: options.autonomy ?? 'standard', sensitivePaths: [] } as never);
    db.addAllowedPath(directory, 'Prerequisite fixture');
    const dirs = { fe: path.join(directory, 'fe'), be: path.join(directory, 'be') };
    // Real repositories: a review reads the accepted work's diff from git.
    const commits: Record<string, string> = {};
    for (const dir of [dirs.fe, dirs.be]) {
      fs.mkdirSync(dir);
      git(dir, 'init', '--initial-branch', 'main');
      fs.writeFileSync(path.join(dir, 'README.md'), 'start\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'base');
      commits[dir] = git(dir, 'rev-parse', 'HEAD');
    }
    const dirOf = (repository: string) => repository === 'acme/shop-be' ? dirs.be : dirs.fe;
    const files: Record<string, string> = {
      [`${dirs.be}:src/server.ts`]: 'const app = express();\napp.get("/health", health);\nexport default app;',
      [`${dirs.be}:package.json`]: '{ "name": "shop-be", "dependencies": { "express": "4.21.2" } }'
    };
    const launch = vi.fn(async (request: { attemptId: string }) => ({ prototypeRunId: `prototype-${request.attemptId}` }));
    const service = new OrchestrationService(db, { launch });
    const recovery = new OrchestrationRecoveryService(db);
    const queue = [...answers];
    const turn = vi.fn(async () => ({ content: queue.shift() ?? '', failureKind: null, failureDetail: null } as unknown as CliTurnResult));
    const resolver = new BlockerResolutionService({
      store: db,
      planner: new OrchestrationPlanner(turn as never),
      plannerFor: async () => ({ id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent', provider: 'OpenAI', modelName: 'fixture' }),
      eligibleAgents: async () => agents.map(agent => ({ ...agent })),
      checkScripts: () => ['test', 'lint'],
      retryTask: input => service.retryTask(input),
      addPrerequisites: input => service.addPrerequisiteTasks(input),
      git: {
        head: async dir => commits[dir],
        changedPaths: async () => [],
        fileAtCommit: async (dir, _commit, filePath) => {
          const content = files[`${dir}:${filePath}`];
          if (content === undefined) throw new Error('missing');
          return content;
        }
      },
      productPicture: () => ({ prompt: '', records: [] }),
      async afterRetry(snapshot) { recovery.reconcileSnapshot(snapshot); },
      flushMilestones: async () => 0
    });
    // As the planner does: a selected codebase the plan leaves without tasks is optional.
    const used = new Set((plan as typeof bookingsPlan).tasks.map(task => task.repository));
    const repositoryWorkspaces = [['acme/shop-fe', dirs.fe], ['acme/shop-be', dirs.be]].map(([repository, worktreePath]) => ({
      repository, worktreePath, baseCommit: commits[worktreePath], baseRef: 'main', branchName: 'alpha/build', optional: !used.has(repository) }));
    const started = await service.start({
      workspaceId: 'ws-default', projectId: 'project', issueId: 'issue', repository: [...used][0], requestKey: 'request', requestFingerprint: 'request',
      createdBy: 'pm', executorId: 'executor', eligibleAgents: agents, plan, repositoryWorkspaces,
      optionalRepositories: repositoryWorkspaces.filter(item => item.optional).map(item => item.repository)
    });
    const active = await service.startPlannedWork({ workspaceId: 'ws-default', runId: started.run.id, expectedRevision: started.run.revision, actorId: 'pm' });
    return { db, service, recovery, resolver, turn, launch, runId: active.run.id, active, dirOf };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /**
   * The running task's specialist submits; acceptance accepts it, or rejects it with `reason`. A code
   * task that is accepted committed a file inside its scope, as a real specialist would.
   */
  async function finish(h: Setup, reason?: string): Promise<OrchestrationSnapshot> {
    const current = h.db.getOrchestrationSnapshot(h.runId)!;
    const task = current.tasks.find(item => item.id === current.run.currentTaskId)!;
    const attempt = [...current.attempts].reverse().find(item => item.taskId === task.id)!;
    const dir = h.dirOf(task.repository ?? current.run.repository);
    const before = git(dir, 'rev-parse', 'HEAD');
    if (!reason && task.kind !== 'review') {
      const folder = path.join(dir, task.scope.includePaths[0].replace(/\/\*\*$/, ''));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${task.id}.ts`), `export const ${task.id.replace(/\W/g, '_')} = true;\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', task.title);
    }
    const commit = git(dir, 'rev-parse', 'HEAD');
    const submitted = await h.service.submitResult({ workspaceId: 'ws-default', runId: h.runId, taskId: task.id, attemptId: attempt.id,
      expectedTaskRevision: task.revision, result: { summary: `${task.title} done.` }, resultCommit: commit });
    const revision = submitted.tasks.find(item => item.id === task.id)!.revision;
    if (reason) {
      return h.db.rejectOrchestrationAttempt({ runId: h.runId, taskId: task.id, attemptId: attempt.id, expectedTaskRevision: revision,
        rejectedBy: 'orchestrator', reason, findings: [{ severity: 'blocking', evidence: { check: 'agent_blocker', title: reason } }] });
    }
    return h.service.acceptAttempt({ workspaceId: 'ws-default', runId: h.runId, taskId: task.id, attemptId: attempt.id,
      expectedTaskRevision: revision, acceptedBy: 'orchestrator', evidence: { verified: true, diffStartingCommit: before } });
  }

  async function stuck(h: Setup, reason: string) {
    const blocked = await finish(h, reason);
    expect(blocked.run.status).toBe('blocked');
    h.recovery.reconcileSnapshot(blocked);
    return h.resolver.resolveIfStuck(h.db.getOrchestrationSnapshot(h.runId)!);
  }

  const episodes = (h: Setup) => h.db.listOrchestrationRecoveryEpisodes(h.runId);

  it('adds the missing API when the frontend has no contract; the frontend waits for it and the build continues', async () => {
    const h = await setup(bookingsPlan, [prerequisite([bookingsApi()])]);
    const record = await stuck(h, API_BLOCKER);

    expect(record).toMatchObject({ outcome: 'prerequisite_added', answer: 'prerequisite', tier: 1,
      proposedPrerequisite: { addedTaskIds: ['prerequisite-v2-1', 'prerequisite-v2-review-1'] } });
    const amended = h.db.getOrchestrationSnapshot(h.runId)!;
    expect(amended.run).toMatchObject({ status: 'executing', planVersion: 2, currentTaskId: 'prerequisite-v2-1' });
    const added = amended.tasks.find(task => task.id === 'prerequisite-v2-1')!;
    expect(added).toMatchObject({ kind: 'backend', repository: 'acme/shop-be', ownerAgentId: 'be-agent', required: true,
      requiredChecks: ['test', 'lint'], status: 'running' });
    // No review of the backend follows the new work, so Alpha adds an independent one.
    expect(amended.tasks.find(task => task.id === 'prerequisite-v2-review-1')).toMatchObject({ kind: 'review', repository: 'acme/shop-be',
      ownerAgentId: 'reviewer', dependsOn: ['prerequisite-v2-1'], status: 'pending' });
    expect(amended.tasks.find(task => task.id === 'booking-ui')).toMatchObject({ status: 'pending',
      dependsOn: ['prerequisite-v2-1', 'prerequisite-v2-review-1'] });
    expect(amended.run.plan.fitCheck?.map(entry => entry.subject)).toEqual(['booking-ui', 'review-fe', 'prerequisite-v2-1', 'prerequisite-v2-review-1']);
    expect(h.db.listOrchestrationEvents(h.runId, 0, 500).find(event => event.type === 'plan_amended')?.payload)
      .toMatchObject({ addedTaskIds: ['prerequisite-v2-1', 'prerequisite-v2-review-1'], waitingTaskId: 'booking-ui' });
    // The recovery closed in the same transaction, and the resolution is listed at approval.
    const episode = episodes(h)[0];
    expect(episode).toMatchObject({ phase: 'resolved', initiatedBy: 'orchestrator' });
    expect(resolvedWithoutYou(amended, episodes(h))).toEqual([expect.objectContaining({ status: 'prerequisite_added', tier: 1,
      fix: expect.stringContaining('“Bookings API” (backend, acme/shop-be)'),
      evidence: [expect.objectContaining({ repository: 'acme/shop-be', path: 'src/server.ts' })] })]);
    // The prompt carried the plan and the specialists that may own the work.
    const prompt = String((h.turn.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt);
    expect(prompt).toContain('"eligibleAgents"');
    expect(prompt).toContain('"requirementIds": [\n      "R1"');

    // The build continues: the API, then its review, then the frontend again.
    await finish(h);
    expect(h.db.getOrchestrationSnapshot(h.runId)!.run.currentTaskId).toBe('prerequisite-v2-review-1');
    await finish(h);
    const resumed = h.db.getOrchestrationSnapshot(h.runId)!;
    expect(resumed.run).toMatchObject({ status: 'executing', currentTaskId: 'booking-ui' });
    expect(resumed.attempts.filter(attempt => attempt.taskId === 'booking-ui')).toHaveLength(2);
  });

  it('holds an account store back for the person (a sensitive area), who adds it in one step; sign-up waits for it', async () => {
    const h = await setup(signUpPlan, [accountStore]);
    const record = await stuck(h, STORE_BLOCKER);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'sensitive', tier: 2,
      proposedPrerequisite: { summary: expect.stringContaining('“Account store” (database, acme/shop-be)') } });
    expect(record?.classifiedPaths).toContainEqual(expect.objectContaining({ path: 'package.json', tier: 2, categories: ['dependencies'] }));
    expect(h.db.getOrchestrationSnapshot(h.runId)!.run).toMatchObject({ status: 'blocked', planVersion: 1 });

    process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
    vi.resetModules();
    vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: h.service, taskAcceptanceService: {} }));
    const { OrchestrationRecoveryService: Fresh } = await import('./orchestrationRecoveryService.js');
    const state = await new Fresh(h.db).getState({ workspaceId: 'ws-default', runId: h.runId, canControl: true });
    expect(state.recovery?.availableActions).toContain('apply_proposed_fix');
    expect(state.recovery?.orchestratorResolution?.proposedFix).toContain('Account store');
    const blocked = h.db.getOrchestrationSnapshot(h.runId)!;
    const open = h.db.getOpenOrchestrationRecoveryEpisode(h.runId)!;
    const result = await new Fresh(h.db).executeAction({
      workspaceId: 'ws-default', projectId: 'project', runId: h.runId, recoveryId: open.id, actorId: 'pm', canControl: true,
      expectedRunRevision: blocked.run.revision, expectedRecoveryRevision: open.revision,
      expectedTaskRevision: blocked.tasks.find(task => task.id === 'sign-up')!.revision, idempotencyKey: 'add-store-0001', action: 'apply_proposed_fix'
    });

    expect(result).toMatchObject({ accepted: true, currentTaskId: 'prerequisite-v2-1' });
    const amended = h.db.getOrchestrationSnapshot(h.runId)!;
    expect(amended.tasks.find(task => task.id === 'prerequisite-v2-1')).toMatchObject({ kind: 'database', ownerAgentId: 'db-agent' });
    // The pending sign-up review now follows the store through sign-up, so no extra review is added.
    expect(amended.tasks.map(task => task.id)).toEqual(['sign-up', 'review-be', 'prerequisite-v2-1']);
    expect(amended.tasks.find(task => task.id === 'sign-up')).toMatchObject({ status: 'pending', dependsOn: ['prerequisite-v2-1'] });
    expect(resolutionOf(episodes(h)[0])).toMatchObject({ outcome: 'prerequisite_added', appliedBy: 'pm' });
    // Added by the person: theirs, not "resolved without you".
    expect(resolvedWithoutYou(amended, episodes(h))).toEqual([]);
  });

  it('asks under strict autonomy, with the work ready to add', async () => {
    const h = await setup(bookingsPlan, [prerequisite([bookingsApi()])], { autonomy: 'strict' });
    expect(await stuck(h, API_BLOCKER)).toMatchObject({ outcome: 'escalated', escalation: 'strict', tier: 1, proposedPrerequisite: expect.any(Object) });
    expect(h.db.getOrchestrationSnapshot(h.runId)!.run).toMatchObject({ status: 'blocked', planVersion: 1 });
  });

  it('escalates work in a repository outside the build, without a proposal to apply', async () => {
    const h = await setup(bookingsPlan, [prerequisite([bookingsApi({ repository: 'acme/payments' })])]);
    const record = await stuck(h, API_BLOCKER);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'outside_scope', reasons: ['acme/payments is not one of this build\'s repositories.'] });
    expect(record?.proposedPrerequisite).toBeUndefined();
    expect(h.db.getOrchestrationSnapshot(h.runId)!.run).toMatchObject({ status: 'blocked', planVersion: 1 });
  });

  it('escalates work for a requirement the stopped task does not serve', async () => {
    const plan = { ...bookingsPlan, requirements: [...bookingsPlan.requirements, { id: 'R2', description: 'Guests pay online.' }],
      tasks: [bookingsPlan.tasks[0], { ...bookingsPlan.tasks[0], id: 'pay-ui', title: 'Pay', requirementIds: ['R2'] },
        { ...bookingsPlan.tasks[1], dependsOn: ['booking-ui', 'pay-ui'], requirementIds: ['R1', 'R2'] }],
      fitCheck: fits('booking-ui', 'pay-ui', 'review-fe') };
    const h = await setup(plan, [prerequisite([bookingsApi({ requirementIds: ['R2'] })])]);
    expect(await stuck(h, API_BLOCKER)).toMatchObject({ outcome: 'escalated', escalation: 'outside_scope' });
  });

  it('escalates work that fails the build\'s plan check', async () => {
    // A frontend specialist may not own backend work.
    const h = await setup(bookingsPlan, [prerequisite([bookingsApi({ ownerAgentId: 'fe-agent' })])]);
    const record = await stuck(h, API_BLOCKER);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'plan_check' });
    expect(record?.reasons?.[0]).toMatch(/Frontend Agent is not an approved owner role for backend tasks/);
    expect(h.db.getOrchestrationSnapshot(h.runId)!.run).toMatchObject({ status: 'blocked', planVersion: 1 });
  });

  it('escalates work that conflicts with the product', async () => {
    const h = await setup(bookingsPlan, [prerequisite([bookingsApi()], { fitCheck: [{ subject: 'bookings-api', subjectType: 'task', verdict: 'conflicts',
      reason: 'The brief keeps bookings by phone only.', surfacedIn: 'Bookings' }] })]);
    expect(await stuck(h, API_BLOCKER)).toMatchObject({ outcome: 'escalated', escalation: 'fit_conflict',
      reasons: [expect.stringContaining('phone only')] });
  });

  it('escalates a repeat: the task stops again on the same problem after its work was added', async () => {
    const h = await setup(bookingsPlan, [prerequisite([bookingsApi()])]);
    await stuck(h, API_BLOCKER);
    await finish(h);
    await finish(h);
    const repeat = await stuck(h, API_BLOCKER);

    expect(repeat).toMatchObject({ outcome: 'escalated', escalation: 'repeat', turn: false });
    expect(h.turn).toHaveBeenCalledTimes(1);
    expect(h.db.getOrchestrationSnapshot(h.runId)!.run.planVersion).toBe(2);
  });

  it('lets the person win: acting while the Orchestrator thinks leaves the plan as it was', async () => {
    const h = await setup(bookingsPlan, []);
    h.turn.mockImplementationOnce(async () => {
      const open = h.db.getOpenOrchestrationRecoveryEpisode(h.runId)!;
      expect(resolutionOf(open)?.outcome).toBe('resolving');
      h.db.saveOrchestrationRecoveryEpisode({ episode: { ...open, guidance: 'Use the mock bookings until the API exists.', updatedAt: new Date().toISOString() },
        expectedRevision: open.revision, actorId: 'pm' });
      return { content: prerequisite([bookingsApi()]), failureKind: null, failureDetail: null } as unknown as CliTurnResult;
    });

    expect(await stuck(h, API_BLOCKER)).toBeUndefined();
    expect(resolutionOf(h.db.getOpenOrchestrationRecoveryEpisode(h.runId))?.outcome).toBe('superseded');
    expect(h.db.getOrchestrationSnapshot(h.runId)!.run).toMatchObject({ status: 'blocked', planVersion: 1 });
  });

  it('leaves the run consistent when the amendment is interrupted: all of it or none', async () => {
    const h = await setup(bookingsPlan, []);
    const blocked = await finish(h, API_BLOCKER);
    h.recovery.reconcileSnapshot(blocked);
    const open = h.db.getOpenOrchestrationRecoveryEpisode(h.runId)!;
    // Alpha marked the recovery and was building the amendment when it stopped.
    const marked = h.db.saveOrchestrationRecoveryEpisode({ episode: withResolution(open, { outcome: 'resolving', fingerprint: open.fingerprint, turn: true, startedAt: '' }),
      expectedRevision: open.revision, actorId: 'orchestrator' }).episode;
    const snapshot = h.db.getOrchestrationSnapshot(h.runId)!;
    const amendment = buildPrerequisiteAmendment({ snapshot, blockedTaskId: 'booking-ui', agents,
      proposal: parsed(prerequisite([bookingsApi()])), scripts: () => ['test'] });
    const task = snapshot.tasks.find(item => item.id === 'booking-ui')!;
    const closed = withResolution({ ...marked, phase: 'resolved' } as OrchestrationRecoveryEpisode, { outcome: 'prerequisite_added', fingerprint: open.fingerprint, turn: true, startedAt: '' });

    // The recovery record fails inside the transaction: the plan is not amended either.
    expect(() => h.db.amendBlockedRunWithPrerequisites({ runId: h.runId, expectedRunRevision: snapshot.run.revision, expectedPlanVersion: 1,
      taskId: task.id, expectedTaskRevision: task.revision, plan: amendment.plan, actorId: 'orchestrator', reason: 'test',
      recovery: { episode: closed, expectedRevision: marked.revision - 1 } })).toThrow(/Recovery changed/);
    const after = h.db.getOrchestrationSnapshot(h.runId)!;
    expect(after.run).toMatchObject({ status: 'blocked', planVersion: 1, revision: snapshot.run.revision });
    expect(after.tasks.map(item => item.id)).toEqual(['booking-ui', 'review-fe']);
    expect(h.db.getOrchestrationPlans(h.runId)).toHaveLength(1);
    // After a restart the half-done resolution is closed as interrupted and never retried.
    expect(h.resolver.markInterrupted(after)).toMatchObject({ outcome: 'interrupted' });
    expect(h.db.getOpenOrchestrationRecoveryEpisode(h.runId)?.phase).toBe('waiting_for_user');

    // A stale revision (the person acted first) refuses the whole amendment too.
    expect(() => h.db.amendBlockedRunWithPrerequisites({ runId: h.runId, expectedRunRevision: snapshot.run.revision - 1, expectedPlanVersion: 1,
      taskId: task.id, expectedTaskRevision: task.revision, plan: amendment.plan, actorId: 'orchestrator', reason: 'test' })).toThrow(/changed/);
    // Saved whole, it is one consistent step.
    const saved = h.db.amendBlockedRunWithPrerequisites({ runId: h.runId, expectedRunRevision: snapshot.run.revision, expectedPlanVersion: 1,
      taskId: task.id, expectedTaskRevision: task.revision, plan: amendment.plan, actorId: 'orchestrator', reason: 'test' });
    expect(saved.run).toMatchObject({ status: 'executing', planVersion: 2, currentTaskId: undefined });
    expect(saved.tasks.find(item => item.id === 'prerequisite-v2-1')?.status).toBe('ready');
  });

  it('refuses more work than Alpha adds alone, and work that waits on unfinished tasks', async () => {
    const h = await setup(bookingsPlan, []);
    const blocked = await finish(h, API_BLOCKER);
    const build = (tasks: unknown[]) => () => buildPrerequisiteAmendment({ snapshot: blocked, blockedTaskId: 'booking-ui', agents,
      proposal: { ...parsed(prerequisite([bookingsApi()])), tasks: tasks as PrerequisiteAnswer['tasks'] }, scripts: () => ['test'] });
    const four = [1, 2, 3, 4].map(index => ({ ...parsed(prerequisite([bookingsApi()])).tasks[0], id: `api-${index}` }));

    expect(build(four)).toThrow(expect.objectContaining({ reason: 'too_large' }));
    expect(build([{ ...four[0], dependsOn: ['review-fe'] }])).toThrow(expect.objectContaining({ reason: 'plan_check',
      message: expect.stringContaining('may wait only for accepted work') }));
    expect(build([{ ...four[0], scope: { includePaths: ['**'], excludePaths: [] } }])).toThrow(expect.objectContaining({ reason: 'plan_check' }));
    expect(build([{ ...four[0], id: 'bookings-api', scope: { includePaths: ['../shop-fe/src/**'], excludePaths: [] } }])).toThrow(expect.objectContaining({ reason: 'plan_check',
      message: expect.stringContaining('not a valid plan') }));
  });

  it('refuses in the store a plan that changes earlier work, even when built by hand', async () => {
    const h = await setup(bookingsPlan, []);
    const blocked = await finish(h, API_BLOCKER);
    const amendment = buildPrerequisiteAmendment({ snapshot: blocked, blockedTaskId: 'booking-ui', agents,
      proposal: parsed(prerequisite([bookingsApi()])), scripts: () => ['test'] });
    const widened = { ...amendment.plan, tasks: amendment.plan.tasks.map(task => task.id === 'review-fe' ? { ...task, required: false } : task) };
    const task = blocked.tasks.find(item => item.id === 'booking-ui')!;

    expect(() => h.db.amendBlockedRunWithPrerequisites({ runId: h.runId, expectedRunRevision: blocked.run.revision, expectedPlanVersion: 1,
      taskId: task.id, expectedTaskRevision: task.revision, plan: widened, actorId: 'orchestrator', reason: 'test' })).toThrow(/Earlier task review-fe was changed/);
  });
});
