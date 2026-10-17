import { describe, expect, it } from 'vitest';

import { DatabaseCommitError } from '../store/database.js';
import type {
  SavedTicketOperation, TicketChangeSignal, TicketCommandAudit, TicketCommandStore,
  TicketCommandTransaction, TicketOperationKey, TicketSubject, TicketWriteMode, TicketWorkBinding, TicketIssueCorrection,
} from '../store/ticketCommandStore.js';
import {
  newTicketWorkflow, type TicketActor, type TicketCommand, type TicketFacts, type TicketWorkflow,
} from '../ticketing/workflow.js';
import { createTicketCommandService } from './ticketCommandService.js';
import { ticketReadyManifest } from '../ticketing/technicalReadiness.js';
import type { TicketDeliveryAssessmentCandidate } from '../store/ticketDeliveryAssessmentStore.js';

const target = { workspaceId: 'workspace-a', ticketId: 'ticket-a' };
const pm: TicketSubject = { kind: 'internal', userId: 'pm-a', authentication: { kind: 'session', sessionId: 'session-pm' } };
const client: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'session-client' };
const developer: TicketSubject = { kind: 'internal', userId: 'dev-a', authentication: { kind: 'session', sessionId: 'session-dev' } };
const actors: Record<string, TicketActor> = {
  'pm-a': { kind: 'pm', userId: 'pm-a', workspaceId: target.workspaceId, membershipActive: true, canManageTickets: true },
  'client-a': { kind: 'client', userId: 'client-a', workspaceId: target.workspaceId, ticketId: target.ticketId, grantActive: true },
  'dev-a': { kind: 'developer', userId: 'dev-a', workspaceId: target.workspaceId },
};
const timestamp = '2026-10-08T03:00:00.000Z';
/** Explicit test-only registered bundle/readiness evidence for command cases.
 * Real adapters must load committed registration, scanner and readiness records.
 */
function assessmentCandidate(state: TicketWorkflow, facts: TicketFacts): TicketDeliveryAssessmentCandidate | null {
  const delivery = facts.delivery;
  if (!delivery) return null;
  return {
    facts, readiness: { key: { ...target, kind: 'technical_work_ready', actorId: 'dev-a', runId: 'run-test', completionId: 'completion-test', operationId: 'ready-test' },
      fingerprint: 'a'.repeat(64), manifest: ticketReadyManifest(state, facts),
      receipt: { ticketId: state.id, operationId: 'ready-test', version: state.version, status: 'in_progress' } },
    snapshot: { delivery: { ...target, ...delivery, issueRevisionIds: [...delivery.issueRevisionIds], clientVisible: true, publicSummary: 'Test-only reviewed result', sharedAt: null },
      manifest: { ...target, id: delivery.pinnedAssetId, scopeVersionId: delivery.scopeVersionId, issueRevisionIds: [...delivery.issueRevisionIds], immutable: true,
        files: [{ ...target, id: 'file-test', pinnedAssetId: delivery.pinnedAssetId, filename: 'result.txt', mediaType: 'text/plain', byteLength: 1,
          sha256: 'a'.repeat(64), immutable: true, clientVisible: true,
          scan: { verdict: 'clean', sha256: 'a'.repeat(64), policyVersion: 'scan-test', completedAt: timestamp }, object: { key: 'test-only-key', version: 'generation-test' } }] } },
  };
}
function operationKey(key: TicketOperationKey) {
  return JSON.stringify([key.workspaceId, key.ticketId, key.actorKind, key.actorId, key.operationId]);
}
function credentialId(subject: TicketSubject): string {
  if (subject.kind === 'client') return subject.sessionId;
  return subject.authentication.kind === 'session' ? subject.authentication.sessionId : subject.authentication.verificationId;
}

/** Test-only serialized transaction fixture, NOT a runtime/SQL adapter. Tests
 * application atomicity/idempotency; does not claim Postgres locks or RLS proof.
 */
