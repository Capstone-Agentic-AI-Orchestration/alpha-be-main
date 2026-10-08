import { describe, expect, it } from 'vitest';

import { DatabaseCommitError } from '../store/database.js';
import type {
  LockedTicket, SavedTicketOperation, TicketChangeSignal, TicketCommandAudit, TicketSubject,
} from '../store/ticketCommandStore.js';
import type { TicketMessageTransaction, TicketNoteAudit } from '../store/ticketMessageStore.js';
import type { TicketDetailRows, TicketMessageReadRow, TicketReadTransaction } from '../store/ticketReadStore.js';
import { newTicketWorkflow, TicketWorkflowError, type TicketFacts } from '../ticketing/workflow.js';
import { createTicketCommandService } from './ticketCommandService.js';
import { createTicketMessageService } from './ticketMessageService.js';
import { createTicketReadService } from './ticketReadService.js';

const target = { workspaceId: 'workspace-a', ticketId: 'ticket-a' };
const pm: TicketSubject = { kind: 'internal', userId: 'pm-a', authentication: { kind: 'session', sessionId: 'session-pm' } };
const client: Extract<TicketSubject, { kind: 'client' }> = { kind: 'client', userId: 'client-a', sessionId: 'session-client' };
const started = '2026-10-08T03:00:00.000Z';
const updated = '2026-10-08T04:00:00.000Z';
interface TestTransaction extends TicketMessageTransaction, TicketReadTransaction {}
function credentialId(subject: TicketSubject) {
  return subject.kind === 'client' ? subject.sessionId : subject.authentication.kind === 'session'
    ? subject.authentication.sessionId : subject.authentication.verificationId;
}

/** Test-only shared adapter: command/message/read services see the SAME state.
 * Serialized transactions with rollback are not a claim of SQL/RLS correctness.
 */
