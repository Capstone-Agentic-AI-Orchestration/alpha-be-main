import { describe, expect, it } from 'vitest';

import { DatabaseCommitError } from '../store/database.js';
import type { SavedTicketOperation, TicketChangeSignal, TicketCommandAudit, TicketCommandTransaction, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { AuthorizedTicketCreateContext, SharedTicketProjectOption, TicketCreatedAudit, TicketCreatedRecord, TicketCreationStore, TicketCreationTransaction, TicketCreateOperationKey } from '../store/ticketCreationStore.js';
import type { TicketMessageTransaction, TicketNoteAudit } from '../store/ticketMessageStore.js';
import type { TicketMessageReadRow, TicketReadTransaction } from '../store/ticketReadStore.js';
import { parsePublicTicketInquiry } from '../ticketing/intake.js';
import { createTicketCommandService } from './ticketCommandService.js';
import { createTicketCreationService } from './ticketCreationService.js';
import { createTicketMessageService } from './ticketMessageService.js';
import { createTicketReadService } from './ticketReadService.js';

const client: Extract<TicketSubject, { kind: 'client' }> = { kind: 'client', userId: 'client-a', sessionId: 'session-client-a' };
const pm: TicketSubject = { kind: 'internal', userId: 'pm-a', authentication: { kind: 'session', sessionId: 'session-pm' } };
const workspace = 'workspace-a';
const contextId = 'context-a';
const timestamp = '2026-10-08T05:00:00.000Z';
const input = (override = {}) => ({ schemaVersion: 1, operationId: 'create-op', title: 'Requested output', description: 'Explain the requested outcome.', ...override });
interface TestTransaction extends TicketCreationTransaction, TicketReadTransaction, TicketMessageTransaction {}
const targetKey = (target: TicketTarget) => JSON.stringify([target.workspaceId, target.ticketId]);
const createKey = (key: TicketCreateOperationKey) => JSON.stringify([key.workspaceId, key.clientId, key.operationId]);
const operationKey = (key: SavedTicketOperation['key']) => JSON.stringify([key.workspaceId, key.ticketId, key.actorKind, key.actorId, key.operationId]);

/** Local-only adapter shared with reads/operation recovery. Serialized callbacks
 * with rollback are not proof of real SQL/RLS or absent-key locking correctness.
 */
function fixture() {
  const context: AuthorizedTicketCreateContext = {
    id: contextId, workspaceId: workspace, clientId: client.userId, accessActive: true,
    acceptsNewRequests: true, mode: 'enabled', companyLabel: 'Approved company',
  };
  let data = {
    records: new Map<string, TicketCreatedRecord>(), grants: new Set<string>(),
    operations: new Map<string, SavedTicketOperation>(),
    createOperations: new Map<string, Extract<SavedTicketOperation, { kind: 'create' }>>(),
    audits: [] as TicketCreatedAudit[], signals: [] as TicketCreatedAudit[], messages: [] as TicketMessageReadRow[],
    messageAudits: [] as TicketCommandAudit[], noteAudits: [] as TicketNoteAudit[], changeSignals: [] as TicketChangeSignal[],
  };
  const control = {
    contexts: new Map([[contextId, context]]), sessions: new Map<string, TicketSubject>([[client.sessionId, client], ['session-pm', pm]]),
    options: new Map<string, SharedTicketProjectOption>(),
    failAt: '', skipGrant: false, grantWrongIdentity: false, grantWrongWorkspace: false, grantWrongTicket: false,
    now: timestamp, generatedId: null as string | null, reference: null as string | null,
    commitUnknown: false, calls: [] as string[], badContext: '' as string,
    corruptOperation: null as Extract<SavedTicketOperation, { kind: 'create' }> | null,
  };
  let sequence = 0; let referenceSequence = 0; let queue = Promise.resolve();
  const store = {
    async transaction<T>(work: (tx: TestTransaction) => Promise<T>): Promise<T> {
      const previous = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; }); await previous;
      const draft = structuredClone(data);
      function step(name: string) { control.calls.push(name); if (control.failAt === name) throw new Error(`Injected ${name} failure`); }
      const tx: TestTransaction = {
        async lockAuthorizedCreateContext(requestContext, subject) {
          step('context'); if (subject.kind !== 'client') return null;
          const saved = control.sessions.get(subject.sessionId); const scope = control.contexts.get(requestContext);
          if (!saved || saved.userId !== subject.userId || !scope || scope.clientId !== subject.userId) return null;
          const result = structuredClone(scope);
          if (control.badContext === 'identity') result.clientId = 'other-user';
          if (control.badContext === 'id') result.id = 'other-context';
          if (control.badContext === 'workspace') result.workspaceId = '';
          return result;
        },
        async lockCreateOperation(key) {
          step('create-key'); if (control.corruptOperation) return structuredClone(control.corruptOperation);
          return structuredClone(draft.createOperations.get(createKey(key)) ?? null);
        },
        async lockAuthorizedTicket(target, subject) {
          step('ticket-access');
          const sessionId = subject.kind === 'client' ? subject.sessionId
            : subject.authentication.kind === 'session' ? subject.authentication.sessionId : null;
          const session = sessionId ? control.sessions.get(sessionId) : null;
          const record = draft.records.get(targetKey(target));
          if (!session || session.kind !== subject.kind || session.userId !== subject.userId || !record) return null;
          if (subject.kind === 'client' && (record.state.clientId !== subject.userId
            || !draft.grants.has(JSON.stringify([target.workspaceId, target.ticketId, subject.userId])))) return null;
          if (subject.kind === 'internal' && (subject.authentication.kind !== 'session' || subject.userId !== pm.userId)) return null;
          const state = structuredClone(record.state);
          if (control.grantWrongWorkspace) state.workspaceId = 'other-workspace';
          if (control.grantWrongTicket) state.id = 'other-ticket';
          return { state, mode: context.mode, actor: subject.kind === 'client'
            ? { kind: 'client', userId: control.grantWrongIdentity ? 'other-user' : subject.userId, workspaceId: target.workspaceId, ticketId: target.ticketId, grantActive: true }
            : { kind: 'pm', userId: subject.userId, workspaceId: target.workspaceId, membershipActive: true, canManageTickets: true } };
        },
        async loadSharedProjectOption(_context, optionId) { step('option'); return structuredClone(control.options.get(optionId) ?? null); },
        async allocateReference() { step('reference'); return control.reference ?? `TICKET-${++referenceSequence}`; },
        async insertTicket(record) { step('ticket'); const key = targetKey({ workspaceId: record.state.workspaceId, ticketId: record.state.id }); if (draft.records.has(key)) throw new Error('Duplicate ticket identity'); draft.records.set(key, structuredClone(record)); },
        async grantCreatedTicket(scope, target) { step('grant'); if (!control.skipGrant) draft.grants.add(JSON.stringify([scope.workspaceId, target.ticketId, scope.clientId])); },
        async appendCreatedAudit(audit) { step('audit'); draft.audits.push(structuredClone(audit)); },
        async enqueueCreated(signal) { step('signal'); draft.signals.push(structuredClone(signal)); },
        async insertOperation(operation) { step('operation'); const key = operationKey(operation.key); if (draft.operations.has(key)) throw new Error('Duplicate operation'); draft.operations.set(key, structuredClone(operation)); },
        async insertCreateOperation(operation) { step('create-operation'); const key = createKey({ workspaceId: operation.key.workspaceId, clientId: operation.key.actorId, operationId: operation.key.operationId }); if (draft.createOperations.has(key)) throw new Error('Duplicate creation operation'); draft.createOperations.set(key, structuredClone(operation)); },
        async findOperation(key) {
          step('lookup-operation');
          const saved = draft.operations.get(operationKey(key));
          if (saved) return structuredClone(saved);
          if (key.actorKind !== 'client') return null;
          const created = draft.createOperations.get(createKey({ workspaceId: key.workspaceId, clientId: key.actorId, operationId: key.operationId }));
          return created?.key.ticketId === key.ticketId ? structuredClone(created) : null;
        },
        async loadDetail(ticket) { step('detail'); const target = { workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id }; const record = draft.records.get(targetKey(target))!; return { header: structuredClone(record.header), currentScope: null, currentDelivery: null, related: null, request: { ...structuredClone(record.request), ...target } }; },
        async loadMessages(ticket, audience, page) {
          step(`messages:${audience}`);
          const rows = draft.messages.filter(row => row.workspaceId === ticket.state.workspaceId
            && row.ticketId === ticket.state.id && row.audience === audience)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const cursor = page.after === null ? -1 : rows.findIndex(row => row.id === page.after);
          if (page.after !== null && cursor < 0) throw new Error('Unknown in-ticket message cursor');
          return structuredClone(rows.slice(cursor + 1, cursor + page.limit + 2));
        },
        async insertMessage(message) { step('message'); draft.messages.push(structuredClone(message)); },
        async updateMessageClocks(target, expectedVersion, audience, occurredAt) {
          step('message-clocks');
          const record = draft.records.get(targetKey(target));
          if (!record || record.state.version !== expectedVersion) return false;
          record.header.internalUpdatedAt = occurredAt;
          if (audience === 'client') record.header.clientUpdatedAt = occurredAt;
          return true;
        },
        async appendNoteAudit(audit) { step('note-audit'); draft.noteAudits.push(structuredClone(audit)); },
        async appendAudit(audit) { step('message-audit'); draft.messageAudits.push(structuredClone(audit)); },
        async enqueueChange(signal) { step('change-signal'); draft.changeSignals.push(structuredClone(signal)); },
        async loadFacts(ticket, envelope) {
          step('facts');
          const messageId = 'messageId' in envelope.command ? envelope.command.messageId : null;
          const message = messageId ? draft.messages.find(row => row.id === messageId
            && row.workspaceId === ticket.state.workspaceId && row.ticketId === ticket.state.id) : undefined;
          return {
            clientAccessActive: Boolean(ticket.state.clientId && draft.grants.has(JSON.stringify([ticket.state.workspaceId, ticket.state.id, ticket.state.clientId]))),
            ...(message ? { message: { id: message.id, ticketId: message.ticketId, authorId: message.authorId, audience: message.audience } } : {}),
          };
        },
        async loadAssessmentCandidate() { throw new Error('Creation cannot assess results.'); },
        async insertWorkBindings() { throw new Error('Creation cannot bind Issues.'); },
        async saveWorkflow(target, expectedVersion, state) {
          step('workflow');
          const record = draft.records.get(targetKey(target));
          if (!record || record.state.version !== expectedVersion) return false;
          record.state = structuredClone(state);
          record.header.closedAt = ['closed', 'declined', 'cancelled'].includes(state.status) ? control.now : null;
          return true;
        },
        async reopenIssues() { throw new Error('Creation cannot reopen Issues.'); },
      };
      try {
        const result = await work(tx); data = draft;
        if (control.commitUnknown) { control.commitUnknown = false; throw new DatabaseCommitError(new Error('Lost response')); }
        return result;
      } finally { release(); }
    },
  };
  // Also prove the public factory contract accepts the real transaction shape.
  const creationStore: TicketCreationStore = store;
  const service = createTicketCreationService(creationStore, () => new Date(control.now), () => control.generatedId ?? `ticket-${++sequence}`);
  const messages = createTicketMessageService(store, () => new Date(control.now), () => `message-${++sequence}`);
  return { service, messages, reads: createTicketReadService(store), commands: createTicketCommandService(store), control, context, get data() { return data; } };
}
const targetOf = (result: { ticketId: string }): TicketTarget => ({ workspaceId: workspace, ticketId: result.ticketId });