function fixture() {
  let data = {
    state: newTicketWorkflow(target.ticketId, target.workspaceId, client.userId),
    operations: new Map<string, SavedTicketOperation>(),
    audits: [] as TicketCommandAudit[], signals: [] as TicketChangeSignal[], reopened: [] as string[],
    bindings: [] as TicketWorkBinding[],
    corrections: [] as TicketIssueCorrection[],
  };
  let queue = Promise.resolve();
  const control = {
    access: true, mode: 'enabled' as TicketWriteMode | undefined,
    sessions: new Map([pm, client, developer].map(subject => [credentialId(subject), subject])),
    verifiedBearers: new Map<string, TicketSubject>(),
    actors: structuredClone(actors), facts: {} as TicketFacts,
    wrongTicket: false, wrongActor: false, cas: true,
    failAt: '' as string, commitUnknown: false, calls: [] as string[],
    revisionId: undefined as string | undefined,
  };
  const store: TicketCommandStore = {
    async transaction<T>(work: (tx: TicketCommandTransaction) => Promise<T>) {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const draft = structuredClone(data);
      function step(name: string) {
        control.calls.push(name);
        if (control.failAt === name) throw new Error(`Injected ${name} failure`);
      }
      const tx: TicketCommandTransaction = {
        async lockAuthorizedTicket(requestTarget, subject) {
          step('authorize');
          const credentials = subject.kind === 'internal' && subject.authentication.kind === 'verified_github_bearer'
            ? control.verifiedBearers : control.sessions;
          const session = credentials.get(credentialId(subject));
          if (!control.access || !session || session.userId !== subject.userId || session.kind !== subject.kind
            || requestTarget.workspaceId !== draft.state.workspaceId || requestTarget.ticketId !== draft.state.id) return null;
          const actor = control.actors[subject.userId];
          if (!actor) return null;
          const state = structuredClone(draft.state);
          if (control.wrongTicket) state.id = 'wrong-ticket';
          return { state, actor: control.wrongActor ? actors['client-a'] : structuredClone(actor), mode: control.mode };
        },
        async findOperation(key) { step('find'); return structuredClone(draft.operations.get(operationKey(key)) ?? null); },
        async loadFacts() {
          step('facts'); const facts = structuredClone(control.facts);
          facts.issues = facts.issues?.map(issue => {
            const latest = draft.corrections.filter(row => row.issueId === issue.id).at(-1);
            return latest && issue.revisionId !== latest.issueRevisionId
              ? { ...issue, revisionId: latest.issueRevisionId, status: 'todo', requiredReviewsPassed: false } : issue;
          });
          return facts;
        },
        async loadAssessmentCandidate(ticket, deliveryId) {
          return control.facts.delivery?.id === deliveryId ? assessmentCandidate(ticket.state, structuredClone(control.facts)) : null;
        },
        async insertWorkBindings(bindings) {
          step('bindings');
          for (const binding of bindings) {
            if (draft.bindings.some(row => row.workspaceId === binding.workspaceId && row.issueId === binding.issueId)) {
              throw new Error('Issue already belongs to ticket work.');
            }
            draft.bindings.push(structuredClone(binding));
          }
        },
        async saveWorkflow(requestTarget, expected, state) {
          step('save');
          if (!control.cas || requestTarget.workspaceId !== draft.state.workspaceId || requestTarget.ticketId !== draft.state.id || expected !== draft.state.version) return false;
          draft.state = structuredClone(state); return true;
        },
        async reopenIssues(_ticket, corrections) {
          step('reopen'); draft.reopened.push(...corrections.map(row => row.issueId));
          draft.corrections.push(...structuredClone(corrections));
        },
        async appendAudit(audit) { step('audit'); draft.audits.push(structuredClone(audit)); },
        async enqueueChange(signal) { step('signal'); draft.signals.push(structuredClone(signal)); },
        async insertOperation(saved) {
          step('operation');
          const key = operationKey(saved.key);
          if (draft.operations.has(key)) throw new Error('Duplicate operation');
          draft.operations.set(key, structuredClone(saved));
        },
      };
      try {
        const result = await work(tx);
        data = draft;
        if (control.commitUnknown) {
          control.commitUnknown = false;
          throw new DatabaseCommitError(new Error('Injected lost COMMIT response'));
        }
        return result;
      } finally { release(); }
    },
  };
  let revisionCounter = 0;
  const service = createTicketCommandService(store, () => new Date(timestamp), () => control.revisionId ?? `correction-revision-${++revisionCounter}`,
    { maxFiles: 5, maxFileBytes: 1024, maxTotalBytes: 4096, objectReadTimeoutMs: 100 });
  const send = (command: TicketCommand, subject = pm, id = `op-${data.state.version}-${command.type}`) =>
    service.execute(target, subject, { schemaVersion: 1, operationId: id, expectedVersion: data.state.version, command });
  return {
    service, control, send,
    get data() { return data; },
    setState(state: TicketWorkflow) { data.state = structuredClone(state); },
  };
}

