import { describe, expect, it } from 'vitest';

import { DatabaseCommitError } from '../store/database.js';
import type { TicketCommandReceipt, TicketWriteMode } from '../store/ticketCommandStore.js';
import type {
  LockedTicketExecution, SavedTicketReadiness, TicketExecutionCompletionSubject,
  TicketReadinessAudit, TicketReadinessOperationKey, TicketTechnicalReadinessStore,
  TicketTechnicalReadinessTransaction,
} from '../store/ticketTechnicalReadinessStore.js';
import { newTicketWorkflow, type TicketFacts } from '../ticketing/workflow.js';
import { createTicketTechnicalReadinessService } from './ticketTechnicalReadinessService.js';

const target = { workspaceId: 'workspace-a', ticketId: 'ticket-a' };
const subject: TicketExecutionCompletionSubject = { kind: 'verified_execution_completion', verificationId: 'verified-completion-a' };
const actor: LockedTicketExecution['actor'] = {
  kind: 'execution', userId: 'dev-a', ...target, issueId: 'issue-a', issueRevisionId: 'revision-a',
  runId: 'run-a', completionId: 'completion-a', authorized: true,
};
const envelope = { schemaVersion: 1 as const, operationId: 'completion-operation', expectedVersion: 4 };
const timestamp = '2026-10-08T07:00:00.000Z';
function operationKey(key: TicketReadinessOperationKey) {
  return JSON.stringify([key.kind, key.workspaceId, key.ticketId, key.actorId, key.runId, key.completionId, key.operationId]);
}
function completedFacts(): TicketFacts {
  return {
    clientAccessActive: true,
    issues: ['a', 'b'].map(suffix => ({
      id: `issue-${suffix}`, revisionId: `revision-${suffix}`, ...target,
      projectId: 'project-a', scopeVersionId: 'scope-a', status: 'done', hasActiveRun: false,
      requiredReviewsPassed: true,
    })),
  };
}
/** Test-only serialized/rollback fixture. Not a production adapter or proof of
 * distributed run verification, SQL locks or hosted tenant isolation.
 */