describe('authenticated ticket creation', () => {
  it('creates one Received ticket, exact grant, audit, signal and shared recovery record', async () => {
    const f = fixture(); const result = await f.service.create(contextId, client, input({ title: '  Requested output  ' }));
    expect(result).toEqual({ ticketId: 'ticket-1', reference: 'TICKET-1', operationId: 'create-op', version: 0, status: 'received' });
    const record = [...f.data.records.values()][0];
    expect(record.state).toMatchObject({ clientId: client.userId, projectId: null, requiredIssueIds: [], scopeVersionId: null, authorizedScopeVersionId: null, actionOwner: 'pm', nextAction: 'review_ticket' });
    expect(record.header).toMatchObject({ title: 'Requested output', clientUpdatedAt: timestamp, internalUpdatedAt: timestamp, clientSafeCompanyLabel: 'Approved company', relatedTicketId: null, sharedProject: null });
    expect(f.data.grants.size).toBe(1); expect(f.data.createOperations.size).toBe(1); expect(f.data.operations.size).toBe(0); expect(f.data.audits).toHaveLength(1); expect(f.data.signals).toHaveLength(1);
    expect(f.control.calls).toEqual(['context', 'create-key', 'reference', 'ticket', 'grant', 'ticket-access', 'audit', 'signal', 'create-operation']);
    expect(await f.reads.detail(targetOf(result), client)).toMatchObject({ reference: result.reference, title: 'Requested output', status: 'received', scope: null, delivery: null, sharedProjectName: null });
    expect(await f.commands.lookup(targetOf(result), client, 'create-op')).toEqual(result);
    expect(JSON.stringify(f.data.signals)).not.toMatch(/Requested output|Explain the requested outcome/);
  });
  it('carries a created request through PM public reply and private note without leaking the note to the client', async () => {
    const f = fixture();
    const created = await f.service.create(contextId, client, input());
    const target = targetOf(created);
    f.control.now = '2026-10-09T05:00:00.000Z';
    const reply = { schemaVersion: 1, operationId: 'pm-public-reply', expectedVersion: created.version, body: 'I reviewed your request and will follow up here.' };
    f.control.commitUnknown = true;
    await expect(f.messages.reply(target, pm, reply)).rejects.toBeInstanceOf(DatabaseCommitError);
    const recoveredReply = await f.messages.lookup(target, pm, reply.operationId);
    expect(recoveredReply).toMatchObject({ ticketId: created.ticketId, operationId: reply.operationId, messageId: expect.any(String) });
    const replied = await f.messages.reply(target, pm, reply);
    expect(replied).toEqual(recoveredReply);
    f.control.now = '2026-10-10T05:00:00.000Z';
    const note = { schemaVersion: 1, operationId: 'pm-private-note', expectedVersion: replied.version, body: 'Internal only: confirm the delivery estimate with the team.' };
    await f.messages.note(target, pm, note);
    await f.messages.note(target, pm, note);

    const clientConversation = await f.reads.conversation(target, client);
    const pmConversation = await f.reads.conversation(target, pm);
    const pmNotes = await f.reads.notes(target, pm);
    const clientDetail = await f.reads.detail(target, client);
    expect(clientConversation.items.map(message => message.body)).toEqual([reply.body]);
    expect(pmConversation.items.map(message => message.body)).toEqual([reply.body]);
    expect(pmNotes.items.map(message => message.body)).toEqual([note.body]);
    await expect(f.reads.notes(target, client)).rejects.toMatchObject({ status: 403 });
    expect(JSON.stringify(clientConversation)).not.toContain(note.body);
    expect(JSON.stringify(clientDetail)).not.toContain(note.body);
    expect(f.data.messages.map(message => message.audience)).toEqual(['client', 'internal']);
    const record = [...f.data.records.values()][0];
    expect(record.header.clientUpdatedAt).toBe('2026-10-09T05:00:00.000Z');
    expect(record.header.internalUpdatedAt).toBe('2026-10-10T05:00:00.000Z');
    expect(f.data.noteAudits).toHaveLength(1);
    expect(f.data.messageAudits).toHaveLength(1);
    expect(f.data.changeSignals).toHaveLength(1);
    expect(JSON.stringify(f.data.messageAudits)).not.toContain(note.body);
    expect(JSON.stringify(f.data.changeSignals)).not.toContain(note.body);
  });
  it('treats a shared project and deadline as preferences, not an approved project or commitment', async () => {
    const f = fixture(); f.control.options.set('option-a', { id: 'option-a', workspaceId: workspace, clientId: client.userId, projectId: 'internal-project', displayName: 'Shared preview label', active: true, clientVisible: true });
    const result = await f.service.create(contextId, client, input({ projectPreference: { kind: 'shared_project', optionId: 'option-a' }, requestedDeadline: '2027-02-28' }));
    const record = [...f.data.records.values()][0];
    expect(record.request).toMatchObject({ preferredProjectId: 'internal-project', requestedDeadline: '2027-02-28' });
    expect(record.state).toMatchObject({ projectId: null, authorizedScopeVersionId: null, requiredIssueIds: [] });
    expect(JSON.stringify(result)).not.toMatch(/internal-project|2027-02-28/);
    const detail = await f.reads.detail(targetOf(result), client);
    expect(detail).toMatchObject({ request: { projectPreference: 'shared_project', projectLabel: 'Shared preview label', requestedDeadline: '2027-02-28' }, sharedProjectName: null });
    expect(JSON.stringify(detail)).not.toContain('internal-project');
  });
  it.each(['new_project', 'not_sure'] as const)('keeps project preference %s from creating project work', async kind => {
    const f = fixture(); await f.service.create(contextId, client, input({ projectPreference: { kind } }));
    expect([...f.data.records.values()][0].state).toMatchObject({ projectId: null, requiredIssueIds: [] }); expect(f.control.calls).not.toContain('option');
  });
  it('creates a separate linked follow-up without copying or mutating accepted history', async () => {
    const f = fixture(); const original = await f.service.create(contextId, client, input());
    const record = f.data.records.get(targetKey(targetOf(original)))!;
    record.state.status = 'closed'; record.state.projectId = 'project-old'; record.state.authorizedScopeVersionId = 'scope-old'; record.state.requiredIssueIds = ['issue-old']; record.header.closedAt = timestamp;
    const before = structuredClone(record);
    const followup = await f.service.create(contextId, client, input({ operationId: 'followup', relatedTicketId: original.ticketId }));
    expect(f.data.records.get(targetKey(targetOf(original)))).toEqual(before);
    const next = f.data.records.get(targetKey(targetOf(followup)))!;
    expect(next.header.relatedTicketId).toBe(original.ticketId); expect(next.state).toMatchObject({ status: 'received', projectId: null, requiredIssueIds: [], authorizedScopeVersionId: null });
  });
  it.each(['foreign', 'revoked', 'other-client', 'other-workspace'])('refuses %s follow-up links before inserting any new record', async condition => {
    const f = fixture(); const original = await f.service.create(contextId, client, input()); const record = f.data.records.get(targetKey(targetOf(original)))!;
    let relatedTicketId = original.ticketId;
    if (condition === 'foreign') relatedTicketId = 'not-mine';
    if (condition === 'revoked') f.data.grants.clear();
    if (condition === 'other-client') record.state.clientId = 'client-b';
    if (condition === 'other-workspace') { f.data.records.delete(targetKey(targetOf(original))); record.state.workspaceId = 'workspace-b'; f.data.records.set(targetKey({ workspaceId: 'workspace-b', ticketId: original.ticketId }), record); }
    const before = structuredClone(f.data);
    await expect(f.service.create(contextId, client, input({ operationId: 'new-op', relatedTicketId }))).rejects.toMatchObject({ status: 404 }); expect(f.data).toEqual(before);
  });
  it.each(['absent', 'workspace', 'client', 'id', 'inactive', 'unpublished'])('refuses %s project option without exposing its contents', async condition => {
    const f = fixture(); const option: SharedTicketProjectOption = { id: 'option-a', workspaceId: workspace, clientId: client.userId, projectId: 'internal-project', displayName: 'Private label', active: true, clientVisible: true };
    if (condition === 'workspace') option.workspaceId = 'workspace-b'; if (condition === 'client') option.clientId = 'client-b';
    if (condition === 'id') option.id = 'option-b'; if (condition === 'inactive') option.active = false; if (condition === 'unpublished') option.clientVisible = false;
    if (condition !== 'absent') f.control.options.set('option-a', option);
    await expect(f.service.create(contextId, client, input({ projectPreference: { kind: 'shared_project', optionId: 'option-a' } }))).rejects.toMatchObject({ status: 404 }); expect(f.data.records.size).toBe(0);
  });
});

