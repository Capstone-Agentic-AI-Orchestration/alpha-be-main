import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationRecoveryEpisode, ProjectOrchestrationSetting } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { SQLiteService } from './sqliteService.js';
import type { CliTurnResult } from './cliRunner.js';
import { OrchestrationRecoveryService } from './orchestrationRecoveryService.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import { BlockerResolutionService, MAX_RESOLUTIONS_PER_BUILD, PRODUCT_ONLY_EVIDENCE } from './blockerResolution.js';
import { resolutionOf } from './blockerResolutionRecord.js';
import { recoveryAvailableActions } from './orchestrationRecoveryPolicy.js';

/**
 * The resolution loop end to end with a scripted Orchestrator turn: the real recovery service opens
 * the episode from the snapshot, the real planner parses the scripted answer, the real verifier and
 * classifier decide, and the retry is recorded instead of starting a specialist. No model is called.
 */

const BASE = 'a'.repeat(40);
const API_COMMIT = 'b'.repeat(40);
const FE_COMMIT = 'c'.repeat(40);
const LINT_FAILURE = 'Required check “lint” was not observed passing on this attempt.';
const API_BLOCKER = 'The specialist reported a blocker: The API contract for GET /api/bookings is not defined, so the booking fields are unknown.';
const PRODUCT_BLOCKER = 'The specialist reported a blocker: Should guests cancel bookings online, or only by phone? The requirements do not say.';

/** Repository files at the build's checkpoints: `dir:path`. */
const FILES: Record<string, string> = {
  '/work/fe:src/BookingList.tsx': 'export function BookingList({ bookings }) {\n  const unused = 1;\n  return bookings.map(b => <li>{b.date}</li>);\n}',
  '/work/fe:eslint.config.mjs': 'export default [{ rules: { "no-unused-vars": "error" } }];',
  '/work/fe:src/auth/session.ts': 'export const SESSION_COOKIE = "sid";',
  '/work/be:src/routes/bookings.ts': 'router.get("/api/bookings", (req, res) => res.json({ id: booking.id, date: booking.date, guests: booking.guests }));'
};

interface Harness {
  state: { snapshot: OrchestrationSnapshot; setting: ProjectOrchestrationSetting };
  episodes: Map<string, OrchestrationRecoveryEpisode>;
  milestones: Array<{ episodeId: string; key: string; content: string }>;
  recovery: OrchestrationRecoveryService;
  resolver: BlockerResolutionService;
  turn: ReturnType<typeof vi.fn>;
  retries: Array<Record<string, unknown>>;
  plannerFor: ReturnType<typeof vi.fn>;
}

function task(overrides: Record<string, unknown>) {
  return {
    title: 'Show bookings', description: 'List bookings from the API.', kind: 'frontend', repository: 'acme/shop-fe',
    ownerAgentId: 'fe-agent', status: 'blocked', revision: 5, required: true, attemptCount: 0, requirementIds: ['R1'],
    acceptanceCriteria: ['The bookings list renders.'], requiredChecks: ['test', 'lint'], dependsOn: ['bookings-api'],
    scope: { includePaths: ['src/**', 'tests/**'], excludePaths: [] }, ...overrides
  };
}

