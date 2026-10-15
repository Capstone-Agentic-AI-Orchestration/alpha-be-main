import { describe, expect, it } from 'vitest';

import type { LockedTicket, TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketDetailRows, TicketMessageReadRow, TicketReadStore, TicketReadTransaction } from '../store/ticketReadStore.js';
import {
  projectClientTicketDetail, projectPmTicketDetail, projectTicketMessage, TicketReadInvariantError,
} from '../ticketing/readModels.js';
import { newTicketWorkflow, TicketWorkflowError } from '../ticketing/workflow.js';
import { createTicketReadService } from './ticketReadService.js';

const target = { workspaceId: 'workspace-a', ticketId: 'ticket-a' };
const client: Extract<TicketSubject, { kind: 'client' }> = { kind: 'client', userId: 'client-a', sessionId: 'session-client' };
const pm: TicketSubject = { kind: 'internal', userId: 'pm-a', authentication: { kind: 'session', sessionId: 'session-pm' } };
const timestamp = '2026-10-08T03:00:00.000Z';
const privateTime = '2026-10-08T04:00:00.000Z';
function message(id: string, audience: 'client' | 'internal' = 'client'): TicketMessageReadRow {
  return {
    ...target, id, authorKind: 'pm', authorId: 'pm-a', audience, body: `Text ${id}`, createdAt: timestamp,
  };
}

/** Test-only read adapter. No production database, auth/provider or network. */
function fixture() {
  const state = newTicketWorkflow(target.ticketId, target.workspaceId, client.userId);
  const detail: TicketDetailRows = {
    header: {
      ...target, reference: 'REF-1', title: 'Request', description: 'Original inquiry', clientSafeCompanyLabel: 'Client service',
      createdAt: timestamp, clientUpdatedAt: timestamp, internalUpdatedAt: privateTime,
      closedAt: null, relatedTicketId: null, sharedProject: null,
    },
    currentScope: null, currentDelivery: null, related: null,
  };
  const control = {
    access: true, active: true, permission: true, mode: 'enabled' as LockedTicket['mode'],
    wrongActor: false, wrongTicket: false, developer: false,
    detail, messages: [] as TicketMessageReadRow[],
    rawMessages: null as TicketMessageReadRow[] | null,
    calls: [] as string[], pages: [] as unknown[],
  };
  const store: TicketReadStore = {
    async transaction<T>(work: (tx: TicketReadTransaction) => Promise<T>): Promise<T> {
      // A readonly fixture only; does not model SQL snapshots/revocation locks.
      return await work({
        async lockAuthorizedTicket(requestTarget, subject) {
          control.calls.push('authorize');
          if (!control.access || requestTarget.workspaceId !== state.workspaceId || requestTarget.ticketId !== state.id) return null;
          if (subject.kind === 'client' && (subject.userId !== client.userId || subject.sessionId !== client.sessionId)) return null;
          if (subject.kind === 'internal' && (subject.userId !== pm.userId || subject.authentication.kind !== 'session'
            || subject.authentication.sessionId !== 'session-pm')) return null;
          const snapshot = structuredClone(state);
          if (control.wrongTicket) snapshot.id = 'ticket-b';
          const userId = control.wrongActor ? 'wrong-user' : subject.userId;
          return {
            state: snapshot, mode: control.mode,
            actor: subject.kind === 'client'
              ? { kind: 'client', userId, workspaceId: target.workspaceId, ticketId: state.id, grantActive: control.active }
              : control.developer ? { kind: 'developer', userId, workspaceId: target.workspaceId }
                : { kind: 'pm', userId, workspaceId: target.workspaceId, membershipActive: control.active, canManageTickets: control.permission },
          };
        },
        async loadDetail() { control.calls.push('detail'); return structuredClone(control.detail); },
        async loadMessages(_ticket, audience, page) {
          control.calls.push(`messages:${audience}`); control.pages.push({ audience, ...page });
          if (control.rawMessages) return structuredClone(control.rawMessages);
          const rows = control.messages.filter(row => row.workspaceId === target.workspaceId && row.ticketId === target.ticketId && row.audience === audience)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const cursor = page.after === null ? -1 : rows.findIndex(row => row.id === page.after);
          if (page.after !== null && cursor === -1) throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
          return structuredClone(rows.slice(cursor + 1, cursor + 1 + page.limit + 1));
        },
      });
    },
  };
  const service = createTicketReadService(store);
  const locked = (subject: TicketSubject = client): LockedTicket => ({
    state, mode: control.mode,
    actor: subject.kind === 'client'
      ? { kind: 'client', userId: client.userId, workspaceId: target.workspaceId, ticketId: state.id, grantActive: control.active }
      : { kind: 'pm', userId: pm.userId, workspaceId: target.workspaceId, membershipActive: control.active, canManageTickets: control.permission },
  });
  function scope() {
    state.scopeVersionId = 'scope-a';
    detail.currentScope = { ...target, id: 'scope-a', publicSummary: 'Agreed public brief', immutable: true, clientVisible: true, proposedAt: timestamp };
  }
  function shared() {
    scope(); state.projectId = 'project-a'; state.status = 'ready_for_review'; state.actionOwner = 'client'; state.nextAction = 'review_result';
    state.delivery = {
      id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'private-asset', issueRevisionIds: ['private-revision'],
      assessedByPmId: 'private-pm-id', shared: true, acceptedByClientId: null,
    };
    detail.currentDelivery = {
      ...target, id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'private-asset', issueRevisionIds: ['private-revision'],
      immutable: true, clientVisible: true, publicSummary: 'Result to review', sharedAt: timestamp,
    };
  }
  return { service, control, state, detail, locked, scope, shared };
}