describe('atomicity, operation identity and recovery', () => {
  it.each(['reference', 'ticket', 'grant', 'ticket-access', 'audit', 'signal', 'create-operation'])('rolls back the entire creation on %s failure', async stage => {
    const f = fixture(); f.control.failAt = stage;
    await expect(f.service.create(contextId, client, input())).rejects.toThrow(`Injected ${stage} failure`);
    expect(f.data.records.size + f.data.grants.size + f.data.operations.size + f.data.createOperations.size + f.data.audits.length + f.data.signals.length).toBe(0);
    f.control.failAt = ''; expect(await f.service.create(contextId, client, input())).toMatchObject({ status: 'received' }); expect(f.data.records.size).toBe(1);
  });
  it.each(['skipGrant', 'grantWrongIdentity', 'grantWrongWorkspace', 'grantWrongTicket'] as const)('fails atomically if created access is inconsistent: %s', async flag => {
    const f = fixture(); f.control[flag] = true;
    await expect(f.service.create(contextId, client, input())).rejects.toMatchObject({ status: 404 }); expect(f.data.records.size).toBe(0); expect(f.data.grants.size).toBe(0);
  });
  it('deduplicates simultaneous copies before allocating IDs/references or emitting signals', async () => {
    const f = fixture(); const results = await Promise.all(Array.from({ length: 8 }, () => f.service.create(contextId, client, input())));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(f.data.records.size).toBe(1); expect(f.data.signals).toHaveLength(1); expect(f.control.calls.filter(name => name === 'reference')).toHaveLength(1);
  });
  it('different operation IDs are distinct intentional requests, with server references', async () => {
    const f = fixture(); const first = await f.service.create(contextId, client, input()); const next = await f.service.create(contextId, client, input({ operationId: 'next' }));
    expect(first.ticketId).not.toBe(next.ticketId); expect(first.reference).not.toBe(next.reference); expect(f.data.records.size).toBe(2);
  });
  it('the same operation ID is isolated across separately authorized clients and workspaces', async () => {
    const f = fixture(); const original = await f.service.create(contextId, client, input());
    const other: typeof client = { kind: 'client', userId: 'client-b', sessionId: 'session-client-b' };
    f.control.sessions.set(other.sessionId, other);
    f.control.contexts.set('context-b', { ...f.context, id: 'context-b', clientId: other.userId });
    const second = await f.service.create('context-b', other, input());
    f.control.contexts.set('context-c', { ...f.context, id: 'context-c', workspaceId: 'workspace-c' });
    const third = await f.service.create('context-c', client, input());
    expect(new Set([original.ticketId, second.ticketId, third.ticketId]).size).toBe(3);
    expect(await f.service.lookup('context-b', other, 'create-op')).toEqual(second);
    expect(await f.service.lookup('context-c', client, 'create-op')).toEqual(third);
    await expect(f.service.lookup(contextId, other, 'create-op')).rejects.toMatchObject({ status: 404 });
  });
  it('retains a safe saved receipt if a previously selected project option is later withdrawn', async () => {
    const f = fixture(); f.control.options.set('option-a', { id: 'option-a', workspaceId: workspace, clientId: client.userId, projectId: 'project-a', displayName: 'Shared name', active: true, clientVisible: true });
    const request = input({ projectPreference: { kind: 'shared_project', optionId: 'option-a' } });
    const first = await f.service.create(contextId, client, request); f.control.options.clear();
    expect(await f.service.create(contextId, client, request)).toEqual(first);
    expect(f.data.records.size).toBe(1);
  });
  it('canonicalizes trimmed text, key order and defaults for safe replay', async () => {
    const f = fixture(); const first = await f.service.create(contextId, client, input({ title: ' Requested output ' }));
    expect(await f.service.create(contextId, client, { description: 'Explain the requested outcome.', title: 'Requested output', operationId: 'create-op', schemaVersion: 1, relatedTicketId: null, requestedDeadline: null, projectPreference: { kind: 'not_sure' } })).toEqual(first);
  });
  it.each(['title', 'description', 'deadline', 'preference', 'context'])('conflicts on changed %s with the same operation ID', async field => {
    const f = fixture(); await f.service.create(contextId, client, input());
    let requestedContext = contextId;
    if (field === 'context') { requestedContext = 'context-b'; f.control.contexts.set(requestedContext, { ...f.context, id: requestedContext }); }
    const override = field === 'title' ? { title: 'Changed' } : field === 'description' ? { description: 'Changed' } : field === 'deadline' ? { requestedDeadline: '2027-01-01' } : field === 'preference' ? { projectPreference: { kind: 'new_project' } } : {};
    await expect(f.service.create(requestedContext, client, input(override))).rejects.toMatchObject({ code: 'ticket_operation_conflict' }); expect(f.data.records.size).toBe(1);
  });
  it('replays original creation after later status changes, not a fabricated live outcome', async () => {
    const f = fixture(); const first = await f.service.create(contextId, client, input()); f.data.records.get(targetKey(targetOf(first)))!.state.status = 'closed';
    expect(await f.service.create(contextId, client, input())).toEqual(first); expect((await f.reads.detail(targetOf(first), client)).status).toBe('closed');
  });
  it('reconciles a lost COMMIT using the dedicated creation operation without duplication', async () => {
    const f = fixture(); f.control.commitUnknown = true;
    await expect(f.service.create(contextId, client, input())).rejects.toBeInstanceOf(DatabaseCommitError);
    const receipt = await f.service.lookup(contextId, client, 'create-op'); expect(receipt).toMatchObject({ ticketId: 'ticket-1', reference: 'TICKET-1' });
    expect(await f.commands.lookup(targetOf(receipt!), client, 'create-op')).toEqual(receipt); expect(await f.service.create(contextId, client, input())).toEqual(receipt); expect(f.data.records.size).toBe(1);
  });
  it('shared ticket command endpoint cannot reuse the creation operation ID', async () => {
    const f = fixture(); const first = await f.service.create(contextId, client, input());
    await expect(f.commands.execute(targetOf(first), client, { schemaVersion: 1, operationId: 'create-op', expectedVersion: 0, command: { type: 'reply', messageId: 'caller-id' } })).rejects.toMatchObject({ code: 'ticket_operation_conflict' });
  });
  it.each(['context', 'ticket-grant', 'session'])('refuses replay and lookup after %s revocation', async revoked => {
    const f = fixture(); await f.service.create(contextId, client, input());
    if (revoked === 'context') f.context.accessActive = false;
    if (revoked === 'ticket-grant') f.data.grants.clear();
    if (revoked === 'session') f.control.sessions.clear();
    await expect(f.service.create(contextId, client, input())).rejects.toMatchObject({ status: 404 }); await expect(f.service.lookup(contextId, client, 'create-op')).rejects.toMatchObject({ status: 404 });
  });
  it('checks created-ticket access before revealing a changed-payload conflict', async () => {
    const f = fixture(); await f.service.create(contextId, client, input()); f.data.grants.clear();
    await expect(f.service.create(contextId, client, input({ title: 'Changed' }))).rejects.toMatchObject({ status: 404 });
  });
  it.each(['disabled', 'maintenance', undefined] as const)('blocks new/replayed writes under mode %s but retains authorized lookup', async mode => {
    const f = fixture(); const first = await f.service.create(contextId, client, input()); f.context.mode = mode;
    await expect(f.service.create(contextId, client, input())).rejects.toMatchObject({ status: 503 }); expect(await f.service.lookup(contextId, client, 'create-op')).toEqual(first);
  });
  it('new intake disabled does not erase retained operation recovery', async () => {
    const f = fixture(); const first = await f.service.create(contextId, client, input()); f.context.acceptsNewRequests = false;
    await expect(f.service.create(contextId, client, input())).rejects.toMatchObject({ status: 503 }); expect(await f.service.lookup(contextId, client, 'create-op')).toEqual(first);
  });
  it('returns no title, body, contact, private project, deadline or arbitrary saved fields in receipts', async () => {
    const f = fixture(); const first = await f.service.create(contextId, client, input());
    Object.assign([...f.data.createOperations.values()][0].receipt, { body: 'private', actorId: 'secret', reference: 'injected' });
    expect(await f.service.lookup(contextId, client, 'create-op')).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(['operationId', 'reference', 'status', 'ticketId', 'version']);
  });
  it.each(['workspace', 'actor', 'kind', 'ticket', 'receipt', 'reference', 'version', 'status'])('rejects corrupted creation evidence (%s)', async field => {
    const f = fixture(); await f.service.create(contextId, client, input()); const saved = [...f.data.createOperations.values()][0]; if (saved.kind !== 'create') throw new Error('fixture');
    f.control.corruptOperation = saved;
    if (field === 'workspace') saved.key.workspaceId = 'other'; if (field === 'actor') saved.key.actorId = 'other'; if (field === 'kind') saved.key.actorKind = 'pm';
    if (field === 'ticket') saved.key.ticketId = ''; if (field === 'receipt') saved.receipt.ticketId = 'other'; if (field === 'reference') saved.reference = ' padded ';
    if (field === 'version') saved.receipt.version = 1; if (field === 'status') saved.receipt.status = 'closed';
    await expect(f.service.lookup(contextId, client, 'create-op')).rejects.toThrow('store returned');
  });
});

