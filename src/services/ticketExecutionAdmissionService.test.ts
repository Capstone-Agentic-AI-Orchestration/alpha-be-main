import { describe, expect, it } from 'vitest';

import type { TicketSubject } from '../store/ticketCommandStore.js';
import type {
  LockedTicketIssue, SavedTicketAdmission, TicketAdmissionKey, TicketExecutionAdmissionStore,
  TicketExecutionAdmissionTransaction, TicketExecutionClaim, TicketRunAdmissionSubject,
} from '../store/ticketExecutionAdmissionStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { createTicketExecutionAdmissionService } from './ticketExecutionAdmissionService.js';

const target = { workspaceId: 'workspace-a', issueId: 'issue-a' };
const subject: TicketSubject = { kind: 'internal', userId: 'dev-a', authentication: { kind: 'session', sessionId: 'session-a' } };
const worker: TicketRunAdmissionSubject = { kind: 'verified_run_admission', verificationId: 'verified-worker-a' };
const executor = { kind: 'agent' as const, id: 'agent-a' };
const input = { schemaVersion: 1, operationId: 'reserve-a', expectedRevisionId: 'revision-a', executor };
const keyId = (key: TicketAdmissionKey) => JSON.stringify([key.workspaceId, key.issueId, key.actorId, key.operationId]);

function linkedIssue(): Extract<LockedTicketIssue, { kind: 'ticket' }> {
  const state = { ...newTicketWorkflow('ticket-a', target.workspaceId, 'client-a'),
    version: 4, status: 'in_progress' as const, projectId: 'project-a', scopeVersionId: 'scope-a',
    agreedScopeVersionId: 'scope-a', authorizedScopeVersionId: 'scope-a', requiredIssueIds: [target.issueId],
    actionOwner: 'developer' as const, nextAction: 'execute_work' as const };
  return { kind: 'ticket', clientAccessActive: true, projectCreatorActive: true, mode: 'enabled', executor: { ...executor, active: true, allowed: true }, snapshot: {
    workspaceId: target.workspaceId,
    developerProjectAccessActive: true,
    issue: { id: target.issueId, workspaceId: target.workspaceId, projectId: 'project-a', ticketId: 'ticket-a',
      revisionId: 'revision-a', initialRevisionId: 'revision-a', status: 'todo' },
    project: { id: 'project-a', workspaceId: target.workspaceId, nonProductionSafe: true },
    ticket: { id: 'ticket-a', workspaceId: target.workspaceId, reference: 'TCK-A', state },
    scope: { id: 'scope-a', ticketId: 'ticket-a', workspaceId: target.workspaceId, developerBrief: 'Approved implementation only.', immutable: true, clientAgreed: true },
    correction: null,
  } };
}
/** TEST ONLY: serialized rollback fixture. No runtime store or external I/O. */
function fixture() {
  const control = { issue: linkedIssue() as LockedTicketIssue, access: true, workerAccess: true, failAt: '',
    cas: true, commitUnknown: false, runId: 'run-a', claimId: 'claim-1', calls: [] as string[] };
  let data = { claims: [] as TicketExecutionClaim[], operations: new Map<string, SavedTicketAdmission>(),
    audits: [] as Parameters<TicketExecutionAdmissionTransaction['appendAudit']>[0][] };
  let queue = Promise.resolve(); let sequence = 0;
  const store: TicketExecutionAdmissionStore = {
    async transaction<T>(work: (tx: TicketExecutionAdmissionTransaction) => Promise<T>) {
      const previous = queue; let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; }); await previous;
      const draft = structuredClone(data);
      function step(name: string) { control.calls.push(name); if (control.failAt === name) throw new Error(`Injected ${name}`); }
      const tx: TicketExecutionAdmissionTransaction = {
        async lockAuthorizedIssue(owner, identity) {
          step('authorize');
          if (!control.access || owner.workspaceId !== target.workspaceId || owner.issueId !== target.issueId
            || identity.kind !== 'internal' || identity.userId !== subject.userId
            || identity.authentication.kind !== 'session' || identity.authentication.sessionId !== 'session-a') return null;
          return structuredClone(control.issue);
        },
        async lockVerifiedRun(owner, identity) {
          step('worker');
          if (!control.access || !control.workerAccess || owner.workspaceId !== target.workspaceId || owner.issueId !== target.issueId
            || identity.verificationId !== worker.verificationId || control.issue.kind !== 'ticket') return null;
          return { issue: structuredClone(control.issue), claimId: control.claimId, runId: control.runId, developerId: subject.userId,
            executor: { kind: control.issue.executor.kind, id: control.issue.executor.id } };
        },
        async findOperation(key) { step('find'); return structuredClone(draft.operations.get(keyId(key)) ?? null); },
        async findActiveClaim(owner) { step('active'); return structuredClone(draft.claims.find(claim => claim.workspaceId === owner.workspaceId && claim.issueId === owner.issueId && claim.phase !== 'stopped') ?? null); },
        async insertClaim(claim) {
          step('insert');
          if (draft.claims.some(value => value.id === claim.id || (value.workspaceId === claim.workspaceId && value.issueId === claim.issueId && value.phase !== 'stopped'))) throw new Error('Duplicate active Issue claim');
          draft.claims.push(structuredClone(claim));
        },
        async admitClaim(claim, runId) {
          step('admit');
          const row = draft.claims.find(value => value.id === claim.id);
          if (!control.cas || !row || row.phase !== 'reserved' || row.runId !== null) return false;
          row.phase = 'admitted'; row.runId = runId; return true;
        },
        async appendAudit(audit) { step('audit'); draft.audits.push(structuredClone(audit)); },
        async insertOperation(operation) {
          step('operation'); if (draft.operations.has(keyId(operation.key))) throw new Error('Duplicate operation');
          draft.operations.set(keyId(operation.key), structuredClone(operation));
        },
      };
      try {
        const value = await work(tx); data = draft;
        if (control.commitUnknown) { control.commitUnknown = false; throw new Error('Unknown COMMIT outcome'); }
        return value;
      } finally { release(); }
    },
  };
  return { control, store, data: () => data, linked: () => control.issue as Extract<LockedTicketIssue, { kind: 'ticket' }>,
    service: createTicketExecutionAdmissionService(store, () => new Date('2026-10-08T14:00:00Z'), () => `claim-${++sequence}`) };
}