function fixture() {
  let data = {
    state: newTicketWorkflow(target.ticketId, target.workspaceId, client.userId),
    detail: {
      header: {
        ...target, reference: 'REF-1', title: 'Request', description: 'Original request', clientSafeCompanyLabel: 'Client service',
        createdAt: started, clientUpdatedAt: started, internalUpdatedAt: started, closedAt: null,
        relatedTicketId: null, sharedProject: null,
      }, currentScope: null, currentDelivery: null, related: null,
    } as TicketDetailRows,
    messages: [] as TicketMessageReadRow[], audits: [] as TicketCommandAudit[], noteAudits: [] as TicketNoteAudit[],
    signals: [] as TicketChangeSignal[], operations: new Map<string, SavedTicketOperation>(),
  };
  let queue = Promise.resolve();
  let sequence = 0;
  const control = {
    access: true, clientActive: true, pmActive: true, permission: true, developer: false,
    mode: 'enabled' as LockedTicket['mode'],
    sessions: new Map([pm, client].map(subject => [credentialId(subject), subject])),
    bearers: new Map<string, TicketSubject>(),
    time: updated, generatedId: null as string | null,
    facts: {} as TicketFacts, badMessageEvidence: false,
    failAt: '', cas: true, clocksCas: true, commitUnknown: false,
    calls: [] as string[],
  };
  const store = {
    async transaction<T>(work: (tx: TestTransaction) => Promise<T>): Promise<T> {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const draft = structuredClone(data);
      function step(name: string) { control.calls.push(name); if (control.failAt === name) throw new Error(`Injected ${name} failure`); }
      const keyOf = (key: SavedTicketOperation['key']) => JSON.stringify([key.workspaceId, key.ticketId, key.actorKind, key.actorId, key.operationId]);
      const tx: TestTransaction = {
        async lockAuthorizedTicket(requestTarget, subject) {
          step('authorize');
          const credentials = subject.kind === 'internal' && subject.authentication.kind === 'verified_github_bearer' ? control.bearers : control.sessions;
          const credential = credentials.get(credentialId(subject));
          if (!control.access || !credential || credential.kind !== subject.kind || credential.userId !== subject.userId
            || requestTarget.workspaceId !== draft.state.workspaceId || requestTarget.ticketId !== draft.state.id) return null;
          return {
            state: structuredClone(draft.state), mode: control.mode,
            actor: subject.kind === 'client'
              ? { kind: 'client', userId: subject.userId, workspaceId: target.workspaceId, ticketId: target.ticketId, grantActive: control.clientActive }
              : control.developer ? { kind: 'developer', userId: subject.userId, workspaceId: target.workspaceId }
                : { kind: 'pm', userId: subject.userId, workspaceId: target.workspaceId, membershipActive: control.pmActive, canManageTickets: control.permission },
          };
        },
        async findOperation(key) { step('find'); return structuredClone(draft.operations.get(keyOf(key)) ?? null); },
        async insertOperation(operation) {
          step('operation'); const key = keyOf(operation.key);
          if (draft.operations.has(key)) throw new Error('Duplicate operation');
          draft.operations.set(key, structuredClone(operation));
        },
        async loadFacts(_ticket, envelope) {
          step('facts');
          const messageId = 'messageId' in envelope.command ? envelope.command.messageId : null;
          const row = draft.messages.find(message => message.id === messageId && message.workspaceId === target.workspaceId && message.ticketId === target.ticketId);
          return {
            ...structuredClone(control.facts), clientAccessActive: control.clientActive,
            message: row ? {
              id: row.id, ticketId: row.ticketId, authorId: control.badMessageEvidence ? 'other-author' : row.authorId, audience: row.audience,
            } : undefined,
          };
        },
        async loadAssessmentCandidate() { throw new Error('Conversation cannot assess results.'); },
        async saveWorkflow(requestTarget, expectedVersion, state) {
          step('save');
          if (!control.cas || requestTarget.workspaceId !== draft.state.workspaceId || requestTarget.ticketId !== draft.state.id || draft.state.version !== expectedVersion) return false;
          draft.state = structuredClone(state);
          if (['closed', 'declined', 'cancelled'].includes(state.status)) draft.detail.header.closedAt = control.time;
          return true;
        },
        async insertWorkBindings() { throw new Error('Conversation must not bind Issues.'); },
        async reopenIssues() { throw new Error('Conversation must not reopen Issues.'); },
        async appendAudit(audit) { step('audit'); draft.audits.push(structuredClone(audit)); },
        async enqueueChange(signal) { step('signal'); draft.signals.push(structuredClone(signal)); },
        async insertMessage(message) {
          step('message');
          if (draft.messages.some(row => row.id === message.id)) throw new Error('Duplicate message identity');
          draft.messages.push(structuredClone(message));
        },
        async updateMessageClocks(requestTarget, expectedVersion, audience, occurredAt) {
          step('clocks');
          if (!control.clocksCas || requestTarget.workspaceId !== draft.state.workspaceId || requestTarget.ticketId !== draft.state.id || expectedVersion !== draft.state.version) return false;
          draft.detail.header.internalUpdatedAt = occurredAt;
          if (audience === 'client') draft.detail.header.clientUpdatedAt = occurredAt;
          return true;
        },
        async appendNoteAudit(audit) { step('note-audit'); draft.noteAudits.push(structuredClone(audit)); },
        async loadDetail() { step('detail'); return structuredClone(draft.detail); },
        async loadMessages(_ticket, audience, page) {
          step(`read:${audience}`);
          const rows = draft.messages.filter(row => row.audience === audience && row.workspaceId === target.workspaceId && row.ticketId === target.ticketId)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const cursor = page.after === null ? -1 : rows.findIndex(row => row.id === page.after);
          if (page.after !== null && cursor === -1) throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
          return structuredClone(rows.slice(cursor + 1, cursor + 1 + page.limit + 1));
        },
      };
      try {
        const result = await work(tx); data = draft;
        if (control.commitUnknown) { control.commitUnknown = false; throw new DatabaseCommitError(new Error('Lost response')); }
        return result;
      } finally { release(); }
    },
  };
  const clock = () => new Date(control.time);
  const messages = createTicketMessageService(store, clock, () => control.generatedId ?? `message-${String(++sequence).padStart(4, '0')}`);
  const commands = createTicketCommandService(store, clock);
  const reads = createTicketReadService(store);
  const input = (overrides = {}) => ({ schemaVersion: 1, operationId: `op-${data.operations.size}`, expectedVersion: data.state.version, body: 'Text from user', ...overrides });
  return {
    control, messages, commands, reads, input, get data() { return data; },
    async review() { await commands.execute(target, pm, { schemaVersion: 1, operationId: 'review-op', expectedVersion: data.state.version, command: { type: 'review' } }); },
    shared() {
      const state = data.state;
      state.status = 'ready_for_review'; state.actionOwner = 'client'; state.nextAction = 'review_result'; state.scopeVersionId = 'scope-a';
      state.delivery = { id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'asset-a', issueRevisionIds: ['revision-a'], assessedByPmId: pm.userId, shared: true, acceptedByClientId: null };
      control.facts.delivery = { id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'asset-a', issueRevisionIds: ['revision-a'], immutable: true };
      data.detail.currentDelivery = { ...target, ...control.facts.delivery, clientVisible: true, publicSummary: 'Shared result', sharedAt: started, issueRevisionIds: ['revision-a'] };
    },
  };
}