function failedAttempts(taskId: string, count: number, reason: string, from = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${taskId}-attempt-${from + index}`, runId: 'run-1', taskId, attemptNumber: from + index, agentId: 'fe-agent',
    prototypeRunId: `prototype-${taskId}-${from + index}`, startingCommit: BASE, resultCommit: FE_COMMIT, status: 'rejected',
    failureReason: reason, result: { rejectionReason: reason }, contextManifest: {}, createdAt: `2026-11-24T10:0${from + index}:00.000Z`
  }));
}

function snapshot(input: { reason: string; attempts: number; extraTasks?: unknown[]; extraAttempts?: unknown[] }): OrchestrationSnapshot {
  const tasks = [
    task({ id: 'booking-ui' }),
    task({ id: 'bookings-api', title: 'Bookings API', kind: 'backend', repository: 'acme/shop-be', status: 'accepted', dependsOn: [] }),
    ...(input.extraTasks ?? [])
  ];
  return {
    run: {
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', issueId: 'issue-1', repository: 'acme/shop-fe', createdBy: 'pm-1',
      status: 'blocked', revision: 9, planVersion: 1, originChatThreadId: 'thread-1',
      repositoryWorkspaces: [
        { repository: 'acme/shop-fe', worktreePath: '/work/fe', baseCommit: BASE, branchName: 'alpha/build' },
        { repository: 'acme/shop-be', worktreePath: '/work/be', baseCommit: BASE, branchName: 'alpha/build' }
      ],
      plan: { goal: 'Let guests see their bookings.', exclusions: [], requirements: [{ id: 'R1', description: 'List bookings' }], tasks }
    },
    tasks,
    attempts: [
      { id: 'api-attempt-1', runId: 'run-1', taskId: 'bookings-api', attemptNumber: 1, agentId: 'be-agent', prototypeRunId: 'prototype-api',
        startingCommit: BASE, resultCommit: API_COMMIT, status: 'accepted', contextManifest: {}, createdAt: '2026-11-24T09:00:00.000Z',
        result: { summary: 'GET /api/bookings returns id, date and guests.', acceptanceEvidence: { changedPaths: ['src/routes/bookings.ts'] } } },
      ...failedAttempts('booking-ui', input.attempts, input.reason),
      ...(input.extraAttempts ?? [])
    ],
    artifacts: [],
    findings: []
  } as unknown as OrchestrationSnapshot;
}

function fix(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    outcome: 'fix',
    diagnosis: 'Lint fails on an unused variable in BookingList; the rule is no-unused-vars.',
    instructions: 'Remove the unused variable `unused` from src/BookingList.tsx and run lint again.',
    citations: [{ source: 'repository', repository: 'acme/shop-fe', path: 'src/BookingList.tsx', quote: 'const unused = 1;\n  return bookings.map' }],
    expectedFiles: [{ repository: 'acme/shop-fe', path: 'src/BookingList.tsx' }],
    ...overrides
  });
}

function harness(initial: OrchestrationSnapshot, answers: string[], setting: Partial<ProjectOrchestrationSetting> = {}): Harness {
  const state = { snapshot: initial, setting: { enabled: true, autonomy: 'standard', sensitivePaths: [], ...setting } as ProjectOrchestrationSetting };
  const episodes = new Map<string, OrchestrationRecoveryEpisode>();
  const milestones: Harness['milestones'] = [];
  const open = () => [...episodes.values()].reverse().find(item => ['repairing', 'waiting_for_user', 'ready_to_continue'].includes(item.phase));
  const comparable = (episode: OrchestrationRecoveryEpisode) => JSON.stringify({ ...episode, revision: 0, updatedAt: '' });
  const store = {
    getOrchestrationSnapshot: () => state.snapshot,
    getOrchestrationChatBinding: () => ({ runId: 'run-1', projectId: 'project-1', threadId: 'thread-1', buildMessageId: 'build-1', ownerId: 'pm-1' }),
    getOpenOrchestrationRecoveryEpisode: open,
    getOrchestrationRecoveryEpisode: (_runId: string, id: string) => episodes.get(id),
    listOrchestrationRecoveryEpisodes: () => [...episodes.values()],
    listOrchestrationEvents: () => [],
    listPendingOrchestrationRecoveryMilestones: () => [],
    getProjectOrchestrationSetting: () => state.setting,
    getAgents: () => [],
    saveOrchestrationRecoveryEpisode: (input: { episode: OrchestrationRecoveryEpisode; expectedRevision?: number; milestone?: { key: string; content: string } }) => {
      const current = episodes.get(input.episode.id);
      let saved: OrchestrationRecoveryEpisode;
      if (current && comparable(current) === comparable({ ...input.episode, revision: current.revision })) {
        saved = current;
      } else if (current) {
        if (current.revision !== (input.expectedRevision ?? current.revision)) throw new Error('Recovery changed while this action was open.');
        saved = { ...input.episode, revision: current.revision + 1 };
      } else {
        if (open()) throw new Error('Another recovery is already active for this build.');
        saved = { ...input.episode, revision: 0 };
      }
      episodes.set(saved.id, saved);
      if (input.milestone && !milestones.some(item => item.episodeId === saved.id && item.key === input.milestone!.key)) {
        milestones.push({ episodeId: saved.id, ...input.milestone });
      }
      return { episode: saved, changed: saved !== current };
    }
  } as unknown as SQLiteService;
  const recovery = new OrchestrationRecoveryService(store);
  const queue = [...answers];
  const turn = vi.fn(async () => ({ content: queue.shift() ?? '', failureKind: null, failureDetail: null } as unknown as CliTurnResult));
  const retries: Array<Record<string, unknown>> = [];
  const plannerFor = vi.fn(async () => ({ id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent', provider: 'OpenAI', modelName: 'fixture' }));
  const resolver = new BlockerResolutionService({
    store,
    planner: new OrchestrationPlanner(turn as never),
    plannerFor: plannerFor as never,
    async retryTask(input) {
      retries.push(input);
      const current = state.snapshot;
      if (input.expectedRunRevision !== current.run.revision) throw new Error('The build changed since this recovery was opened.');
      state.snapshot = {
        ...current,
        run: { ...current.run, status: 'executing', currentTaskId: input.taskId, revision: current.run.revision + 1 },
        tasks: current.tasks.map(item => item.id === input.taskId ? { ...item, status: 'running', revision: item.revision + 1 } : item),
        attempts: [...current.attempts, { id: `${input.taskId}-retry`, runId: 'run-1', taskId: input.taskId, attemptNumber: 9, agentId: 'fe-agent',
          prototypeRunId: 'prototype-retry', startingCommit: FE_COMMIT, status: 'running', contextManifest: {}, createdAt: '2026-11-24T11:00:00.000Z' }]
      } as OrchestrationSnapshot;
      return state.snapshot;
    },
    git: {
      head: async dir => dir === '/work/be' ? API_COMMIT : FE_COMMIT,
      changedPaths: async () => ['src/BookingList.tsx'],
      fileAtCommit: async (dir, _commit, filePath) => {
        const content = FILES[`${dir}:${filePath}`];
        if (content === undefined) throw new Error('missing');
        return content;
      }
    },
    productPicture: () => ({
      prompt: '## Product picture: Shop\nDecisions recorded in build plans:\n- Bookings: guests manage bookings by phone only',
      records: ['A shop where guests see their bookings.', 'Bookings: guests manage bookings by phone only']
    }),
    async afterRetry(updated) { recovery.reconcileSnapshot(updated); },
    flushMilestones: async () => 0,
    now: () => '2026-11-24T12:00:00.000Z'
  });
  return { state, episodes, milestones, recovery, resolver, turn, retries, plannerFor };
}

/** Opens the recovery the way the runtime does, then runs the resolver hook. */
async function stuck(h: Harness) {
  h.recovery.reconcileSnapshot(h.state.snapshot);
  return h.resolver.resolveIfStuck(h.state.snapshot);
}

function openEpisode(h: Harness) {
  return [...h.episodes.values()].at(-1)!;
}

/** The retry passed acceptance: the task is accepted and the build moves on. */
function acceptRetry(h: Harness) {
  const current = h.state.snapshot;
  h.state.snapshot = {
    ...current,
    run: { ...current.run, status: 'executing', currentTaskId: undefined },
    tasks: current.tasks.map(item => item.id === 'booking-ui' ? { ...item, status: 'accepted' } : item),
    attempts: current.attempts.map(item => item.status === 'running' ? { ...item, status: 'accepted', resultCommit: FE_COMMIT } : item)
  } as OrchestrationSnapshot;
  h.recovery.reconcileSnapshot(h.state.snapshot);
}

/** The retry failed the same check: the build is blocked on the task again. */
function failRetry(h: Harness, reason = LINT_FAILURE) {
  const current = h.state.snapshot;
  h.state.snapshot = {
    ...current,
    run: { ...current.run, status: 'blocked', currentTaskId: undefined, revision: current.run.revision + 1 },
    tasks: current.tasks.map(item => item.id === 'booking-ui' ? { ...item, status: 'blocked', revision: item.revision + 1 } : item),
    attempts: current.attempts.map(item => item.status === 'running'
      ? { ...item, status: 'rejected', failureReason: reason, resultCommit: FE_COMMIT, result: { rejectionReason: reason } } : item)
  } as OrchestrationSnapshot;
  h.recovery.reconcileSnapshot(h.state.snapshot);
}

describe('blocker resolution', () => {
  it('fixes checks that failed three times from a cited diagnosis, through the normal guided retry', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix()]);
    const record = await stuck(h);

    expect(record).toMatchObject({ outcome: 'retrying', tier: 0, turn: true, plannerAgentId: 'orchestrator' });
    expect(h.retries).toEqual([expect.objectContaining({
      taskId: 'booking-ui', actorId: 'orchestrator', expectedTaskRevision: 5, expectedRunRevision: 9,
      developerGuidance: expect.stringContaining('Remove the unused variable')
    })]);
    expect(String(h.retries[0].developerGuidance)).toContain('Evidence: acme/shop-fe:src/BookingList.tsx.');
    const episode = openEpisode(h);
    expect(episode).toMatchObject({ initiatedBy: 'orchestrator', guidance: expect.stringContaining('Lint fails on an unused variable') });
    expect(resolutionOf(episode)?.citations).toEqual([expect.objectContaining({ repository: 'acme/shop-fe', path: 'src/BookingList.tsx', commit: FE_COMMIT })]);
    expect(h.milestones.map(item => item.key)).toContain('orchestrator_resolution');
    // The prompt carried the failure, the task's files and the dependency's handoff, as data.
    const prompt = String((h.turn.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt);
    expect(prompt).toContain(LINT_FAILURE);
    expect(prompt).toContain('GET /api/bookings returns id, date and guests.');
    expect(prompt).toContain('guests manage bookings by phone only');

    acceptRetry(h);
    expect(openEpisode(h).phase).toBe('resolved');
    expect(resolutionOf(openEpisode(h))?.outcome).toBe('retry_accepted');
  });

  it('answers a blocker from another repository of the build (the API contract case)', async () => {
    const h = harness(snapshot({ reason: API_BLOCKER, attempts: 1 }), [fix({
      diagnosis: 'The accepted backend task already defines GET /api/bookings and its fields.',
      instructions: 'Render id, date and guests from GET /api/bookings as the backend route returns them.',
      citations: [{ source: 'repository', repository: 'acme/shop-be', path: 'src/routes/bookings.ts', quote: 'res.json({ id: booking.id, date: booking.date, guests: booking.guests })' }]
    })]);
    const record = await stuck(h);

    expect(record).toMatchObject({ outcome: 'retrying', tier: 0 });
    expect(record?.citations).toEqual([expect.objectContaining({ repository: 'acme/shop-be', commit: API_COMMIT })]);
    expect(h.retries).toHaveLength(1);
    const prompt = String((h.turn.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt);
    expect(prompt).toContain('"blocker": "The API contract for GET /api/bookings is not defined');
  });

  it('asks a product decision once, framed, and never re-asks it in the same build', async () => {
    const h = harness(snapshot({ reason: PRODUCT_BLOCKER, attempts: 1 }), [JSON.stringify({
      outcome: 'needs_owner',
      diagnosis: 'The plan and product picture do not say how guests cancel.',
      question: 'Should guests cancel bookings online, or only by phone?',
      options: [{ label: 'Online', description: 'Add a cancel button.' }, { label: 'Phone only' }],
      whyNotFromEvidence: 'No recorded decision covers cancellation.'
    })]);
    const first = await stuck(h);

    expect(first).toMatchObject({ outcome: 'escalated', escalation: 'product', tier: 3, question: { text: 'Should guests cancel bookings online, or only by phone?' } });
    expect(h.retries).toEqual([]);
    expect(openEpisode(h).phase).toBe('waiting_for_user');
    const asked = h.milestones.filter(item => item.key === 'orchestrator_escalation_product');
    expect(asked).toHaveLength(1);
    expect(asked[0].content).toContain('Options: Online / Phone only.');
    expect(h.recovery.explain(openEpisode(h))).toContain('Should guests cancel bookings online');

    // The person answers; a later task stops on the very same question.
    const answered = openEpisode(h);
    h.episodes.set(answered.id, { ...answered, phase: 'resolved' });
    const later = snapshot({ reason: PRODUCT_BLOCKER, attempts: 0,
      extraTasks: [task({ id: 'booking-admin', title: 'Admin bookings' })], extraAttempts: failedAttempts('booking-admin', 1, PRODUCT_BLOCKER) });
    h.state.snapshot = { ...later, tasks: later.tasks.map(item => item.id === 'booking-ui' ? { ...item, status: 'accepted' } : item) } as OrchestrationSnapshot;
    const repeat = await stuck(h);

    expect(repeat).toMatchObject({ outcome: 'escalated', escalation: 'repeat', turn: false, question: { text: 'Should guests cancel bookings online, or only by phone?' } });
    expect(h.turn).toHaveBeenCalledTimes(1);
    expect(h.milestones.filter(item => item.key === 'orchestrator_escalation_product')).toHaveLength(1);
  });

  it('holds back a fix that touches a sensitive area, verified and ready for the person to apply in one step', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix({
      instructions: 'Read the cookie name from src/auth/session.ts instead of hard-coding it.',
      citations: [{ source: 'repository', repository: 'acme/shop-fe', path: 'src/auth/session.ts', quote: 'export const SESSION_COOKIE = "sid";' }],
      expectedFiles: [{ repository: 'acme/shop-fe', path: 'src/auth/session.ts' }]
    })]);
    const record = await stuck(h);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'sensitive', tier: 2,
      proposedFix: { instructions: expect.stringContaining('src/auth/session.ts') } });
    expect(record?.classifiedPaths).toContainEqual(expect.objectContaining({ path: 'src/auth/session.ts', tier: 2, categories: ['security'] }));
    expect(h.retries).toEqual([]);
    const episode = openEpisode(h);
    expect(h.recovery.explain(episode)).toContain('Alpha has a verified fix ready for you to apply.');
    const offered = recoveryAvailableActions({ snapshot: h.state.snapshot, category: episode.category, taskId: 'booking-ui', canControl: true,
      episodeAgeMs: 0, proposedFixReady: true });
    expect(offered.availableActions).toEqual(expect.arrayContaining(['apply_proposed_fix', 'provide_guidance']));
  });

  it('escalates a fabricated citation without acting on it', async () => {
    const h = harness(snapshot({ reason: API_BLOCKER, attempts: 1 }), [fix({
      citations: [{ source: 'repository', repository: 'acme/shop-be', path: 'src/routes/bookings.ts', quote: 'res.json({ id: booking.id, total: booking.total })' }]
    })]);
    const record = await stuck(h);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'unverified' });
    expect(record?.refusedCitations).toEqual([expect.objectContaining({ reason: expect.stringContaining('not in src/routes/bookings.ts') })]);
    expect(record?.proposedFix).toBeUndefined();
    expect(h.retries).toEqual([]);
  });

  it('never acts alone on product records: a fix needs a verified repository file too', async () => {
    const productOnly = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix({
      citations: [{ source: 'product_picture', quote: 'guests manage bookings by phone only' }]
    })]);
    const record = await stuck(productOnly);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'unverified', reasons: [PRODUCT_ONLY_EVIDENCE] });
    expect(record?.citations).toEqual([{ source: 'product_picture', quote: 'guests manage bookings by phone only' }]);
    expect(productOnly.retries).toEqual([]);

    // With a verified file beside it, the same decision backs a fix that may act.
    const withFile = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix({
      citations: [
        { source: 'product_picture', quote: 'guests manage bookings by phone only' },
        { source: 'repository', repository: 'acme/shop-fe', path: 'src/BookingList.tsx', quote: 'const unused = 1;\n  return bookings.map' }
      ]
    })]);
    expect(await stuck(withFile)).toMatchObject({ outcome: 'retrying' });
  });

  it('does not take board cards, chat requests or build goals as product evidence', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix({
      citations: [
        { source: 'product_picture', quote: 'Let guests see their bookings.' },
        { source: 'repository', repository: 'acme/shop-fe', path: 'src/BookingList.tsx', quote: 'const unused = 1;\n  return bookings.map' }
      ]
    })]);
    const record = await stuck(h);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'unverified' });
    expect(record?.refusedCitations?.[0].reason).toMatch(/brief or recorded decisions/);
    expect(h.retries).toEqual([]);
  });

  it('escalates a repeat of a problem it already fixed, without another turn', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix()]);
    await stuck(h);
    acceptRetry(h);
    // Another task fails the same way later in the build.
    const later = snapshot({ reason: LINT_FAILURE, attempts: 0,
      extraTasks: [task({ id: 'booking-detail', title: 'Booking detail' })], extraAttempts: failedAttempts('booking-detail', 3, LINT_FAILURE) });
    h.state.snapshot = { ...later, tasks: later.tasks.map(item => item.id === 'booking-ui' ? { ...item, status: 'accepted' } : item) } as OrchestrationSnapshot;
    const repeat = await stuck(h);

    expect(repeat).toMatchObject({ outcome: 'escalated', escalation: 'repeat', turn: false });
    expect(h.turn).toHaveBeenCalledTimes(1);
    expect(h.retries).toHaveLength(1);
  });

  it('with autonomy off behaves exactly as today: no turn, no write, no retry', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix()], { autonomy: 'off' });
    h.recovery.reconcileSnapshot(h.state.snapshot);
    const before = JSON.stringify([...h.episodes.values()]);
    const milestonesBefore = h.milestones.length;

    expect(await h.resolver.resolveIfStuck(h.state.snapshot)).toBeUndefined();
    expect(h.plannerFor).not.toHaveBeenCalled();
    expect(h.turn).not.toHaveBeenCalled();
    expect(h.retries).toEqual([]);
    expect(JSON.stringify([...h.episodes.values()])).toBe(before);
    expect(h.milestones).toHaveLength(milestonesBefore);
  });

  it('in strict mode holds back a fix that changes an earlier task\'s accepted file', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix({
      expectedFiles: [{ repository: 'acme/shop-fe', path: 'src/BookingList.tsx' }]
    })], { autonomy: 'strict' });
    const accepted = h.state.snapshot;
    h.state.snapshot = { ...accepted, attempts: [...accepted.attempts, { id: 'list-accepted', runId: 'run-1', taskId: 'bookings-list', status: 'accepted',
      resultCommit: BASE, contextManifest: {}, createdAt: '2026-11-24T08:00:00.000Z', result: { acceptanceEvidence: { changedPaths: ['src/BookingList.tsx'] } } }],
      tasks: [...accepted.tasks, task({ id: 'bookings-list', status: 'accepted', dependsOn: [] })] } as OrchestrationSnapshot;
    const record = await stuck(h);

    expect(record).toMatchObject({ outcome: 'escalated', escalation: 'strict', tier: 1, proposedFix: expect.any(Object) });
    expect(h.retries).toEqual([]);
  });

  it('refuses a fix outside the task\'s repository or scope', async () => {
    const h = harness(snapshot({ reason: API_BLOCKER, attempts: 1 }), [fix({ expectedFiles: [{ repository: 'acme/shop-be', path: 'src/routes/bookings.ts' }] })]);
    expect(await stuck(h)).toMatchObject({ outcome: 'escalated', escalation: 'outside_scope' });
    expect(h.retries).toEqual([]);
  });

  it('records a retry that failed its checks once, and leaves the build to the person', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix()]);
    await stuck(h);
    failRetry(h);
    expect(resolutionOf(openEpisode(h))?.outcome).toBe('retrying');
    const followUp = await h.resolver.resolveIfStuck(h.state.snapshot);

    expect(followUp).toMatchObject({ outcome: 'retry_failed' });
    expect(openEpisode(h).phase).toBe('waiting_for_user');
    expect(await h.resolver.resolveIfStuck(h.state.snapshot)).toBeUndefined();
    expect(h.milestones.filter(item => item.key === 'orchestrator_resolution_failed')).toHaveLength(1);
    expect(h.turn).toHaveBeenCalledTimes(1);
  });

  it('escalates with the fix ready to apply when acceptance holds a retry that went out of bounds', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix()]);
    expect(await stuck(h)).toMatchObject({ outcome: 'retrying', priorChangedPaths: ['src/BookingList.tsx'] });
    const held = 'The Orchestrator\'s fix for this task changed src/auth/session.ts, beyond what Alpha may change on its own.';
    failRetry(h, held);
    h.state.snapshot = { ...h.state.snapshot, findings: [{ id: 'finding-held', runId: 'run-1', taskId: 'booking-ui', sourceTaskId: 'booking-ui',
      severity: 'blocking', status: 'open', createdAt: '2026-11-24T11:30:00.000Z', path: 'src/auth/session.ts',
      evidence: { check: 'orchestrator_fix_review', sensitivePaths: ['src/auth/session.ts'], outsidePaths: ['src/auth/session.ts'] } }] } as unknown as OrchestrationSnapshot;
    h.recovery.reconcileSnapshot(h.state.snapshot);

    const escalated = await h.resolver.resolveIfStuck(h.state.snapshot);
    expect(escalated).toMatchObject({ outcome: 'escalated', escalation: 'out_of_bounds', proposedFix: expect.any(Object),
      reasons: ['src/auth/session.ts is a sensitive area', 'src/auth/session.ts was not part of the fix'] });
    expect(h.milestones.find(item => item.key === 'orchestrator_escalation_out_of_bounds')?.content).toContain('src/auth/session.ts is a sensitive area');
    expect(h.recovery.explain(openEpisode(h))).toContain('Alpha has a verified fix ready for you to apply.');
    expect(h.turn).toHaveBeenCalledTimes(1);
  });

  it('stops at the cap of resolutions per build', async () => {
    const h = harness(snapshot({ reason: API_BLOCKER, attempts: 1 }), []);
    h.recovery.reconcileSnapshot(h.state.snapshot);
    const open = openEpisode(h);
    for (let index = 0; index < MAX_RESOLUTIONS_PER_BUILD; index += 1) {
      h.episodes.set(`earlier-${index}`, { ...open, id: `earlier-${index}`, phase: 'resolved', fingerprint: `other-${index}`,
        evidence: { resolution: { outcome: 'retry_accepted', fingerprint: `other-${index}`, turn: true, startedAt: '' } } });
    }
    h.episodes.delete(open.id);
    h.episodes.set(open.id, open);

    expect(await h.resolver.resolveIfStuck(h.state.snapshot)).toMatchObject({ outcome: 'escalated', escalation: 'budget', turn: false });
    expect(h.turn).not.toHaveBeenCalled();
  });

  it('does nothing when no planning agent is ready on this machine', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), [fix()]);
    h.plannerFor.mockResolvedValue(undefined);
    expect(await stuck(h)).toBeUndefined();
    expect(resolutionOf(openEpisode(h))).toBeUndefined();
    expect(h.turn).not.toHaveBeenCalled();
  });

  it('lets the person win a race: acting first supersedes the resolution', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), []);
    h.turn.mockImplementationOnce(async () => {
      // The person gives direction while the Orchestrator is thinking.
      const open = openEpisode(h);
      expect(resolutionOf(open)?.outcome).toBe('resolving');
      h.episodes.set(open.id, { ...open, guidance: 'Use the shared list component.', revision: open.revision + 1 });
      return { content: fix(), failureKind: null, failureDetail: null } as unknown as CliTurnResult;
    });
    expect(await stuck(h)).toBeUndefined();
    expect(h.retries).toEqual([]);
    expect(resolutionOf(openEpisode(h))?.outcome).toBe('superseded');
  });

  it('closes a resolution interrupted by a restart without retrying it', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), []);
    h.recovery.reconcileSnapshot(h.state.snapshot);
    const open = openEpisode(h);
    h.episodes.set(open.id, { ...open, evidence: { ...open.evidence, resolution: { outcome: 'resolving', fingerprint: open.fingerprint, turn: true, startedAt: '' } } });

    expect(h.resolver.markInterrupted(h.state.snapshot)).toMatchObject({ outcome: 'interrupted' });
    expect(openEpisode(h).phase).toBe('waiting_for_user');
    expect(h.milestones.map(item => item.key)).toContain('orchestrator_interrupted');
    expect(await h.resolver.resolveIfStuck(h.state.snapshot)).toBeUndefined();
    expect(h.turn).not.toHaveBeenCalled();
  });

  it('escalates when the Orchestrator\'s answer stays invalid after one format repair', async () => {
    const h = harness(snapshot({ reason: LINT_FAILURE, attempts: 3 }), ['not json', '{"outcome":"fix"}']);
    expect(await stuck(h)).toMatchObject({ outcome: 'escalated', escalation: 'unavailable', diagnosis: expect.stringContaining('invalid after one format repair') });
    expect(h.turn).toHaveBeenCalledTimes(2);
    expect(h.retries).toEqual([]);
  });
});