function fixture() {
  let data = {
    state: { ...newTicketWorkflow(target.ticketId, target.workspaceId, 'client-a'),
      version: 4, status: 'in_progress' as const, projectId: 'project-a',
      scopeVersionId: 'scope-a', agreedScopeVersionId: 'scope-a', authorizedScopeVersionId: 'scope-a',
      requiredIssueIds: ['issue-a', 'issue-b'], actionOwner: 'developer' as const, nextAction: 'execute_work' as const,
    } as LockedTicketExecution['state'],
    operations: new Map<string, SavedTicketReadiness>(),
    audits: [] as TicketReadinessAudit[],
    signals: [] as Parameters<TicketTechnicalReadinessTransaction['enqueueChange']>[0][],
  };
  const control = {
    access: true, mode: 'enabled' as TicketWriteMode | undefined, actor: structuredClone(actor),
    facts: completedFacts(), failAt: '', cas: true, commitUnknown: false,
    calls: [] as string[], wrongSnapshot: false,
    savedMutation: undefined as ((saved: SavedTicketReadiness) => void) | undefined,
  };
  let queue = Promise.resolve();
  const store: TicketTechnicalReadinessStore = {
    async transaction<T>(work: (tx: TicketTechnicalReadinessTransaction) => Promise<T>) {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const draft = structuredClone(data);
      function step(name: string) {
        control.calls.push(name);
        if (control.failAt === name) throw new Error(`Injected ${name} failure`);
      }
      const tx: TicketTechnicalReadinessTransaction = {
        async lockAuthorizedExecution(requestTarget, requestedSubject) {
          step('authorize');
          if (!control.access || requestTarget.workspaceId !== target.workspaceId || requestTarget.ticketId !== target.ticketId
            || requestedSubject.kind !== subject.kind || requestedSubject.verificationId !== subject.verificationId) return null;
          const state = structuredClone(draft.state);
          if (control.wrongSnapshot) state.workspaceId = 'other-workspace';
          return { state, actor: structuredClone(control.actor), mode: control.mode };
        },
        async findOperation(key) {
          step('find');
          const saved = structuredClone(draft.operations.get(operationKey(key)) ?? null);
          if (saved && control.savedMutation) control.savedMutation(saved);
          return saved;
        },
        async loadFacts() { step('facts'); return structuredClone(control.facts); },
        async findRecordedManifest(manifest) {
          step('manifest');
          return structuredClone([...draft.operations.values()].find(saved => saved.manifest.id === manifest.id) ?? null);
        },
        async saveWorkflow(requestTarget, version, state) {
          step('save');
          if (!control.cas || requestTarget.workspaceId !== draft.state.workspaceId || requestTarget.ticketId !== draft.state.id || version !== draft.state.version) return false;
          draft.state = structuredClone(state); return true;
        },
        async appendAudit(audit) { step('audit'); draft.audits.push(structuredClone(audit)); },
        async enqueueChange(signal) { step('signal'); draft.signals.push(structuredClone(signal)); },
        async insertOperation(operation) {
          step('operation');
          const key = operationKey(operation.key);
          if (draft.operations.has(key) || [...draft.operations.values()].some(saved => saved.manifest.id === operation.manifest.id)) {
            throw new Error('Duplicate immutable readiness outcome');
          }
          draft.operations.set(key, structuredClone(operation));
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
  const service = createTicketTechnicalReadinessService(store, () => new Date(timestamp));
  return { control, service, get data() { return data; }, record: (input: unknown = envelope) => service.record(target, subject, input) };
}

describe('ticket technical readiness transaction service', () => {
  it('atomically notifies the PM for the complete reviewed manifest without sharing or closing work', async () => {
    const f = fixture();
    const result = await f.record();
    expect(result).toEqual({ ticketId: target.ticketId, operationId: envelope.operationId, version: 5, status: 'in_progress' });
    expect(f.data.state).toMatchObject({ actionOwner: 'pm', nextAction: 'assess_result', delivery: null, closureReason: null });
    expect(f.control.calls).toEqual(['authorize', 'find', 'facts', 'manifest', 'save', 'audit', 'signal', 'operation']);
    expect(f.data.audits[0]).toMatchObject({
      occurredAt: timestamp, envelope, event: { type: 'technical_work_ready', actorKind: 'execution', actorId: 'dev-a', fromVersion: 4, toVersion: 5 },
      manifest: { ...target, projectId: 'project-a', scopeVersionId: 'scope-a',
        issueRevisions: [{ issueId: 'issue-a', revisionId: 'revision-a' }, { issueId: 'issue-b', revisionId: 'revision-b' }] },
    });
    expect(f.data.signals).toHaveLength(1);
    expect(Object.keys(result).sort()).toEqual(['operationId', 'status', 'ticketId', 'version']);
    expect(Object.keys([...f.data.operations.values()][0].key)).not.toContain('verificationId');
  });

  it.each(['save', 'audit', 'signal', 'operation'])('rolls back all effects on %s failure', async stage => {
    const f = fixture(); const before = structuredClone(f.data); f.control.failAt = stage;
    await expect(f.record()).rejects.toThrow(`Injected ${stage} failure`);
    expect(f.data).toEqual(before);
    f.control.failAt = '';
    await expect(f.record()).resolves.toMatchObject({ version: 5 });
    expect(f.data.audits).toHaveLength(1);
  });

  it('rolls back on ticket compare-and-swap failure', async () => {
    const f = fixture(); const before = structuredClone(f.data); f.control.cas = false;
    await expect(f.record()).rejects.toMatchObject({ code: 'ticket_version_conflict' });
    expect(f.data).toEqual(before);
  });

  it('replays the same operation without a second write even after the ticket advances', async () => {
    const f = fixture(); const receipt = await f.record();
    f.data.state.version = 9; f.data.state.status = 'closed';
    f.control.calls = [];
    await expect(f.record()).resolves.toEqual(receipt);
    expect(f.control.calls).toEqual(['authorize', 'find']);
    expect(f.data.audits).toHaveLength(1);
  });

  it('reconciles an unknown COMMIT with the same verified event and operation ID', async () => {
    const f = fixture(); f.control.commitUnknown = true;
    await expect(f.record()).rejects.toBeInstanceOf(DatabaseCommitError);
    expect(f.data.state.version).toBe(5);
    await expect(f.service.lookup(target, subject, envelope.operationId)).resolves.toMatchObject({ version: 5 });
    await expect(f.record()).resolves.toMatchObject({ version: 5 });
    expect(f.data.audits).toHaveLength(1);
    expect(f.data.signals).toHaveLength(1);
  });

  it('serializes duplicate concurrent events into one immutable decision', async () => {
    const f = fixture();
    const outcomes = await Promise.all([f.record(), f.record()]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(f.data.operations.size).toBe(1);
    expect(f.data.audits).toHaveLength(1);
  });

  it('rejects operation-ID reuse with a changed expected version', async () => {
    const f = fixture(); await f.record();
    await expect(f.record({ ...envelope, expectedVersion: 5 })).rejects.toMatchObject({ code: 'ticket_operation_conflict' });
    expect(f.data.audits).toHaveLength(1);
  });

  it('deduplicates the same manifest after a reply changes its next action and another completion arrives', async () => {
    const f = fixture(); await f.record();
    f.data.state.version = 6; f.data.state.actionOwner = 'pm'; f.data.state.nextAction = 'reply';
    Object.assign(f.control.actor, { runId: 'run-b', completionId: 'completion-b', issueId: 'issue-b', issueRevisionId: 'revision-b' });
    f.control.facts.issues = [...f.control.facts.issues!].reverse();
    const before = structuredClone(f.data);
    await expect(f.record({ ...envelope, operationId: 'late-event', expectedVersion: 6 }))
      .rejects.toMatchObject({ code: 'technical_readiness_already_recorded' });
    expect(f.data).toEqual(before);
  });

  it('permits fresh readiness after an explicitly authorized correction passes fresh review', async () => {
    const f = fixture(); await f.record();
    // Represents the separately committed PM correction + existing technical review.
    f.data.state.version = 8; f.data.state.actionOwner = 'developer'; f.data.state.nextAction = 'execute_work';
    f.control.facts.issues![0].revisionId = 'corrected-revision-a';
    Object.assign(f.control.actor, { runId: 'corrected-run', completionId: 'corrected-completion', issueRevisionId: 'corrected-revision-a' });
    await expect(f.record({ ...envelope, operationId: 'corrected-ready', expectedVersion: 8 })).resolves.toMatchObject({ version: 9 });
    expect(f.data.operations.size).toBe(2);
    const manifests = [...f.data.operations.values()].map(saved => saved.manifest.id);
    expect(new Set(manifests).size).toBe(2);
  });

  it.each(['missing', 'wrong-ticket', 'wrong-workspace', 'wrong-snapshot', 'unverified', 'empty-run'])('refuses %s authority before parsing or operation lookup', async mismatch => {
    const f = fixture();
    if (mismatch === 'missing') f.control.access = false;
    if (mismatch === 'wrong-ticket') f.control.actor.ticketId = 'other-ticket';
    if (mismatch === 'wrong-workspace') f.control.actor.workspaceId = 'other-workspace';
    if (mismatch === 'wrong-snapshot') f.control.wrongSnapshot = true;
    if (mismatch === 'unverified') f.control.actor.authorized = false;
    if (mismatch === 'empty-run') f.control.actor.runId = '';
    await expect(f.record({ secret: 'invalid payload' })).rejects.toMatchObject({ status: 404, code: 'ticket_not_found' });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('never treats a client identity or plain run ID as a verified completion', async () => {
    const f = fixture();
    await expect(f.service.record(target, { kind: 'client', userId: 'client-a', sessionId: 'client-session' } as unknown as TicketExecutionCompletionSubject, envelope))
      .rejects.toMatchObject({ status: 404 });
    await expect(f.service.record(target, { ...subject, verificationId: 'run-a' }, envelope)).rejects.toMatchObject({ status: 404 });
    expect(f.data.operations.size).toBe(0);
  });

  it.each(['disabled', 'maintenance', undefined] as const)('fails closed in %s mode while retaining authorized outcome recovery', async mode => {
    const f = fixture(); await f.record(); f.control.mode = mode;
    await expect(f.record()).rejects.toMatchObject({ status: 503, code: 'ticket_writes_disabled' });
    await expect(f.service.lookup(target, subject, envelope.operationId)).resolves.toMatchObject({ version: 5 });
  });

  it('rechecks authority before recovering a receipt after revocation', async () => {
    const f = fixture(); await f.record(); f.control.access = false;
    await expect(f.service.lookup(target, subject, envelope.operationId)).rejects.toMatchObject({ status: 404 });
  });

  it('returns null for an unknown operation under valid current authority', async () => {
    const f = fixture();
    await expect(f.service.lookup(target, subject, 'missing-operation')).resolves.toBeNull();
    expect(f.control.calls).toEqual(['authorize', 'find']);
  });

  it.each([
    { ...envelope, schemaVersion: 2 }, { ...envelope, operationId: ' bad-id' },
    { ...envelope, operationId: 'bad\nID' }, { ...envelope, expectedVersion: -1 },
    { ...envelope, expectedVersion: Number.MAX_SAFE_INTEGER },
    { ...envelope, facts: completedFacts() }, { ...envelope, actor }, { ...envelope, deliveryId: 'fake-delivery' },
  ])('rejects invalid envelopes and caller-supplied facts: %j', async input => {
    const f = fixture();
    await expect(f.record(input)).rejects.toMatchObject({ status: 400, code: 'invalid_ticket_command' });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it.each(['stale-version', 'stale-revision', 'review-failed', 'review-status', 'active-run', 'missing-issue', 'duplicate-issue', 'foreign-project', 'foreign-scope', 'client-revoked', 'withdrawal', 'held', 'cancelled'])('rejects %s evidence without mutation', async mismatch => {
    const f = fixture();
    if (mismatch === 'stale-version') f.data.state.version++;
    if (mismatch === 'stale-revision') f.control.actor.issueRevisionId = 'older-revision';
    if (mismatch === 'review-failed') f.control.facts.issues![1].requiredReviewsPassed = false;
    if (mismatch === 'review-status') f.control.facts.issues![1].status = 'review';
    if (mismatch === 'active-run') f.control.facts.issues![1].hasActiveRun = true;
    if (mismatch === 'missing-issue') f.control.facts.issues = f.control.facts.issues!.slice(0, 1);
    if (mismatch === 'duplicate-issue') f.control.facts.issues = [f.control.facts.issues![0], f.control.facts.issues![0]];
    if (mismatch === 'foreign-project') f.control.facts.issues![1].projectId = 'other-project';
    if (mismatch === 'foreign-scope') f.control.facts.issues![1].scopeVersionId = 'other-scope';
    if (mismatch === 'client-revoked') f.control.facts.clientAccessActive = false;
    if (mismatch === 'withdrawal') f.data.state.withdrawalRequested = true;
    if (mismatch === 'held') f.data.state.status = 'on_hold';
    if (mismatch === 'cancelled') f.data.state.status = 'cancelled';
    const before = structuredClone(f.data);
    await expect(f.record()).rejects.toMatchObject({ status: 409 });
    expect(f.data).toEqual(before);
    expect(f.control.calls).not.toContain('save');
  });

  it.each(['foreign-key', 'foreign-ticket', 'foreign-operation', 'bad-version', 'bad-status'])('rejects a mismatched stored %s receipt', async mismatch => {
    const f = fixture(); await f.record();
    f.control.savedMutation = saved => {
      if (mismatch === 'foreign-key') saved.key.workspaceId = 'other-workspace';
      if (mismatch === 'foreign-ticket') saved.receipt.ticketId = 'other-ticket';
      if (mismatch === 'foreign-operation') saved.receipt.operationId = 'other-operation';
      if (mismatch === 'bad-version') saved.receipt.version = Number.NaN;
      if (mismatch === 'bad-status') saved.receipt.status = 'closed';
    };
    await expect(f.service.lookup(target, subject, envelope.operationId)).rejects.toThrow('mismatched outcome');
  });

  it('allowlists a recovered receipt rather than returning stored private metadata', async () => {
    const f = fixture(); await f.record();
    f.control.savedMutation = saved => { Object.assign(saved.receipt, { internalReview: 'private' }); };
    const result: TicketCommandReceipt | null = await f.service.lookup(target, subject, envelope.operationId);
    expect(result).toEqual({ ticketId: target.ticketId, operationId: envelope.operationId, version: 5, status: 'in_progress' });
  });
});