describe('atomic public ticket replies', () => {
  it('saves one message, workflow decision, audit, clocks, signal and safe outcome', async () => {
    const f = fixture(); await f.review(); f.control.calls = [];
    const result = await f.messages.reply(target, pm, f.input({ operationId: 'reply-op', body: '  A public update  ' }));
    expect(result).toEqual({ ticketId: target.ticketId, operationId: 'reply-op', messageId: 'message-0001', version: 2, status: 'under_review' });
    expect(f.data.messages).toEqual([{ ...target, id: 'message-0001', authorId: pm.userId, authorKind: 'pm', audience: 'client', body: 'A public update', createdAt: updated }]);
    expect(f.data.detail.header).toMatchObject({ clientUpdatedAt: updated, internalUpdatedAt: updated });
    expect(f.data.audits[1]).toMatchObject({ envelope: { command: { type: 'reply', messageId: result.messageId } }, event: { type: 'reply', actorId: pm.userId } });
    expect(JSON.stringify(f.data.audits)).not.toContain('A public update');
    expect(JSON.stringify([...f.data.operations.values()])).not.toContain('A public update');
    expect(f.control.calls).toEqual(['authorize', 'find', 'message', 'facts', 'save', 'audit', 'signal', 'clocks', 'operation']);
  });

  it('connects PM request-details and client response without resetting authorized work', async () => {
    const f = fixture(); await f.review();
    await f.messages.reply(target, pm, f.input({ action: { type: 'request_details' }, body: 'Which page needs changing?' }));
    expect(f.data.state).toMatchObject({ status: 'awaiting_client', actionOwner: 'client', nextAction: 'reply' });
    await f.messages.reply(target, client, f.input({ body: 'The home page.' }));
    expect(f.data.state).toMatchObject({ status: 'under_review', actionOwner: 'pm' });
    f.data.state.status = 'in_progress'; f.data.state.projectId = 'project-a'; f.data.state.requiredIssueIds = ['issue-a']; f.data.state.authorizedScopeVersionId = 'scope-a';
    await f.messages.reply(target, client, f.input({ body: 'A question while work continues.' }));
    expect(f.data.state).toMatchObject({ status: 'in_progress', projectId: 'project-a', requiredIssueIds: ['issue-a'], authorizedScopeVersionId: 'scope-a' });
    expect((await f.reads.conversation(target, client)).items.map(row => row.body)).toEqual(['Which page needs changing?', 'The home page.', 'A question while work continues.']);
  });

  it('an ordinary PM update is not automatically a client action request', async () => {
    const f = fixture(); f.data.state.status = 'in_progress'; f.data.state.actionOwner = 'developer'; f.data.state.nextAction = 'execute_work';
    await f.messages.reply(target, pm, f.input());
    expect(f.data.state).toMatchObject({ status: 'in_progress', actionOwner: 'developer', nextAction: 'execute_work' });
  });

  it('closes answer-only requests atomically, without completing a project', async () => {
    const f = fixture(); await f.review();
    expect(await f.messages.reply(target, pm, f.input({ action: { type: 'answer_close' }, body: 'Here is the information.' }))).toMatchObject({ status: 'closed' });
    expect(f.data.state).toMatchObject({ closureReason: 'answered', projectId: null, requiredIssueIds: [] });
    expect(await f.reads.detail(target, client)).toMatchObject({ status: 'closed', readOnly: true, closedAt: updated });
    expect(f.data.state).not.toHaveProperty('projectCompleted');
  });

  it('does not allow an answer-only closure to bypass outstanding implementation', async () => {
    const f = fixture(); await f.review(); f.data.state.authorizedScopeVersionId = 'scope-a';
    const before = structuredClone(f.data);
    await expect(f.messages.reply(target, pm, f.input({ action: { type: 'answer_close' } }))).rejects.toMatchObject({ code: 'implementation_outstanding' });
    expect(f.data).toEqual(before);
  });

  it('saves client delivery feedback and PM triage together, never reopening work itself', async () => {
    const f = fixture(); f.shared();
    await f.messages.reply(target, client, f.input({ action: { type: 'request_correction', deliveryId: 'delivery-a' }, body: 'The agreed search still fails.' }));
    expect(f.data.state).toMatchObject({ status: 'under_review', nextAction: 'triage_correction', correctionRequestedFor: 'delivery-a' });
    expect(f.data.state.delivery).toMatchObject({ id: 'delivery-a', shared: true });
    expect(f.data.audits).toHaveLength(1); expect(f.data.signals).toHaveLength(1);
  });

  it('rolls back feedback on an old delivery', async () => {
    const f = fixture(); f.shared();
    await expect(f.messages.reply(target, client, f.input({ action: { type: 'request_correction', deliveryId: 'old-delivery' } }))).rejects.toMatchObject({ code: 'delivery_not_current' });
    expect(f.data.messages).toEqual([]); expect(f.data.state.status).toBe('ready_for_review');
  });

  it('keeps a held ticket held when client replies', async () => {
    const f = fixture(); f.data.state.status = 'on_hold'; f.data.state.actionOwner = 'pm'; f.data.state.nextAction = 'resolve_hold';
    f.data.state.hold = { status: 'awaiting_client', actionOwner: 'client', nextAction: 'reply' };
    await f.messages.reply(target, client, f.input());
    expect(f.data.state).toMatchObject({ status: 'on_hold', nextAction: 'resolve_hold', hold: { status: 'under_review' } });
  });

  it('allows clarification during withdrawal handling without cancelling or resuming work', async () => {
    const f = fixture(); f.data.state.withdrawalRequested = true;
    await f.messages.reply(target, client, f.input());
    expect(f.data.state).toMatchObject({ withdrawalRequested: true, nextAction: 'handle_withdrawal' });
  });

  it.each(['unassigned-client', 'inactive-client'])('refuses public communication for %s but preserves PM note capability', async condition => {
    const f = fixture();
    if (condition === 'unassigned-client') f.data.state.clientId = null;
    else f.control.clientActive = false;
    await expect(f.messages.reply(target, pm, f.input())).rejects.toMatchObject({ code: 'client_access_inactive' });
    expect(f.data.messages).toEqual([]);
    await f.messages.note(target, pm, f.input({ body: 'Internal intake assessment' }));
    expect(f.data.messages).toHaveLength(1); expect(f.data.messages[0].audience).toBe('internal');
  });

  it('uses the inserted message’s authoritative ownership evidence', async () => {
    const f = fixture(); f.control.badMessageEvidence = true;
    await expect(f.messages.reply(target, pm, f.input())).rejects.toMatchObject({ code: 'public_message_required' });
    expect(f.data.messages).toEqual([]); expect(f.data.operations.size).toBe(0);
  });

  it.each(['message', 'facts', 'save', 'audit', 'signal', 'clocks', 'operation'])('rolls back every public effect on %s failure', async stage => {
    const f = fixture(); const before = structuredClone(f.data); f.control.failAt = stage;
    const input = f.input();
    await expect(f.messages.reply(target, pm, input)).rejects.toThrow(`Injected ${stage} failure`);
    expect(f.data).toEqual(before);
    f.control.failAt = '';
    expect(await f.messages.reply(target, pm, input)).toMatchObject({ version: 1 });
    expect(f.data.messages).toHaveLength(1);
  });

  it.each(['workflow', 'metadata'])('rolls back when the %s compare-and-swap fails', async field => {
    const f = fixture(); if (field === 'workflow') f.control.cas = false; else f.control.clocksCas = false;
    const before = structuredClone(f.data);
    await expect(f.messages.reply(target, pm, f.input())).rejects.toMatchObject({ code: 'ticket_version_conflict' });
    expect(f.data).toEqual(before);
  });
});