describe('intake authorization and validation', () => {
  it('forbids internal personas without reading intake contexts or parsing their body', async () => {
    const f = fixture(); await expect(f.service.create(contextId, pm, { bad: true })).rejects.toMatchObject({ status: 403 }); expect(f.control.calls).toEqual([]);
  });
  it.each(['absent', 'identity', 'id', 'workspace', 'session-binding'])('refuses %s context before body validation', async failure => {
    const f = fixture(); let subject = client;
    if (failure === 'absent') f.control.contexts.clear(); else if (failure === 'session-binding') subject = { ...client, userId: 'client-b' }; else f.control.badContext = failure;
    await expect(f.service.create(contextId, subject, { bad: true })).rejects.toMatchObject({ status: 404 }); expect(f.control.calls).toEqual(['context']);
  });
  it.each([
    { title: '' }, { title: ' ' }, { title: 'x'.repeat(161) }, { description: '' }, { description: 'x'.repeat(6001) },
    { operationId: '' }, { operationId: ' padded ' }, { operationId: 'x'.repeat(201) }, { schemaVersion: 2 },
    { requestedDeadline: '2027-02-29' }, { requestedDeadline: '2026-13-01' }, { requestedDeadline: 'tomorrow' },
    { workspaceId: 'other' }, { projectId: 'internal' }, { clientId: 'other' }, { email: 'caller@example.test' },
    { status: 'in_progress' }, { createdAt: timestamp }, { reference: 'caller' }, { attachments: [] },
    { actor: 'pm' }, { grantActive: true }, { projectPreference: { kind: 'shared_project', optionId: ' option ' } },
  ])('rejects malformed or caller-owned fields before mutation', async override => {
    const f = fixture(); await expect(f.service.create(contextId, client, input(override))).rejects.toMatchObject({ status: 400, code: 'invalid_ticket_intake' }); expect(f.control.calls).toEqual(['context']);
  });
  it.each(['', ' padded ', 'x'.repeat(201)])('refuses invalid generated ID/reference %s atomically', async value => {
    for (const field of ['generatedId', 'reference'] as const) { const f = fixture(); f.control[field] = value; await expect(f.service.create(contextId, client, input())).rejects.toThrow('server could not assign'); expect(f.data.records.size).toBe(0); }
  });
  it('invalid server clock does not save a ticket', async () => {
    const f = fixture(); f.control.now = 'invalid'; await expect(f.service.create(contextId, client, input())).rejects.toThrow(); expect(f.data.records.size).toBe(0);
  });
  it('a generated identity collision rolls back instead of overwriting an existing request', async () => {
    const f = fixture(); await f.service.create(contextId, client, input()); f.control.generatedId = 'ticket-1'; const before = structuredClone(f.data);
    await expect(f.service.create(contextId, client, input({ operationId: 'another' }))).rejects.toThrow('Duplicate ticket'); expect(f.data).toEqual(before);
  });
  it('missing operation lookup does not fabricate success', async () => {
    const f = fixture(); expect(await f.service.lookup(contextId, client, 'absent')).toBeNull();
  });
  it('uses one dedicated insert-only row for both create idempotency and recovery', async () => {
    const f = fixture(); await f.service.create(contextId, client, input());
    expect(f.data.createOperations.size).toBe(1);
    expect(f.data.operations.size).toBe(0);
    expect(f.data.createOperations.get(createKey({ workspaceId: workspace, clientId: client.userId, operationId: 'create-op' }))?.key.ticketId).toBe('ticket-1');
  });
  it.each(['', ' padded ', 'x'.repeat(201)])('rejects invalid lookup ID %s after authorization', async id => {
    const f = fixture(); await expect(f.service.lookup(contextId, client, id)).rejects.toMatchObject({ status: 400 }); expect(f.control.calls).toEqual(['context']);
  });
});

describe('text-only public inquiry contract (not enabled public submission)', () => {
  const inquiry = () => ({ ...input({ operationId: 'ea835b50-e87a-4d48-9b66-70cda34a0b37' }), fullName: 'Client Name', email: 'client@example.test' });
  it('accepts the small agreed contact/request fields without treating email as identity', () => {
    expect(parsePublicTicketInquiry({ ...inquiry(), fullName: ' Client Name ', company: ' Example ', requestedDeadline: '2028-02-29' })).toMatchObject({ fullName: 'Client Name', email: 'client@example.test', company: 'Example', requestedDeadline: '2028-02-29' });
  });
  it.each([
    { fullName: '' }, { email: 'invalid' }, { company: '' }, { fullName: 'x'.repeat(161) },
    { requestedDeadline: '2027-02-29' }, { attachments: [] }, { workspaceId: 'caller' },
    { clientId: 'caller' }, { projectId: 'caller' }, { emailVerified: true }, { company: 'x'.repeat(161) },
  ])('rejects untrusted public inquiry fields', override => {
    expect(() => parsePublicTicketInquiry({ ...inquiry(), ...override })).toThrow('ticket request is invalid');
  });
});