function evidence(): TicketFacts {
  return {
    clientAccessActive: true,
    scope: { id: 'scope-a', workspaceId: target.workspaceId, ticketId: target.ticketId },
    project: { id: 'project-a', workspaceId: target.workspaceId, creatorActive: true, nonProductionSafe: true },
    issues: ['a', 'b'].map(suffix => ({
      id: `issue-${suffix}`, revisionId: `revision-${suffix}`, ticketId: target.ticketId,
      workspaceId: target.workspaceId, projectId: 'project-a', scopeVersionId: 'scope-a',
      status: 'todo' as const, hasActiveRun: false, requiredReviewsPassed: false,
    })),
    delivery: { id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'asset-a', immutable: true, issueRevisionIds: ['revision-a', 'revision-b'] },
    workStopped: true,
  };
}
function completedEvidence(): TicketFacts {
  const facts = evidence();
  facts.issues = facts.issues!.map(item => ({ ...item, status: 'done', requiredReviewsPassed: true }));
  return facts;
}
async function agreed(f: ReturnType<typeof fixture>) {
  f.control.facts = evidence();
  await f.send({ type: 'review' });
  await f.send({ type: 'propose_scope', scopeVersionId: 'scope-a' });
  await f.send({ type: 'agree_scope', scopeVersionId: 'scope-a' }, client);
}
const handoff = { type: 'authorize_work' as const, scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'] };
async function working(f: ReturnType<typeof fixture>) {
  await agreed(f);
  await f.send(handoff);
  f.control.facts = completedEvidence();
}
async function shared(f: ReturnType<typeof fixture>) {
  await working(f);
  await f.send({ type: 'assess_delivery', deliveryId: 'delivery-a' });
  await f.send({ type: 'share_delivery', deliveryId: 'delivery-a' });
}
function request(expectedVersion = 0, operationId = 'same-op') {
  return { schemaVersion: 1, operationId, expectedVersion, command: { type: 'review' } };
}

describe('ticket command transaction service', () => {
  it('links existing Issues and authorizes the agreed work in one transaction', async () => {
    const f = fixture(); await agreed(f);
    f.control.calls = [];
    const receipt = await f.send(handoff, pm, 'handoff');
    expect(receipt).toEqual({ ticketId: target.ticketId, operationId: 'handoff', version: 4, status: 'in_progress' });
    expect(f.data.bindings).toEqual(['a', 'b'].map(suffix => ({
      ...target, projectId: 'project-a', issueId: `issue-${suffix}`, scopeVersionId: 'scope-a',
      issueRevisionId: `revision-${suffix}`, authorizedByPmId: pm.userId, authorizedAt: timestamp,
    })));
    expect(f.control.calls).toEqual(['authorize', 'find', 'facts', 'bindings', 'save', 'audit', 'signal', 'operation']);
    expect(f.data.reopened).toEqual([]);
    expect(Object.keys(receipt).sort()).toEqual(['operationId', 'status', 'ticketId', 'version']);
  });

  it.each(['bindings', 'save', 'audit', 'signal', 'operation'])('rolls back the entire initial handoff on %s failure', async stage => {
    const f = fixture(); await agreed(f);
    const before = structuredClone(f.data);
    f.control.failAt = stage;
    await expect(f.send(handoff)).rejects.toThrow(`Injected ${stage} failure`);
    expect(f.data).toEqual(before);
    f.control.failAt = '';
    await expect(f.send(handoff)).resolves.toMatchObject({ status: 'in_progress' });
    expect(f.data.bindings).toHaveLength(2);
  });

  it('rolls back candidate links if the ticket version CAS fails', async () => {
    const f = fixture(); await agreed(f);
    const before = structuredClone(f.data); f.control.cas = false;
    await expect(f.send(handoff)).rejects.toMatchObject({ code: 'ticket_version_conflict' });
    expect(f.data).toEqual(before);
  });

  it.each(['other-ticket', target.ticketId])('refuses to steal or overwrite an existing Issue binding for %s', async ticketId => {
    const f = fixture(); await agreed(f);
    // The second selected Issue conflicts, after the first tentative insert.
    f.data.bindings.push({ ...target, ticketId, projectId: 'project-a', issueId: 'issue-b',
      scopeVersionId: 'older-scope', issueRevisionId: 'older-revision', authorizedByPmId: 'other-pm', authorizedAt: timestamp });
    const before = structuredClone(f.data);
    await expect(f.send(handoff)).rejects.toThrow('Issue already belongs to ticket work.');
    expect(f.data).toEqual(before);
  });

  it.each(['wrong-workspace', 'wrong-project', 'wrong-scope', 'active-run', 'already-started'])('rejects %s before inserting any work links', async mismatch => {
    const f = fixture(); await agreed(f);
    const item = f.control.facts.issues![0];
    if (mismatch === 'wrong-workspace') item.workspaceId = 'other-workspace';
    if (mismatch === 'wrong-project') item.projectId = 'other-project';
    if (mismatch === 'wrong-scope') item.scopeVersionId = 'other-scope';
    if (mismatch === 'active-run') item.hasActiveRun = true;
    if (mismatch === 'already-started') item.status = 'agent_running';
    f.control.calls = [];
    await expect(f.send(handoff)).rejects.toMatchObject({ status: 409 });
    expect(f.control.calls).not.toContain('bindings');
    expect(f.data.bindings).toEqual([]);
    expect(f.data.state.version).toBe(3);
  });

  it('serializes duplicate handoffs without duplicating links or restarting work', async () => {
    const f = fixture(); await agreed(f);
    const input = { schemaVersion: 1, operationId: 'same-handoff', expectedVersion: 3, command: handoff };
    const results = await Promise.all(Array.from({ length: 5 }, () => f.service.execute(target, pm, input)));
    expect(results.every(result => result.version === 4)).toBe(true);
    expect(f.data.bindings).toHaveLength(2);
    expect(f.data.audits.filter(audit => audit.event.type === 'authorize_work')).toHaveLength(1);
  });

  it('reconciles a lost handoff commit without rebinding the Issues', async () => {
    const f = fixture(); await agreed(f);
    const input = { schemaVersion: 1, operationId: 'lost-handoff', expectedVersion: 3, command: handoff };
    f.control.commitUnknown = true;
    await expect(f.service.execute(target, pm, input)).rejects.toBeInstanceOf(DatabaseCommitError);
    expect(await f.service.lookup(target, pm, 'lost-handoff')).toMatchObject({ version: 4 });
    f.control.calls = [];
    expect(await f.service.execute(target, pm, input)).toMatchObject({ version: 4 });
    expect(f.control.calls).toEqual(['authorize', 'find']);
    expect(f.data.bindings).toHaveLength(2);
  });

  it('commits state, private audit, signal and saved safe outcome together', async () => {
    const f = fixture();
    const result = await f.service.execute(target, pm, request());
    expect(result).toEqual({ ticketId: target.ticketId, operationId: 'same-op', version: 1, status: 'under_review' });
    expect(f.data.audits).toHaveLength(1);
    expect(f.data.audits[0]).toMatchObject({ occurredAt: timestamp, envelope: request(), event: { fromVersion: 0, toVersion: 1 } });
    expect(f.data.signals).toEqual([{ key: f.data.audits[0].key, type: 'ticket_changed', version: 1, occurredAt: timestamp }]);
    expect(f.data.operations.size).toBe(1);
    expect(f.control.calls).toEqual(['authorize', 'find', 'facts', 'save', 'audit', 'signal', 'operation']);
  });

  it('replays the original receipt without rerunning facts or effects', async () => {
    const f = fixture();
    const first = await f.service.execute(target, pm, request());
    await f.send({ type: 'decline', reason: 'Not agreed' });
    f.control.calls = [];
    expect(await f.service.execute(target, pm, request())).toEqual(first);
    expect(f.data.state.status).toBe('declined');
    expect(f.data.audits).toHaveLength(2);
    expect(f.control.calls).toEqual(['authorize', 'find']);
  });

  it('canonicalizes object property order', async () => {
    const f = fixture();
    const first = await f.service.execute(target, pm, request());
    expect(await f.service.execute(target, pm, { command: { type: 'review' }, expectedVersion: 0, operationId: 'same-op', schemaVersion: 1 })).toEqual(first);
    expect(f.data.operations.size).toBe(1);
  });

  it('fingerprints normalized validated reasons, not raw whitespace', async () => {
    const f = fixture();
    const body = { ...request(), command: { type: 'decline', reason: '  Outside scope  ' } };
    const first = await f.service.execute(target, pm, body);
    expect(await f.service.execute(target, pm, { ...body, command: { type: 'decline', reason: 'Outside scope' } })).toEqual(first);
    expect(f.data.audits[0].envelope.command).toEqual({ type: 'decline', reason: 'Outside scope' });
  });

  it.each([
    { ...request(), command: { type: 'decline', reason: 'Different decision' } },
    request(1),
  ])('rejects changed content under an existing operation ID', async body => {
    const f = fixture();
    await f.service.execute(target, pm, request());
    await expect(f.service.execute(target, pm, body)).rejects.toMatchObject({ status: 409, code: 'ticket_operation_conflict' });
    expect(f.data.audits).toHaveLength(1);
  });

  it('serializes simultaneous duplicate submissions into one durable decision', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.service.execute(target, pm, request())));
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(f.data.state.version).toBe(1);
    expect(f.data.audits).toHaveLength(1);
    expect(f.data.signals).toHaveLength(1);
  });

  it('only one of two different commands can win the same version', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.service.execute(target, pm, request()),
      f.service.execute(target, pm, { ...request(0, 'other-op'), command: { type: 'decline', reason: 'No' } }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'ticket_version_conflict' } });
    expect(f.data.operations.size).toBe(1);
  });

  it('cannot replay or look up another PM’s operation with the same ID', async () => {
    const f = fixture();
    await f.service.execute(target, pm, request());
    const other: TicketSubject = { ...pm, userId: 'pm-b', authentication: { kind: 'session', sessionId: 'session-pm-b' } };
    f.control.sessions.set(credentialId(other), other);
    f.control.actors[other.userId] = { ...actors['pm-a'], userId: other.userId };
    expect(await f.service.lookup(target, other, 'same-op')).toBeNull();
    await expect(f.service.execute(target, other, request())).rejects.toMatchObject({ code: 'ticket_version_conflict' });
  });

  it.each(['access', 'session', 'membership', 'capability'])('rechecks %s before replay, lookup or parsing', async revoked => {
    const f = fixture();
    await f.service.execute(target, pm, request());
    if (revoked === 'access') f.control.access = false;
    if (revoked === 'session') f.control.sessions.delete(credentialId(pm));
    const actor = f.control.actors[pm.userId];
    if (actor.kind === 'pm' && revoked === 'membership') actor.membershipActive = false;
    if (actor.kind === 'pm' && revoked === 'capability') actor.canManageTickets = false;
    f.control.calls = [];
    for (const action of [
      () => f.service.execute(target, pm, request()),
      () => f.service.execute(target, pm, { invalid: true }),
      () => f.service.lookup(target, pm, 'same-op'),
    ]) await expect(action()).rejects.toMatchObject({ status: revoked === 'access' || revoked === 'session' ? 404 : 403 });
    expect(f.control.calls).toEqual(['authorize', 'authorize', 'authorize']);
  });

  it('rechecks the client grant before returning even their own saved outcome', async () => {
    const f = fixture();
    await working(f);
    const original = [...f.data.operations.values()].find(op => op.key.actorKind === 'client')!;
    const actor = f.control.actors[client.userId];
    if (actor.kind === 'client') actor.grantActive = false;
    await expect(f.service.execute(target, client, f.data.audits[2].envelope)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.lookup(target, client, original.key.operationId)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses developers before revealing input validation details', async () => {
    const f = fixture();
    await expect(f.service.execute(target, developer, null)).rejects.toMatchObject({ status: 403 });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('does not accept another identity’s persisted session, even with a valid user ID', async () => {
    const f = fixture();
    await expect(f.service.execute(target, { ...pm, authentication: { kind: 'session', sessionId: client.sessionId } }, request())).rejects.toMatchObject({ status: 404 });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('preserves verified desktop GitHub bearer access without manufacturing a persisted session', async () => {
    const f = fixture();
    const bearer: TicketSubject = { kind: 'internal', userId: pm.userId, authentication: { kind: 'verified_github_bearer', verificationId: 'verified-request-a' } };
    f.control.sessions.clear();
    f.control.verifiedBearers.set(credentialId(bearer), bearer);
    expect(await f.service.execute(target, bearer, request())).toMatchObject({ version: 1 });
    f.control.verifiedBearers.clear();
    await expect(f.service.lookup(target, bearer, 'same-op')).rejects.toMatchObject({ status: 404 });
  });

  it('reconciles an operation across web-session and desktop-bearer auth only for the same verified internal identity', async () => {
    const f = fixture();
    const first = await f.service.execute(target, pm, request());
    const bearer: TicketSubject = { kind: 'internal', userId: pm.userId, authentication: { kind: 'verified_github_bearer', verificationId: 'verified-request-a' } };
    f.control.verifiedBearers.set(credentialId(bearer), bearer);
    expect(await f.service.lookup(target, bearer, 'same-op')).toEqual(first);
    expect(await f.service.execute(target, bearer, request())).toEqual(first);
    expect(f.data.audits).toHaveLength(1);
  });

  it.each(['workspace', 'ticket', 'adapter-ticket', 'adapter-actor', 'identity-namespace'])('rejects %s mismatches', async mismatch => {
    const f = fixture();
    const otherTarget = { ...target };
    let subject = pm;
    if (mismatch === 'workspace') otherTarget.workspaceId = 'workspace-b';
    if (mismatch === 'ticket') otherTarget.ticketId = 'ticket-b';
    if (mismatch === 'adapter-ticket') f.control.wrongTicket = true;
    if (mismatch === 'adapter-actor') f.control.wrongActor = true;
    if (mismatch === 'identity-namespace') subject = { kind: 'internal', userId: client.userId, authentication: { kind: 'session', sessionId: client.sessionId } };
    await expect(f.service.execute(otherTarget, subject, request())).rejects.toMatchObject({ status: 404 });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it.each(['facts', 'actor', 'status'])('refuses caller-supplied %s rather than trusting it', async field => {
    const f = fixture();
    await expect(f.service.execute(target, pm, { ...request(), [field]: 'forged' })).rejects.toMatchObject({ status: 400 });
    expect(f.control.calls).toEqual(['authorize']);
    expect(f.data.state.version).toBe(0);
  });

  it.each([undefined, 'disabled'] as const)('defaults to disabled and writes nothing for mode %s', async mode => {
    const f = fixture(); f.control.mode = mode;
    await expect(f.service.execute(target, pm, request())).rejects.toMatchObject({ status: 503 });
    expect(f.data.operations.size).toBe(0);
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('stops command replay when disabled, but permits authorized reconciliation', async () => {
    const f = fixture();
    const first = await f.service.execute(target, pm, request());
    f.control.mode = 'disabled';
    await expect(f.service.execute(target, pm, request())).rejects.toMatchObject({ status: 503 });
    expect(await f.service.lookup(target, pm, 'same-op')).toEqual(first);
  });

  it('allows only safe PM cancellation in maintenance mode', async () => {
    const f = fixture(); f.control.mode = 'maintenance'; f.control.facts.workStopped = true;
    await expect(f.service.execute(target, pm, request())).rejects.toMatchObject({ status: 503 });
    expect(await f.send({ type: 'cancel', reason: 'Maintenance cancellation' })).toMatchObject({ status: 'cancelled', version: 1 });
  });

  it.each(['facts', 'save', 'audit', 'signal', 'operation'])('rolls back all effects on %s failure', async stage => {
    const f = fixture(); f.control.failAt = stage;
    await expect(f.service.execute(target, pm, request())).rejects.toThrow(`Injected ${stage} failure`);
    expect(f.data.state.version).toBe(0);
    expect(f.data.audits).toEqual([]);
    expect(f.data.signals).toEqual([]);
    expect(f.data.operations.size).toBe(0);
    f.control.failAt = '';
    expect(await f.service.execute(target, pm, request())).toMatchObject({ version: 1 });
  });

  it('rolls back when the compare-and-swap loses', async () => {
    const f = fixture(); f.control.cas = false;
    await expect(f.service.execute(target, pm, request())).rejects.toMatchObject({ status: 409, code: 'ticket_version_conflict' });
    expect(f.data.audits).toEqual([]); expect(f.data.operations.size).toBe(0);
  });

  it('propagates an unknown commit without retrying; lookup finds the durable outcome', async () => {
    const f = fixture(); f.control.commitUnknown = true;
    await expect(f.service.execute(target, pm, request())).rejects.toBeInstanceOf(DatabaseCommitError);
    expect(f.data.audits).toHaveLength(1);
    expect(f.control.calls.filter(call => call === 'save')).toHaveLength(1);
    expect(await f.service.lookup(target, pm, 'same-op')).toMatchObject({ version: 1 });
    expect(await f.service.execute(target, pm, request())).toMatchObject({ version: 1 });
    expect(f.data.audits).toHaveLength(1);
  });

  it('does not silently retry an unacknowledged outcome that cannot be found', async () => {
    const f = fixture();
    expect(await f.service.lookup(target, pm, 'missing')).toBeNull();
    expect(f.data.state.version).toBe(0);
  });

  it.each(['', ' space ', 'x'.repeat(201)])('validates lookup IDs only after access checks', async id => {
    const f = fixture();
    await expect(f.service.lookup(target, pm, id)).rejects.toMatchObject({ status: 400 });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('keeps agreement, work authorization, PM assessment, sharing, acceptance and closure separate', async () => {
    const f = fixture();
    await shared(f);
    await expect(f.send({ type: 'close_accepted', deliveryId: 'delivery-a' })).rejects.toMatchObject({ code: 'client_acceptance_required' });
    const acceptance = await f.send({ type: 'accept_delivery', deliveryId: 'delivery-a' }, client);
    expect(acceptance.status).toBe('ready_for_review');
    expect(Object.keys(acceptance).sort()).toEqual(['operationId', 'status', 'ticketId', 'version']);
    expect(await f.send({ type: 'close_accepted', deliveryId: 'delivery-a' })).toMatchObject({ status: 'closed' });
    expect(f.data.audits.map(audit => audit.event.type)).toEqual([
      'review', 'propose_scope', 'agree_scope', 'authorize_work', 'assess_delivery', 'share_delivery', 'accept_delivery', 'close_accepted',
    ]);
    expect(f.data.state).not.toHaveProperty('projectCompleted');
    expect(f.data.state).not.toHaveProperty('releaseAuthorized');
    expect(f.data.reopened).toEqual([]);
  });

  it('client feedback preserves delivery history and reopens only affected Issues after PM approval', async () => {
    const f = fixture(); await shared(f);
    f.control.facts.message = { id: 'message-a', ticketId: target.ticketId, authorId: client.userId, audience: 'client' };
    await f.send({ type: 'request_correction', deliveryId: 'delivery-a', messageId: 'message-a' }, client);
    expect(f.data.reopened).toEqual([]);
    const assessedAudit = structuredClone(f.data.audits[4]);
    await f.send({ type: 'authorize_correction', deliveryId: 'delivery-a', issueIds: ['issue-a'], reason: 'Fix the approved behavior, without adding extra scope.' });
    expect(f.data.reopened).toEqual(['issue-a']);
    expect(f.data.state).toMatchObject({ status: 'in_progress', requiredIssueIds: ['issue-a', 'issue-b'], delivery: null });
    expect(f.data.audits[4]).toEqual(assessedAudit);
    expect(f.data.corrections).toEqual([{
      ...target, projectId: 'project-a', issueId: 'issue-a', scopeVersionId: 'scope-a',
      previousRevisionId: 'revision-a', issueRevisionId: 'correction-revision-1',
      developerInstructions: 'Fix the approved behavior, without adding extra scope.', source: 'authorize_correction',
      immutable: true, authorizedByPmId: pm.userId, authorizedAt: timestamp,
    }]);
  });

  it('pins the PM fix brief to a new affected revision without changing the original binding or unrelated Issues', async () => {
    const f = fixture(); await working(f);
    const originalBindings = structuredClone(f.data.bindings);
    await f.send({ type: 'request_fixes', issueIds: ['issue-b'], reason: '  Correct the validation error.  ' });
    expect(f.data.bindings).toEqual(originalBindings);
    expect(f.data.reopened).toEqual(['issue-b']);
    expect(f.data.corrections).toEqual([{
      ...target, projectId: 'project-a', issueId: 'issue-b', scopeVersionId: 'scope-a', previousRevisionId: 'revision-b',
      issueRevisionId: 'correction-revision-1', developerInstructions: 'Correct the validation error.',
      source: 'request_fixes', immutable: true, authorizedByPmId: pm.userId, authorizedAt: timestamp,
    }]);
    expect(f.data.state.requiredIssueIds).toEqual(['issue-a', 'issue-b']);
    expect(f.data.state.delivery).toBeNull();
  });

  it('replays a correction once and refuses a fresh operation that would reset already-queued corrected work', async () => {
    const f = fixture(); await working(f);
    const input = { schemaVersion: 1, expectedVersion: f.data.state.version, operationId: 'fix-once',
      command: { type: 'request_fixes', issueIds: ['issue-b'], reason: 'Correct validation.' } };
    const first = await f.service.execute(target, pm, input);
    expect(await f.service.execute(target, pm, input)).toEqual(first);
    await expect(f.send({ type: 'request_fixes', issueIds: ['issue-b'], reason: 'Correct validation.' }, pm, 'new-reset'))
      .rejects.toMatchObject({ code: 'ticket_correction_not_ready' });
    expect(f.data.corrections).toHaveLength(1);
  });

  it.each(['', ' bad ', 'revision-a', 'x'.repeat(201)])('rolls back invalid/generated duplicate correction revision %s', async revisionId => {
    const f = fixture(); await working(f); const before = structuredClone(f.data); f.control.revisionId = revisionId;
    await expect(f.send({ type: 'request_fixes', issueIds: ['issue-b'], reason: 'Correct validation.' })).rejects.toThrow('correction revision');
    expect(f.data).toEqual(before);
  });

  it('rejects a generator collision between two affected correction revisions', async () => {
    const f = fixture(); await working(f); const before = structuredClone(f.data); f.control.revisionId = 'new-but-repeated';
    await expect(f.send({ type: 'request_fixes', issueIds: ['issue-a', 'issue-b'], reason: 'Correct validation.' })).rejects.toThrow('correction revision');
    expect(f.data).toEqual(before);
  });

  it('recovers an unknown correction commit without issuing a second revision', async () => {
    const f = fixture(); await working(f);
    const input = { schemaVersion: 1, expectedVersion: f.data.state.version, operationId: 'lost-fix',
      command: { type: 'request_fixes', issueIds: ['issue-b'], reason: 'Correct validation.' } };
    f.control.commitUnknown = true;
    await expect(f.service.execute(target, pm, input)).rejects.toBeInstanceOf(DatabaseCommitError);
    expect(await f.service.lookup(target, pm, 'lost-fix')).toMatchObject({ status: 'in_progress' });
    await f.service.execute(target, pm, input);
    expect(f.data.corrections).toHaveLength(1);
  });

  it.each(['reopen', 'signal', 'operation'])('rolls back correction and reopened Issues on %s failure', async stage => {
    const f = fixture(); await working(f);
    const before = structuredClone(f.data);
    f.control.failAt = stage;
    await expect(f.send({ type: 'request_fixes', issueIds: ['issue-b'], reason: 'Fix agreed behavior' })).rejects.toThrow();
    expect(f.data).toEqual(before);
  });

  it('uses fresh trusted evidence, rejecting wrong-workspace Issue rows', async () => {
    const f = fixture(); await working(f);
    f.control.facts.issues![0].workspaceId = 'workspace-b';
    const version = f.data.state.version;
    await expect(f.send({ type: 'request_fixes', issueIds: ['issue-a'], reason: 'Fix' })).rejects.toMatchObject({ code: 'ticket_manifest_conflict' });
    expect(f.data.state.version).toBe(version);
    expect(f.data.reopened).toEqual([]);
  });

  it('allows no internal message to fulfill a public reply', async () => {
    const f = fixture(); await f.send({ type: 'review' });
    f.control.facts.message = { id: 'private-note', ticketId: target.ticketId, authorId: pm.userId, audience: 'internal' };
    await expect(f.send({ type: 'reply', messageId: 'private-note' })).rejects.toMatchObject({ code: 'public_message_required' });
    expect(f.data.audits).toHaveLength(1);
  });

  it('returns only allowlisted receipt fields, even if a persisted row contains internal data', async () => {
    const f = fixture(); await f.service.execute(target, pm, request());
    const saved = [...f.data.operations.values()][0];
    Object.assign(saved.receipt, { projectId: 'secret-project', internalNote: 'private', assetId: 'asset-secret' });
    const result = await f.service.lookup(target, pm, 'same-op');
    expect(Object.keys(result!).sort()).toEqual(['operationId', 'status', 'ticketId', 'version']);
    result!.version = 100;
    expect((await f.service.lookup(target, pm, 'same-op'))!.version).toBe(1);
  });

  it('fails closed on a mis-scoped saved operation', async () => {
    const f = fixture(); await f.service.execute(target, pm, request());
    [...f.data.operations.values()][0].key.workspaceId = 'workspace-b';
    await expect(f.service.lookup(target, pm, 'same-op')).rejects.toThrow('mismatched record');
  });
});