describe('authorized ticket detail reads', () => {
  it('maps an explicit client-safe detail without internal clocks, actors or project records', async () => {
    const f = fixture();
    f.state.projectId = 'private-project'; f.state.requiredIssueIds = ['private-issue'];
    Object.assign(f.detail.header, { privateNote: 'private-note', githubToken: 'private-token', repositoryUrl: 'private-repository' });
    const detail = await f.service.detail(target, client);
    expect(detail).toEqual({
      id: target.ticketId, reference: 'REF-1', title: 'Request', description: 'Original inquiry', companyLabel: 'Client service',
      status: 'received', version: 0, createdAt: timestamp, updatedAt: timestamp, closedAt: null,
      readOnly: false, writesAvailable: true, requestedAction: null,
      sharedProjectName: null, relatedTicket: null, scope: null, delivery: null, request: null,
    });
    for (const secret of ['private-project', 'private-issue', privateTime, 'private-note', 'private-token', 'private-repository']) {
      expect(JSON.stringify(detail)).not.toContain(secret);
    }
    expect(f.control.calls).toEqual(['authorize', 'detail']);
  });

  it('adds only the deliberate internal PM fields', async () => {
    const f = fixture(); f.state.projectId = 'project-a'; f.state.requiredIssueIds = ['issue-a'];
    const result = await f.service.detail(target, pm);
    expect(result).toHaveProperty('internal', {
      updatedAt: privateTime, projectId: 'project-a', requiredIssueIds: ['issue-a'], actionOwner: 'pm', nextAction: 'review_ticket',
      authorizedScopeVersionId: null, correctionRequestedFor: null, withdrawalRequested: false, closureReason: null,
      scopeVersion: null, deliveryAssessment: null, request: null,
      projectName: null, projectClientVisible: false,
    });
    if ('internal' in result) result.internal.requiredIssueIds.push('mutation');
    expect(f.state.requiredIssueIds).toEqual(['issue-a']);
  });

  it.each([false, true])('projects the stored contact verification fact %s without granting access', async emailVerified => {
    const f = fixture();
    f.state.clientId = null;
    f.detail.request = {
      ...target, source: 'public_inquiry', projectPreference: { kind: 'not_sure' },
      preferredProjectId: null, requestedProjectLabel: null, requestedDeadline: null,
      contact: { fullName: 'Inquiry Client', email: 'client@example.test', company: null, emailVerified },
    };
    const detail = await f.service.detail(target, pm);
    expect(detail).toMatchObject({ internal: { request: { contact: {
      verification: emailVerified ? 'verified' : 'unverified_submission',
    } } } });
    expect(f.state.clientId).toBeNull();
    expect(f.state.status).toBe('received');
  });

  it('rejects a missing verification fact instead of inventing a contact status', async () => {
    const f = fixture();
    f.detail.request = {
      ...target, source: 'public_inquiry', projectPreference: { kind: 'not_sure' },
      preferredProjectId: null, requestedProjectLabel: null, requestedDeadline: null,
      contact: { fullName: 'Inquiry Client', email: 'client@example.test', company: null,
        emailVerified: undefined as unknown as boolean },
    };
    await expect(f.service.detail(target, pm)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it('never derives the client-visible update from private activity', async () => {
    const f = fixture();
    const before = await f.service.detail(target, client);
    f.detail.header.internalUpdatedAt = '2026-10-09T04:00:00.000Z';
    Object.assign(f.detail, { notes: [{ body: 'private-only-change' }], noteCount: 10 });
    expect(await f.service.detail(target, client)).toEqual(before);
  });

  it.each(['closed', 'declined', 'cancelled'] as const)('retains %s history without write affordances', async status => {
    const f = fixture(); f.state.status = status; f.state.actionOwner = null; f.state.nextAction = null; f.detail.header.closedAt = timestamp;
    expect(await f.service.detail(target, client)).toMatchObject({ status, readOnly: true, writesAvailable: false, requestedAction: null });
    expect(f.state.status).toBe(status);
  });

  it.each(['disabled', 'maintenance', undefined] as const)('retains authorized history with writes unavailable for gate %s', async mode => {
    const f = fixture(); f.control.mode = mode; f.state.actionOwner = 'client'; f.state.nextAction = 'reply';
    expect(await f.service.detail(target, client)).toMatchObject({ writesAvailable: false, requestedAction: null });
  });

  it('shows only an explicitly shared project display name, never its ID or repository', async () => {
    const f = fixture(); f.state.projectId = 'project-a';
    f.detail.header.sharedProject = { projectId: 'project-a', displayName: 'Client website', clientVisible: false };
    expect(await f.service.detail(target, client)).toHaveProperty('sharedProjectName', null);
    f.detail.header.sharedProject.clientVisible = true;
    const detail = await f.service.detail(target, client);
    expect(detail).toHaveProperty('sharedProjectName', 'Client website');
    expect(JSON.stringify(detail)).not.toContain('project-a');
  });

  it('shows the exact current published immutable scope and its agreement', async () => {
    const f = fixture(); f.scope(); f.state.actionOwner = 'client'; f.state.nextAction = 'agree_scope';
    expect(await f.service.detail(target, client)).toMatchObject({ requestedAction: 'agree_scope', scope: { id: 'scope-a', agreed: false } });
    f.state.agreedScopeVersionId = 'scope-a';
    expect(await f.service.detail(target, client)).toHaveProperty('scope.agreed', true);
  });

  it('does not expose an internal scope draft', async () => {
    const f = fixture(); f.scope(); f.detail.currentScope!.clientVisible = false;
    expect(await f.service.detail(target, client)).toHaveProperty('scope', null);
  });

  it.each(['missing', 'private', 'mutable', 'foreign', 'wrong-id'])('refuses an unverified %s scope when asking a client to agree it', async invalid => {
    const f = fixture(); f.scope(); f.state.actionOwner = 'client'; f.state.nextAction = 'agree_scope';
    if (invalid === 'missing') f.detail.currentScope = null;
    else if (invalid === 'private') f.detail.currentScope!.clientVisible = false;
    else if (invalid === 'mutable') f.detail.currentScope!.immutable = false;
    else if (invalid === 'foreign') f.detail.currentScope!.workspaceId = 'workspace-b';
    else f.detail.currentScope!.id = 'scope-b';
    await expect(f.service.detail(target, client)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it('shows only the deliberately shared pinned delivery and acceptance on that exact result', async () => {
    const f = fixture(); f.shared();
    const detail = await f.service.detail(target, client);
    expect(detail).toHaveProperty('delivery', { id: 'delivery-a', scopeVersionId: 'scope-a', summary: 'Result to review', sharedAt: timestamp, accepted: false });
    expect(detail).toHaveProperty('requestedAction', 'review_result');
    expect(JSON.stringify(detail)).not.toMatch(/private-(asset|revision|pm-id)/);
    f.state.delivery!.acceptedByClientId = client.userId; f.state.actionOwner = 'pm'; f.state.nextAction = 'close_ticket';
    expect(await f.service.detail(target, client)).toMatchObject({ delivery: { accepted: true }, requestedAction: null, status: 'ready_for_review' });
    expect(f.state.status).toBe('ready_for_review');
  });

  it('does not publish an assessed result before PM sharing', async () => {
    const f = fixture(); f.shared(); f.state.delivery!.shared = false; f.state.status = 'in_progress'; f.state.actionOwner = 'pm'; f.state.nextAction = 'share_result';
    expect(await f.service.detail(target, client)).toHaveProperty('delivery', null);
  });

  it('lets PM inspect an unshared assessment on Tickets without exposing it to the client', async () => {
    const f = fixture(); f.shared(); f.state.delivery!.shared = false; f.state.status = 'in_progress'; f.state.actionOwner = 'pm'; f.state.nextAction = 'share_result';
    const pmDetail = await f.service.detail(target, pm);
    expect(pmDetail).toHaveProperty('internal.deliveryAssessment', {
      id: 'delivery-a', scopeVersionId: 'scope-a', summary: 'Result to review', pinnedAssetId: 'private-asset',
      issueRevisionIds: ['private-revision'], immutable: true, clientVisible: true, shared: false,
    });
    expect(await f.service.detail(target, client)).toHaveProperty('delivery', null);
    if ('internal' in pmDetail) pmDetail.internal.deliveryAssessment!.issueRevisionIds.push('mutation');
    expect(f.detail.currentDelivery!.issueRevisionIds).toEqual(['private-revision']);
  });

  it('lets PM inspect an unpublished scope without publishing its draft', async () => {
    const f = fixture(); f.scope(); f.detail.currentScope!.clientVisible = false;
    expect(await f.service.detail(target, pm)).toHaveProperty('internal.scopeVersion', {
      id: 'scope-a', summary: 'Agreed public brief', developerBrief: null,
      proposedAt: timestamp, immutable: true, clientVisible: false,
    });
    expect(await f.service.detail(target, client)).toHaveProperty('scope', null);
  });

  it.each(['missing', 'private', 'mutable', 'unpinned', 'wrong-asset', 'wrong-scope', 'wrong-revisions', 'unshared', 'foreign'])('refuses %s shared delivery evidence', async invalid => {
    const f = fixture(); f.shared();
    const row = f.detail.currentDelivery!;
    if (invalid === 'missing') f.detail.currentDelivery = null;
    if (invalid === 'private') row.clientVisible = false;
    if (invalid === 'mutable') row.immutable = false;
    if (invalid === 'unpinned') row.pinnedAssetId = '';
    if (invalid === 'wrong-asset') row.pinnedAssetId = 'asset-b';
    if (invalid === 'wrong-scope') row.scopeVersionId = 'scope-b';
    if (invalid === 'wrong-revisions') row.issueRevisionIds = ['other-revision'];
    if (invalid === 'unshared') row.sharedAt = null;
    if (invalid === 'foreign') row.ticketId = 'ticket-b';
    await expect(f.service.detail(target, client)).rejects.toThrow('could not be verified');
  });

  it('does not show a linked ticket merely because its ID was attached', async () => {
    const f = fixture(); f.detail.header.relatedTicketId = 'ticket-b';
    f.detail.related = { workspaceId: target.workspaceId, ticketId: 'ticket-b', reference: 'REF-2', title: 'Other request', clientId: client.userId, clientGrantActive: false };
    expect(await f.service.detail(target, client)).toHaveProperty('relatedTicket', null);
    f.detail.related.clientGrantActive = true;
    expect(await f.service.detail(target, client)).toHaveProperty('relatedTicket', { id: 'ticket-b', reference: 'REF-2', title: 'Other request' });
    f.detail.related.clientId = 'client-b';
    expect(await f.service.detail(target, client)).toHaveProperty('relatedTicket', null);
  });

  it.each(['header', 'scope', 'delivery', 'related', 'project-label'])('fails closed on a mis-scoped %s row', async part => {
    const f = fixture(); f.shared();
    if (part === 'header') f.detail.header.workspaceId = 'workspace-b';
    if (part === 'scope') f.detail.currentScope!.ticketId = 'ticket-b';
    if (part === 'delivery') f.detail.currentDelivery!.workspaceId = 'workspace-b';
    if (part === 'related') {
      f.detail.header.relatedTicketId = 'ticket-b';
      f.detail.related = { workspaceId: 'workspace-b', ticketId: 'ticket-b', reference: 'REF-2', title: 'Hidden', clientId: client.userId, clientGrantActive: true };
    }
    if (part === 'project-label') f.detail.header.sharedProject = { projectId: 'project-b', displayName: 'Wrong project', clientVisible: true };
    await expect(f.service.detail(target, client)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it('does not request client action while withdrawal handling is pending', async () => {
    const f = fixture(); f.state.actionOwner = 'client'; f.state.nextAction = 'reply'; f.state.withdrawalRequested = true;
    expect(await f.service.detail(target, client)).toHaveProperty('requestedAction', null);
  });

  it('a direct client call cannot use the PM projection to expose internals', () => {
    const f = fixture();
    expect(() => projectPmTicketDetail(f.locked(), f.detail)).toThrow(TicketWorkflowError);
    f.control.active = false;
    expect(() => projectClientTicketDetail(f.locked(), f.detail)).toThrow(TicketWorkflowError);
  });
});

describe('public ticket conversation and separate PM notes', () => {
  it('returns the same public thread to PM and client without member IDs', async () => {
    const f = fixture();
    f.control.messages = [message('m1'), { ...message('m2'), authorKind: 'client', authorId: client.userId }, message('n1', 'internal')];
    const clientPage = await f.service.conversation(target, client);
    expect(await f.service.conversation(target, pm)).toEqual(clientPage);
    expect(clientPage.items.map(row => row.id)).toEqual(['m1', 'm2']);
    expect(JSON.stringify(clientPage)).not.toContain('authorId');
    expect(JSON.stringify(clientPage)).not.toContain('n1');
    expect(f.control.pages).toEqual([{ audience: 'client', limit: 50, after: null }, { audience: 'client', limit: 50, after: null }]);
  });

  it('reads private notes through the separate PM-only method', async () => {
    const f = fixture(); f.control.messages = [message('m1'), message('n1', 'internal')];
    expect(await f.service.notes(target, pm)).toEqual({ items: [{ id: 'n1', author: 'pm', authorId: pm.userId, body: 'Text n1', createdAt: timestamp }], nextCursor: null });
    f.control.calls = [];
    await expect(f.service.notes(target, client, { limit: 'invalid' })).rejects.toMatchObject({ status: 403 });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it('paginates the authorized audience with one validated lookahead row', async () => {
    const f = fixture(); f.control.messages = [message('m3'), message('n1', 'internal'), message('m1'), message('m2')];
    const first = await f.service.conversation(target, client, { limit: 2 });
    expect(first.items.map(row => row.id)).toEqual(['m1', 'm2']); expect(first.nextCursor).toBe('m2');
    const second = await f.service.conversation(target, client, { limit: 2, after: first.nextCursor });
    expect(second.items.map(row => row.id)).toEqual(['m3']); expect(second.nextCursor).toBeNull();
  });

  it.each(['private', 'foreign', 'absent'])('does not resolve a %s conversation cursor globally', async cursor => {
    const f = fixture();
    f.control.messages = [message('m1'), message('private', 'internal'), { ...message('foreign'), workspaceId: 'workspace-b' }];
    await expect(f.service.conversation(target, client, { after: cursor })).rejects.toMatchObject({ status: 404 });
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '10' }, { after: '' }, { after: ' space ' }, { workspaceId: 'workspace-b' }, null])('rejects malformed pagination', async input => {
    const f = fixture();
    await expect(f.service.conversation(target, client, input)).rejects.toMatchObject({ status: 400, code: 'invalid_ticket_page' });
    expect(f.control.calls).toEqual(['authorize']);
  });

  it.each(['missing', 'revoked', 'wrong-user', 'wrong-ticket', 'developer', 'pm-permission'])('refuses %s access before validation or reads', async denied => {
    const f = fixture(); let subject: TicketSubject = client;
    if (denied === 'missing') f.control.access = false;
    if (denied === 'revoked') f.control.active = false;
    if (denied === 'wrong-user') f.control.wrongActor = true;
    if (denied === 'wrong-ticket') f.control.wrongTicket = true;
    if (denied === 'developer') { subject = pm; f.control.developer = true; }
    if (denied === 'pm-permission') { subject = pm; f.control.permission = false; }
    await expect(f.service.conversation(target, subject, { invalid: true })).rejects.toMatchObject({ status: denied === 'developer' || denied === 'pm-permission' ? 403 : 404 });
    expect(f.control.calls).toEqual(['authorize']);
    f.control.calls = [];
    await expect(f.service.detail(target, subject)).rejects.toBeInstanceOf(TicketWorkflowError);
    expect(f.control.calls).toEqual(['authorize']);
  });

  it.each(['foreign', 'private', 'wrong-client', 'duplicate', 'unordered', 'invalid-time', 'excess', 'hidden-lookahead'])('refuses %s rows from a faulty adapter', async fault => {
    const f = fixture(); let input: unknown = {};
    let rows = [message('m1')];
    if (fault === 'foreign') rows[0].ticketId = 'ticket-b';
    if (fault === 'private') rows[0].audience = 'internal';
    if (fault === 'wrong-client') { rows[0].authorKind = 'client'; rows[0].authorId = 'client-b'; }
    if (fault === 'duplicate') rows.push(message('m1'));
    if (fault === 'unordered') rows = [message('m2'), message('m1')];
    if (fault === 'invalid-time') rows[0].createdAt = 'not-a-time';
    if (fault === 'excess') { rows = [message('m1'), message('m2'), message('m3')]; input = { limit: 1 }; }
    if (fault === 'hidden-lookahead') { rows.push(message('n1', 'internal')); input = { limit: 1 }; }
    f.control.rawMessages = rows;
    await expect(f.service.conversation(target, client, input)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it('does not allow a client-authored private note', async () => {
    const f = fixture(); f.control.rawMessages = [{ ...message('n1', 'internal'), authorKind: 'client', authorId: client.userId }];
    await expect(f.service.notes(target, pm)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it('does not expose arbitrary extra fields on messages or mutate stored text', async () => {
    const f = fixture();
    const row = message('m1'); row.body = '<script>not executed</script>';
    Object.assign(row, { token: 'hidden-token', internalNote: 'hidden-note' }); f.control.messages = [row];
    const page = await f.service.conversation(target, client);
    expect(page.items[0]).toEqual({ id: 'm1', author: 'pm', body: '<script>not executed</script>', createdAt: timestamp });
    page.items[0].body = 'Changed';
    expect((await f.service.conversation(target, client)).items[0].body).toBe('<script>not executed</script>');
  });

  it('direct note projection cannot bypass the client boundary', () => {
    const f = fixture();
    expect(() => projectTicketMessage(f.locked(), message('n1', 'internal'), 'internal')).toThrow(TicketReadInvariantError);
  });

  it('returns a real empty page only after a successful authorized read', async () => {
    const f = fixture();
    expect(await f.service.conversation(target, client)).toEqual({ items: [], nextCursor: null });
    f.control.access = false;
    await expect(f.service.conversation(target, client)).rejects.toMatchObject({ status: 404 });
  });
});