describe('ticket execution reservation and queue-front admission', () => {
  it('atomically reserves current work without changing the ticket or starting any runner', async () => {
    const f = fixture(); const initial = structuredClone(f.control.issue);
    const result = await f.service.reserve(target, subject, input);
    expect(result).toEqual({ kind: 'ticket', receipt: { ...target, operationId: input.operationId, claimId: 'claim-1', issueRevisionId: 'revision-a' } });
    expect(f.control.issue).toEqual(initial); expect(f.data().claims).toHaveLength(1); expect(f.data().audits).toHaveLength(1);
    expect(f.data().claims[0]).toMatchObject({ phase: 'reserved', runId: null });
    expect(result).not.toHaveProperty('brief');
  });
  it('admits one verified run only once and returns only the approved developer context', async () => {
    const f = fixture(); await f.service.reserve(target, subject, input);
    Object.assign(f.linked().snapshot.scope, { privateNote: 'never pass to runner', clientEmail: 'private@example.test' });
    const first = await f.service.admit(target, worker);
    expect(first.newlyAdmitted).toBe(true); expect(first.context.brief).toBe('Approved implementation only.');
    expect(first.context).not.toHaveProperty('privateNote'); expect(first.context).not.toHaveProperty('clientEmail');
    const replay = await f.service.admit(target, worker); expect(replay.newlyAdmitted).toBe(false);
    expect(f.data().audits).toHaveLength(2); expect(f.data().claims[0]).toMatchObject({ phase: 'admitted', runId: 'run-a' });
  });
  it('replays a reservation without a second claim and rejects different reuse of its operation ID', async () => {
    const f = fixture(); const first = await f.service.reserve(target, subject, input);
    await expect(f.service.reserve(target, subject, input)).resolves.toEqual(first);
    await expect(f.service.reserve(target, subject, { ...input, expectedRevisionId: 'revision-other' })).rejects.toMatchObject({ code: 'ticket_operation_conflict' });
    expect(f.data().claims).toHaveLength(1);
  });
  it('recovers an unknown reservation commit without blindly creating another run', async () => {
    const f = fixture(); f.control.commitUnknown = true;
    await expect(f.service.reserve(target, subject, input)).rejects.toThrow('Unknown COMMIT');
    await expect(f.service.lookup(target, subject, input.operationId)).resolves.toMatchObject({ claimId: 'claim-1' });
    await f.service.reserve(target, subject, input); expect(f.data().claims).toHaveLength(1);
  });
  it('reports prior admission after an unknown commit without permitting another spawn', async () => {
    const f = fixture(); await f.service.reserve(target, subject, input); f.control.commitUnknown = true;
    await expect(f.service.admit(target, worker)).rejects.toThrow('Unknown COMMIT');
    await expect(f.service.admit(target, worker)).resolves.toMatchObject({ newlyAdmitted: false });
    expect(f.data().audits).toHaveLength(2);
  });
  it('serializes concurrent identical reservations and rejects a second operation', async () => {
    const f = fixture();
    const results = await Promise.all([f.service.reserve(target, subject, input), f.service.reserve(target, subject, input)]);
    expect(results[0]).toEqual(results[1]);
    await expect(f.service.reserve(target, subject, { ...input, operationId: 'reserve-b' })).rejects.toMatchObject({ code: 'ticket_execution_conflict' });
    expect(f.data().claims).toHaveLength(1);
  });
  it.each(['insert', 'audit', 'operation'])('rolls back reservation on %s failure', async failAt => {
    const f = fixture(); f.control.failAt = failAt;
    await expect(f.service.reserve(target, subject, input)).rejects.toThrow('Injected');
    expect(f.data().claims).toHaveLength(0); expect(f.data().audits).toHaveLength(0); expect(f.data().operations.size).toBe(0);
  });
  it.each(['cas', 'audit'])('rolls back queue admission on %s failure', async failAt => {
    const f = fixture(); await f.service.reserve(target, subject, input);
    if (failAt === 'cas') f.control.cas = false; else f.control.failAt = failAt;
    await expect(f.service.admit(target, worker)).rejects.toThrow();
    expect(f.data().claims[0]).toMatchObject({ phase: 'reserved', runId: null }); expect(f.data().audits).toHaveLength(1);
  });
  it.each(['disabled', 'maintenance', undefined] as const)('fails closed in %s mode, including at queue-front', async mode => {
    const f = fixture(); await f.service.reserve(target, subject, input); f.linked().mode = mode;
    await expect(f.service.admit(target, worker)).rejects.toMatchObject({ status: 503 });
    await expect(f.service.reserve(target, subject, { ...input, operationId: 'new-operation' })).rejects.toMatchObject({ status: 503 });
    await expect(f.service.lookup(target, subject, input.operationId)).resolves.toMatchObject({ claimId: 'claim-1' });
  });
  it.each(['hold', 'withdrawal', 'cancelled', 'closed', 'client-revoked', 'creator-inactive', 'unsafe-project', 'unagreed', 'project-access-revoked', 'executor-revoked', 'scope-changed', 'revision-changed', 'reviewed'])('rechecks %s after queue wait', async condition => {
    const f = fixture(); await f.service.reserve(target, subject, input); const value = f.linked(); const state = value.snapshot.ticket.state;
    if (condition === 'hold') state.status = 'on_hold';
    if (condition === 'withdrawal') state.withdrawalRequested = true;
    if (condition === 'cancelled') state.status = 'cancelled';
    if (condition === 'closed') state.status = 'closed';
    if (condition === 'client-revoked') value.clientAccessActive = false;
    if (condition === 'creator-inactive') value.projectCreatorActive = false;
    if (condition === 'unsafe-project') value.snapshot.project.nonProductionSafe = false;
    if (condition === 'unagreed') state.agreedScopeVersionId = null;
    if (condition === 'project-access-revoked') value.snapshot.developerProjectAccessActive = false;
    if (condition === 'executor-revoked') value.executor.allowed = false;
    if (condition === 'scope-changed') state.authorizedScopeVersionId = 'scope-other';
    if (condition === 'revision-changed') { value.snapshot.issue.revisionId = 'revision-new'; value.snapshot.issue.initialRevisionId = 'revision-new'; }
    if (condition === 'reviewed') value.snapshot.issue.status = 'done';
    await expect(f.service.admit(target, worker)).rejects.toThrow();
    expect(f.data().claims[0].phase).toBe('reserved'); expect(f.data().audits).toHaveLength(1);
  });
  it.each(['pm', 'client'] as const)('does not revoke approved work just because conversation is routed to %s', async owner => {
    const f = fixture(); await f.service.reserve(target, subject, input);
    f.linked().snapshot.ticket.state.actionOwner = owner; f.linked().snapshot.ticket.state.nextAction = 'reply';
    f.linked().snapshot.ticket.state.version += 1;
    await expect(f.service.admit(target, worker)).resolves.toMatchObject({ newlyAdmitted: true });
  });
  it.each(['in_progress', 'agent_running', 'done', 'review', 'backlog'] as const)('does not use %s status as permission for a new reservation', async status => {
    const f = fixture(); f.linked().snapshot.issue.status = status;
    await expect(f.service.reserve(target, subject, input)).rejects.toThrow(); expect(f.data().claims).toHaveLength(0);
  });
  it('keeps an exact correction brief and refuses a previous revision request', async () => {
    const f = fixture(); const value = f.linked(); value.snapshot.issue.revisionId = 'revision-b';
    value.snapshot.correction = { ...target, ticketId: 'ticket-a', projectId: 'project-a', scopeVersionId: 'scope-a',
      issueRevisionId: 'revision-b', previousRevisionId: 'revision-a', authorizedByPmId: 'pm-a', authorizedAt: '2026-10-08T13:00:00Z',
      immutable: true, source: 'request_fixes', developerInstructions: 'Fix validation, not the unrelated page.' };
    await expect(f.service.reserve(target, subject, input)).rejects.toMatchObject({ status: 409 });
    await f.service.reserve(target, subject, { ...input, expectedRevisionId: 'revision-b' });
    await expect(f.service.admit(target, worker)).resolves.toMatchObject({ context: { issueRevisionId: 'revision-b', correction: { instructions: value.snapshot.correction.developerInstructions } } });
  });
  it('refuses stale active claims even after the revision changes', async () => {
    const f = fixture(); await f.service.reserve(target, subject, input);
    const value = f.linked(); value.snapshot.issue.revisionId = 'revision-b'; value.snapshot.issue.initialRevisionId = 'revision-b';
    await expect(f.service.reserve(target, subject, { ...input, expectedRevisionId: 'revision-b', operationId: 'new-revision' })).rejects.toMatchObject({ code: 'ticket_execution_conflict' });
  });
  it('refuses a new squad claim now that squads were removed', async () => {
    const f = fixture(); f.linked().executor = { kind: 'squad', id: 'squad-a', active: true, allowed: true };
    await expect(f.service.reserve(target, subject, { ...input, executor: { kind: 'squad', id: 'squad-a' } as any })).rejects.toMatchObject({ status: 400 });
    expect(f.data().claims).toHaveLength(0);
  });
  it.each(['workspace', 'issue', 'identity', 'client', 'revoked'])('refuses %s authority before reading operations', async condition => {
    const f = fixture(); let owner = target; let identity: TicketSubject = subject;
    if (condition === 'workspace') owner = { ...target, workspaceId: 'other' };
    if (condition === 'issue') owner = { ...target, issueId: 'other' };
    if (condition === 'identity') identity = { ...subject, userId: 'other' };
    if (condition === 'client') identity = { kind: 'client', userId: 'client-a', sessionId: 'client-session' };
    if (condition === 'revoked') f.control.access = false;
    await expect(f.service.reserve(owner, identity, input)).rejects.toMatchObject({ status: 404 }); expect(f.control.calls).not.toContain('find');
  });
  it('does not recover operations after membership revocation', async () => {
    const f = fixture(); await f.service.reserve(target, subject, input); f.control.access = false;
    await expect(f.service.lookup(target, subject, input.operationId)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.admit(target, worker)).rejects.toMatchObject({ status: 404 });
  });
  it('refuses a guessed worker verification reference or different persisted run', async () => {
    const f = fixture(); await f.service.reserve(target, subject, input);
    await expect(f.service.admit(target, { ...worker, verificationId: 'guessed' })).rejects.toMatchObject({ status: 404 });
    await f.service.admit(target, worker); f.control.runId = 'run-other';
    await expect(f.service.admit(target, worker)).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ ...input, facts: {} }, { ...input, actorId: 'pm-a' }, { ...input, expectedRevisionId: ' ' }, { ...input, executor: { ...executor, allowed: true } }])('rejects caller-owned authority or malformed input %#', async value => {
    const f = fixture(); await expect(f.service.reserve(target, subject, value)).rejects.toMatchObject({ status: 400 }); expect(f.data().claims).toHaveLength(0);
  });
  it('positively identifies an authorized unlinked Issue without writing ticket claims or operations', async () => {
    const f = fixture(); f.control.issue = { kind: 'unlinked', ...target, developerId: subject.userId };
    await expect(f.service.reserve(target, subject, input)).resolves.toEqual({ kind: 'unlinked' });
    expect(f.control.calls).toEqual(['authorize']); expect(f.data().claims).toHaveLength(0);
  });
  it('never falls back to legacy execution after an unavailable ticket store', async () => {
    const f = fixture(); f.control.failAt = 'authorize';
    await expect(f.service.reserve(target, subject, input)).rejects.toThrow('Injected'); expect(f.data().claims).toHaveLength(0);
  });
  it('serializes concurrent admissions with only one new admission', async () => {
    const f = fixture(); await f.service.reserve(target, subject, input);
    const results = await Promise.all([f.service.admit(target, worker), f.service.admit(target, worker)]);
    expect(results.map(value => value.newlyAdmitted)).toEqual([true, false]); expect(f.data().audits).toHaveLength(2);
  });
  it.each(['ticketId', 'projectId', 'scopeVersionId', 'issueRevisionId', 'developerId'] as const)('rejects a claim with mismatched %s', async field => {
    const f = fixture(); await f.service.reserve(target, subject, input); f.data().claims[0][field] = 'other';
    await expect(f.service.admit(target, worker)).rejects.toMatchObject({ code: 'ticket_execution_conflict' });
  });
  it('refuses a stopped claim or a missing claim; an old receipt is not start permission', async () => {
    const f = fixture(); await f.service.reserve(target, subject, input); f.data().claims[0].phase = 'stopped';
    await expect(f.service.admit(target, worker)).rejects.toMatchObject({ code: 'ticket_execution_conflict' });
    await expect(f.service.lookup(target, subject, input.operationId)).resolves.toMatchObject({ claimId: 'claim-1' });
  });
  it('never returns a prepared result as new execution context', async () => {
    const f = fixture(); const state = f.linked().snapshot.ticket.state;
    state.delivery = { id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'bundle-a', issueRevisionIds: ['revision-a'],
      assessedByPmId: 'pm-a', shared: false, acceptedByClientId: null };
    await expect(f.service.reserve(target, subject, input)).rejects.toMatchObject({ code: 'ticket_work_not_authorized' });
  });
  it('does not leak extra runtime target fields into saved claims or receipts', async () => {
    const f = fixture(); const result = await f.service.reserve({ ...target, privateNote: 'private' } as typeof target, subject, input);
    expect(result).not.toHaveProperty('receipt.privateNote'); expect(f.data().claims[0]).not.toHaveProperty('privateNote');
    expect([...f.data().operations.values()][0].key).not.toHaveProperty('privateNote');
  });
  it.each(['ticket', 'workflow', 'project', 'scope'] as const)('fails closed before operation recovery on corrupt %s ownership', async part => {
    const f = fixture(); await f.service.reserve(target, subject, input); const value = f.linked().snapshot;
    if (part === 'ticket') value.ticket.workspaceId = 'other';
    if (part === 'workflow') value.ticket.state.workspaceId = 'other';
    if (part === 'project') value.project.workspaceId = 'other';
    if (part === 'scope') value.scope.workspaceId = 'other';
    await expect(f.service.lookup(target, subject, input.operationId)).rejects.toThrow();
  });
});