describe('private PM notes', () => {
  it('changes no client projection, conversation, workflow version, public clock or notification', async () => {
    const f = fixture(); const before = await f.reads.detail(target, client); f.control.calls = [];
    const result = await f.messages.note(target, pm, f.input({ body: 'Private assessment' }));
    expect(result).toMatchObject({ version: 0, status: 'received' });
    expect(await f.reads.detail(target, client)).toEqual(before);
    expect(await f.reads.conversation(target, client)).toEqual({ items: [], nextCursor: null });
    expect(f.data.detail.header).toMatchObject({ clientUpdatedAt: started, internalUpdatedAt: updated, closedAt: null });
    expect(f.data.state.version).toBe(0); expect(f.data.audits).toEqual([]); expect(f.data.signals).toEqual([]);
    expect(f.data.noteAudits).toHaveLength(1);
    expect(JSON.stringify(f.data.noteAudits)).not.toContain('Private assessment');
    expect((await f.reads.notes(target, pm)).items[0]).toMatchObject({ body: 'Private assessment', authorId: pm.userId });
    expect(f.control.calls).not.toContain('save'); expect(f.control.calls).not.toContain('signal'); expect(f.control.calls).not.toContain('facts');
  });

  it('refuses clients before note validation or operation lookup', async () => {
    const f = fixture();
    await expect(f.messages.note(target, client, { invalid: true })).rejects.toMatchObject({ status: 403 });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('allows independent append-only notes at the same workflow version', async () => {
    const f = fixture();
    await Promise.all([f.messages.note(target, pm, f.input({ operationId: 'note-a' })), f.messages.note(target, pm, f.input({ operationId: 'note-b' }))]);
    expect(f.data.messages).toHaveLength(2); expect(f.data.state.version).toBe(0); expect(f.data.noteAudits).toHaveLength(2);
  });

  it.each(['message', 'note-audit', 'clocks', 'operation'])('rolls back private note effects on %s failure', async stage => {
    const f = fixture(); f.control.failAt = stage; const before = structuredClone(f.data);
    await expect(f.messages.note(target, pm, f.input())).rejects.toThrow(`Injected ${stage} failure`);
    expect(f.data).toEqual(before);
  });

  it('does not erase an existing client action request or accepted delivery', async () => {
    const f = fixture(); f.shared(); f.data.state.delivery!.acceptedByClientId = client.userId;
    const before = structuredClone(f.data.state);
    await f.messages.note(target, pm, f.input());
    expect(f.data.state).toEqual(before);
  });
});

describe('shared operation namespace and recovery', () => {
  it.each(['reply', 'note'] as const)('replays %s only once, before and after later workflow changes', async method => {
    const f = fixture(); const input = f.input({ operationId: 'same-op' });
    const first = await f.messages[method](target, pm, input);
    const messageCount = f.data.messages.length;
    await f.commands.execute(target, pm, { schemaVersion: 1, operationId: 'later-decline', expectedVersion: f.data.state.version, command: { type: 'decline', reason: 'Outside scope' } });
    expect(await f.messages[method](target, pm, input)).toEqual(first);
    expect(f.data.messages).toHaveLength(messageCount); expect(f.data.state.status).toBe('declined');
  });

  it.each(['reply', 'note'] as const)('canonicalizes %s body whitespace, object order and default reply action', async method => {
    const f = fixture(); const input = f.input({ body: '  Original text  ', operationId: 'same-op' });
    const first = await f.messages[method](target, pm, input);
    const reordered = { body: 'Original text', expectedVersion: 0, operationId: 'same-op', schemaVersion: 1, ...(method === 'reply' ? { action: { type: 'reply' } } : {}) };
    expect(await f.messages[method](target, pm, reordered)).toEqual(first); expect(f.data.messages).toHaveLength(1);
  });

  it.each(['body', 'version', 'action'])('refuses changed %s under the same operation ID', async field => {
    const f = fixture(); const input = f.input({ operationId: 'same-op' }); await f.messages.reply(target, pm, input);
    const changed = { ...input, ...(field === 'body' ? { body: 'Changed' } : field === 'version' ? { expectedVersion: 1 } : { action: { type: 'request_details' } }) };
    await expect(f.messages.reply(target, pm, changed)).rejects.toMatchObject({ code: 'ticket_operation_conflict' });
    expect(f.data.messages).toHaveLength(1);
  });

  it.each(['reply-to-note', 'note-to-reply', 'command-to-reply', 'reply-to-command', 'command-to-note', 'note-to-command'])('refuses cross-endpoint ID reuse (%s)', async direction => {
    const f = fixture(); const input = f.input({ operationId: 'same-op' });
    const command = { schemaVersion: 1, operationId: 'same-op', expectedVersion: 0, command: { type: 'review' } };
    if (direction.startsWith('reply')) await f.messages.reply(target, pm, input);
    if (direction.startsWith('note')) await f.messages.note(target, pm, input);
    if (direction.startsWith('command')) await f.commands.execute(target, pm, command);
    const attempt = direction.endsWith('note') ? f.messages.note(target, pm, input)
      : direction.endsWith('reply') ? f.messages.reply(target, pm, input) : f.commands.execute(target, pm, command);
    await expect(attempt).rejects.toMatchObject({ code: 'ticket_operation_conflict' });
    expect(f.data.operations.size).toBe(1);
  });

  it('deduplicates concurrent copies of the same reply', async () => {
    const f = fixture(); const input = f.input();
    const results = await Promise.all(Array.from({ length: 6 }, () => f.messages.reply(target, client, input)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(f.data.messages).toHaveLength(1); expect(f.data.audits).toHaveLength(1); expect(f.data.signals).toHaveLength(1);
  });

  it('only one competing reply at a shared version can be saved', async () => {
    const f = fixture();
    const outcomes = await Promise.allSettled([f.messages.reply(target, pm, f.input({ operationId: 'a' })), f.messages.reply(target, client, f.input({ operationId: 'b' }))]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'ticket_version_conflict' } });
    expect(f.data.messages).toHaveLength(1);
  });

  it.each(['reply', 'note'] as const)('reconciles a lost %s COMMIT without blind retry', async method => {
    const f = fixture(); f.control.commitUnknown = true; const input = f.input();
    await expect(f.messages[method](target, pm, input)).rejects.toBeInstanceOf(DatabaseCommitError);
    const outcome = await f.commands.lookup(target, pm, input.operationId);
    expect(outcome).toHaveProperty('messageId', 'message-0001');
    expect(await f.messages[method](target, pm, input)).toEqual(outcome); expect(f.data.messages).toHaveLength(1);
  });

  it('cannot expose a PM note outcome to the client, even with its operation ID', async () => {
    const f = fixture(); await f.messages.note(target, pm, f.input({ operationId: 'known-id' }));
    expect(await f.messages.lookup(target, client, 'known-id')).toBeNull();
    await expect(f.reads.notes(target, client)).rejects.toMatchObject({ status: 403 });
  });

  it('keeps client and internal identities separate even if their user strings match', async () => {
    const f = fixture(); f.data.state.clientId = pm.userId;
    const external: TicketSubject = { ...client, userId: pm.userId }; f.control.sessions.set(client.sessionId, external);
    await f.messages.note(target, pm, f.input({ operationId: 'same-op' }));
    expect(await f.messages.lookup(target, external, 'same-op')).toBeNull();
    await f.messages.reply(target, external, f.input({ operationId: 'same-op' }));
    expect(f.data.operations.size).toBe(2);
  });

  it('reconciles a PM web operation through the existing verified desktop bearer identity', async () => {
    const f = fixture(); const input = f.input(); const first = await f.messages.note(target, pm, input);
    const bearer: TicketSubject = { kind: 'internal', userId: pm.userId, authentication: { kind: 'verified_github_bearer', verificationId: 'verified-request' } };
    f.control.bearers.set(credentialId(bearer), bearer); f.control.sessions.clear();
    expect(await f.messages.lookup(target, bearer, input.operationId)).toEqual(first);
    expect(await f.messages.note(target, bearer, input)).toEqual(first);
  });

  it.each(['reply', 'note'] as const)('refuses a stale %s before generating or saving a message', async method => {
    const f = fixture(); const stale = f.input(); await f.review(); f.control.calls = [];
    const before = structuredClone(f.data);
    await expect(f.messages[method](target, pm, stale)).rejects.toMatchObject({ code: 'ticket_version_conflict' });
    expect(f.data).toEqual(before); expect(f.control.calls).toEqual(['authorize', 'find']);
    expect(await f.messages[method](target, pm, f.input())).toHaveProperty('messageId', 'message-0001');
  });

  it('rolls back a private note if its metadata compare-and-swap fails', async () => {
    const f = fixture(); f.control.clocksCas = false; const before = structuredClone(f.data);
    await expect(f.messages.note(target, pm, f.input())).rejects.toMatchObject({ code: 'ticket_version_conflict' });
    expect(f.data).toEqual(before);
  });

  it('scrubs arbitrary receipt fields during message reconciliation', async () => {
    const f = fixture(); const input = f.input(); const first = await f.messages.reply(target, pm, input);
    const saved = [...f.data.operations.values()][0];
    Object.assign(saved.receipt, { body: 'Private payload', actorId: 'secret', messageId: 'injected' });
    expect(await f.messages.lookup(target, pm, input.operationId)).toEqual(first);
  });

  it.each(['wrong-ticket', 'wrong-actor', 'missing-message'])('fails closed on corrupt operation evidence (%s)', async corruption => {
    const f = fixture(); const input = f.input(); await f.messages.reply(target, pm, input);
    const saved = [...f.data.operations.values()][0];
    if (corruption === 'wrong-ticket') saved.receipt.ticketId = 'other-ticket';
    if (corruption === 'wrong-actor') saved.key.actorId = 'other-actor';
    if (corruption === 'missing-message' && (saved.kind === 'message' || saved.kind === 'note')) saved.messageId = '';
    await expect(f.messages.lookup(target, pm, input.operationId)).rejects.toThrow('Ticket operation store returned');
  });

  it('refuses a private-note receipt incorrectly stored under a client operation key', async () => {
    const f = fixture(); const input = f.input(); await f.messages.reply(target, client, input);
    const saved = [...f.data.operations.values()][0];
    saved.kind = 'note';
    await expect(f.messages.lookup(target, client, input.operationId)).rejects.toMatchObject({ status: 404 });
  });
});

describe('message permissions, feature gates and validation', () => {
  it.each(['closed', 'declined', 'cancelled'] as const)('does not append replies or notes to %s history', async status => {
    const f = fixture(); f.data.state.status = status;
    for (const method of ['reply', 'note'] as const) await expect(f.messages[method](target, pm, f.input())).rejects.toMatchObject({ code: 'ticket_is_read_only' });
    expect(f.data.messages).toEqual([]); expect(f.control.calls).not.toContain('message');
  });

  it.each(['disabled', 'maintenance', undefined] as const)('blocks new communication under mode %s', async mode => {
    const f = fixture(); f.control.mode = mode;
    for (const method of ['reply', 'note'] as const) await expect(f.messages[method](target, pm, f.input())).rejects.toMatchObject({ status: 503 });
    expect(f.control.calls).toEqual(['authorize', 'authorize']);
  });

  it('permits authenticated reconciliation while writes are disabled, but does not replay a write', async () => {
    const f = fixture(); const input = f.input(); const first = await f.messages.reply(target, client, input);
    f.control.mode = 'disabled';
    expect(await f.messages.lookup(target, client, input.operationId)).toEqual(first);
    await expect(f.messages.reply(target, client, input)).rejects.toMatchObject({ status: 503 });
  });

  it.each(['client-grant', 'pm-membership', 'pm-capability', 'session', 'developer'])('rechecks %s before validation and saved outcome lookup', async revoked => {
    const f = fixture(); const subject = revoked === 'client-grant' ? client : pm; const input = f.input();
    await f.messages.reply(target, subject, input); f.control.calls = [];
    if (revoked === 'client-grant') f.control.clientActive = false;
    if (revoked === 'pm-membership') f.control.pmActive = false;
    if (revoked === 'pm-capability') f.control.permission = false;
    if (revoked === 'session') f.control.sessions.delete(credentialId(subject));
    if (revoked === 'developer') f.control.developer = true;
    await expect(f.messages.reply(target, subject, { invalid: true })).rejects.toBeInstanceOf(TicketWorkflowError);
    await expect(f.messages.lookup(target, subject, input.operationId)).rejects.toBeInstanceOf(TicketWorkflowError);
    expect(f.control.calls).toEqual(['authorize', 'authorize']);
  });

  it.each(['workspace', 'ticket', 'session-binding'])('refuses %s mismatches before parsing', async field => {
    const f = fixture(); const requestTarget = { ...target }; let subject = pm;
    if (field === 'workspace') requestTarget.workspaceId = 'workspace-b';
    if (field === 'ticket') requestTarget.ticketId = 'ticket-b';
    if (field === 'session-binding') subject = { ...pm, authentication: { kind: 'session', sessionId: client.sessionId } };
    await expect(f.messages.reply(requestTarget, subject, null)).rejects.toMatchObject({ status: 404 });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it.each(['request_details', 'answer_close'])('a client cannot send PM action %s', async type => {
    const f = fixture();
    await expect(f.messages.reply(target, client, f.input({ action: { type } }))).rejects.toMatchObject({ status: 403 });
    expect(f.data.messages).toEqual([]);
  });

  it('PM cannot submit client correction feedback', async () => {
    const f = fixture();
    await expect(f.messages.reply(target, pm, f.input({ action: { type: 'request_correction', deliveryId: 'delivery-a' } }))).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    { body: '' }, { body: '  ' }, { body: 'x'.repeat(4001) }, { body: 123 },
    { expectedVersion: -1 }, { expectedVersion: 0.1 }, { expectedVersion: Number.MAX_SAFE_INTEGER },
    { operationId: '' }, { operationId: ' padded ' }, { operationId: 'x'.repeat(201) },
    { schemaVersion: 2 }, { actor: 'pm' }, { audience: 'client' }, { workspaceId: 'workspace-b' },
    { messageId: 'caller-chosen' }, { createdAt: 'caller-time' }, { facts: {} }, { attachments: [] },
    { action: { type: 'accept_delivery' } }, { action: { type: 'reply', status: 'closed' } },
  ])('rejects malformed or caller-owned reply fields', async override => {
    const f = fixture(); await expect(f.messages.reply(target, pm, f.input(override))).rejects.toMatchObject({ status: 400, code: 'invalid_ticket_message' });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('notes cannot be upgraded to public actions by adding a field', async () => {
    const f = fixture();
    await expect(f.messages.note(target, pm, f.input({ action: { type: 'answer_close' } }))).rejects.toMatchObject({ status: 400 });
    expect(f.data.messages).toEqual([]);
  });

  it.each(['', ' padded ', 'x'.repeat(201)])('refuses invalid server-generated message identities', async id => {
    const f = fixture(); f.control.generatedId = id;
    await expect(f.messages.note(target, pm, f.input())).rejects.toThrow('could not assign');
    expect(f.data.messages).toEqual([]);
  });

  it('preserves text safely and returns no message body, identities or metadata in the receipt', async () => {
    const f = fixture(); const result = await f.messages.reply(target, client, f.input({ body: '<script>plain text</script>' }));
    expect(Object.keys(result).sort()).toEqual(['messageId', 'operationId', 'status', 'ticketId', 'version']);
    expect((await f.reads.conversation(target, pm)).items[0].body).toBe('<script>plain text</script>');
    expect(JSON.stringify(result)).not.toContain('script');
  });
});
