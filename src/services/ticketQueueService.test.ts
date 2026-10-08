import { describe, expect, it } from 'vitest';

import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { LockedTicketQueue, TicketQueueCounters, TicketQueueRow, TicketQueueStore } from '../store/ticketQueueStore.js';
import { matchesTicketQueueFilter, queueSortTime, ticketQueueMonth } from '../ticketing/queueModels.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { newTicketWorkflow, TicketWorkflowError } from '../ticketing/workflow.js';
import { createTicketQueueService } from './ticketQueueService.js';

const workspace = 'workspace-a';
const pm: Extract<TicketSubject, { kind: 'internal' }> = { kind: 'internal', userId: 'pm-a', authentication: { kind: 'session', sessionId: 'pm-session' } };
const client: Extract<TicketSubject, { kind: 'client' }> = { kind: 'client', userId: 'client-a', sessionId: 'client-session' };
const createdAt = '2026-09-01T00:00:00.000Z';
const updatedAt = '2026-10-01T01:00:00.000Z';
const clock = '2026-10-08T03:00:00.000Z';
function row(id: string, status: TicketQueueRow['ticket']['state']['status'] = 'received'): TicketQueueRow {
  const state = newTicketWorkflow(id, workspace, client.userId); state.status = status;
  if (status === 'in_progress') { state.actionOwner = 'developer'; state.nextAction = 'execute_work'; }
  if (status === 'awaiting_client') { state.actionOwner = 'client'; state.nextAction = 'reply'; }
  if (['closed', 'cancelled', 'declined'].includes(status)) {
    state.actionOwner = null; state.nextAction = null;
    state.closureReason = status === 'cancelled' ? 'cancelled' : status === 'closed' ? 'answered' : null;
  }
  return {
    clientAccessActive: true,
    ticket: { state, actor: { kind: 'client', userId: client.userId, workspaceId: workspace, ticketId: id, grantActive: true }, mode: 'enabled' },
    header: { workspaceId: workspace, ticketId: id, reference: `REF-${id}`, title: `Request ${id}`, createdAt, clientUpdatedAt: updatedAt, internalUpdatedAt: updatedAt, closedAt: ['closed', 'cancelled', 'declined'].includes(status) ? updatedAt : null },
  };
}
function credential(subject: TicketSubject) {
  return subject.kind === 'client' ? subject.sessionId : subject.authentication.kind === 'session' ? subject.authentication.sessionId : subject.authentication.verificationId;
}
/** Local-only query fixture. Models scoped predicates, NOT real SQL/RLS locks. */
function fixture() {
  const control = {
    active: true, permission: true, available: true, badIdentity: false, badWorkspace: false, badKind: false,
    timeZone: 'Asia/Manila', now: clock, mode: 'enabled' as LockedTicketQueue['mode'],
    rows: [] as TicketQueueRow[], rawRows: null as TicketQueueRow[] | null,
    counts: null as TicketQueueCounters | null, grants: new Set<string>(),
    sessions: new Map([pm, client].map(subject => [credential(subject), subject])),
    role: 'pm' as 'pm' | 'developer' | 'admin', failAt: '', calls: [] as string[], queries: [] as unknown[],
  };
  const store: TicketQueueStore = {
    async transaction<T>(work: Parameters<TicketQueueStore['transaction']>[0]): Promise<T> {
      // The service runs all reads through one transaction; real snapshot and
      // concurrent revocation proof remains a production adapter requirement.
      let authorized: LockedTicketQueue | null = null;
      function step(name: string) { control.calls.push(name); if (control.failAt === name) throw new Error(`Injected ${name} outage`); }
      function visible(scope: LockedTicketQueue) {
        return control.rows.filter(item => item.ticket.state.workspaceId === scope.workspaceId
          && (scope.principal.kind === 'pm' || (item.ticket.state.clientId === scope.principal.userId
            && item.clientAccessActive && control.grants.has(item.ticket.state.id))))
          .map(item => ({ ...structuredClone(item), ticket: {
            ...structuredClone(item.ticket),
            actor: scope.principal.kind === 'client'
              ? { kind: 'client' as const, userId: scope.principal.userId, workspaceId: scope.workspaceId, ticketId: item.ticket.state.id, grantActive: true }
              : { kind: 'pm' as const, userId: scope.principal.userId, workspaceId: scope.workspaceId, membershipActive: control.active, canManageTickets: control.permission },
          } }));
      }
      const result = await work({
        async lockAuthorizedQueue(requestWorkspace, subject) {
          step('authorize'); const saved = control.sessions.get(credential(subject));
          if (!control.available || requestWorkspace !== workspace || !saved || saved.userId !== subject.userId || saved.kind !== subject.kind) return null;
          authorized = {
            workspaceId: control.badWorkspace ? 'other-workspace' : workspace, timeZone: control.timeZone, mode: control.mode,
            principal: subject.kind === 'client' && !control.badKind
              ? { kind: 'client', userId: control.badIdentity ? 'other-user' : subject.userId, accessActive: control.active }
              : { kind: 'pm', userId: control.badIdentity ? 'other-user' : subject.userId, membershipActive: control.active, canManageTickets: control.permission },
          };
          if (subject.kind === 'internal' && control.role !== 'pm') Object.assign(authorized.principal, { kind: control.role });
          return authorized;
        },
        async loadQueue(scope, page, month) {
          step('page'); expect(scope).toBe(authorized); control.queries.push({ page, month });
          if (control.rawRows) return structuredClone(control.rawRows);
          const items = visible(scope).filter(item => matchesTicketQueueFilter(item, page.filter, month)
            && `${item.header.reference} ${item.header.title}`.toLowerCase().includes(page.search.toLowerCase()))
            .sort((a, b) => queueSortTime(scope, b) - queueSortTime(scope, a) || (a.ticket.state.id > b.ticket.state.id ? -1 : 1));
          const cursor = page.after === null ? -1 : items.findIndex(item => item.ticket.state.id === page.after);
          if (page.after !== null && cursor === -1) throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
          return items.slice(cursor + 1, cursor + 1 + page.limit + 1);
        },
        async countQueue(scope, month) {
          step('counts'); expect(scope).toBe(authorized);
          if (control.counts) return structuredClone(control.counts);
          const items = visible(scope);
          const count = (filter: Parameters<typeof matchesTicketQueueFilter>[1]) => items.filter(item => matchesTicketQueueFilter(item, filter, month)).length;
          return scope.principal.kind === 'client' ? { kind: 'client', open: count('open'), needsClient: count('needs_client') }
            : { kind: 'pm', needsPm: count('needs_pm'), inProgress: count('in_progress'), waitingClient: count('waiting_client'), closedMonth: count('closed_month') };
        },
      });
      return result as T;
    },
  };
  const service = createTicketQueueService(store, () => new Date(control.now));
  function add(...items: TicketQueueRow[]) { control.rows.push(...items); for (const item of items) control.grants.add(item.ticket.state.id); }
  return { service, control, add };
}

describe('authorized queue and minimal counters', () => {
  it('returns a real empty result only after both scoped queries succeed', async () => {
    const f = fixture(); expect(await f.service.list(workspace, client)).toEqual({ items: [], nextCursor: null, counters: { kind: 'client', open: 0, needsClient: 0 } });
    expect(f.control.calls).toEqual(['authorize', 'page', 'counts']);
  });
  it('maps exactly two client counters across all authorized records, not page length', async () => {
    const f = fixture(); f.add(row('a'), row('b', 'awaiting_client'), row('c', 'closed'), row('d', 'declined'), row('e', 'cancelled'));
    const result = await f.service.list(workspace, client, { limit: 1 });
    expect(result.items).toHaveLength(1); expect(result.counters).toEqual({ kind: 'client', open: 2, needsClient: 1 }); expect(result.nextCursor).toBe('e');
  });
  it('maps exactly four PM counters and excludes decline from closed-month', async () => {
    const f = fixture(); f.add(row('a'), row('b', 'awaiting_client'), row('c', 'in_progress'), row('d', 'closed'), row('e', 'cancelled'), row('f', 'declined'));
    const result = await f.service.list(workspace, pm);
    expect(result.counters).toEqual({ kind: 'pm', needsPm: 1, waitingClient: 1, inProgress: 1, closedMonth: 2 });
  });
  it('keeps counts independent of search and clickable filter', async () => {
    const f = fixture(); f.add(row('a'), row('b', 'awaiting_client'));
    const result = await f.service.list(workspace, client, { search: 'request b', filter: 'needs_client' });
    expect(result.items.map(item => item.id)).toEqual(['b']); expect(result.counters).toEqual({ kind: 'client', open: 2, needsClient: 1 });
  });
  it('filters clients by explicit ticket grants, not project membership or email', async () => {
    const f = fixture(); const foreignClient = row('other-client'); foreignClient.ticket.state.clientId = 'client-b';
    const foreignWorkspace = row('other-workspace'); foreignWorkspace.ticket.state.workspaceId = 'workspace-b';
    f.add(row('mine'), row('revoked'), foreignClient, foreignWorkspace); f.control.grants.delete('revoked');
    const result = await f.service.list(workspace, client);
    expect(result.items.map(item => item.id)).toEqual(['mine']); expect(result.counters).toEqual({ kind: 'client', open: 1, needsClient: 0 });
  });
  it('permits PM intake rows without granting the client workspace membership', async () => {
    const f = fixture(); const inquiry = row('inquiry'); inquiry.ticket.state.clientId = null; f.add(inquiry);
    expect((await f.service.list(workspace, pm)).items).toHaveLength(1);
    expect((await f.service.list(workspace, client)).items).toHaveLength(0);
  });
  it('never exposes private/internal fields or extra aggregate fields to clients', async () => {
    const f = fixture(); const item = row('a'); item.ticket.state.projectId = 'private-project';
    item.header.internalUpdatedAt = '2026-10-07T00:00:00.000Z'; Object.assign(item.header, { privateNote: 'secret', description: 'secret-description' }); f.add(item);
    f.control.counts = { kind: 'client', open: 1, needsClient: 0 }; Object.assign(f.control.counts, { privateNotes: 23 });
    const result = await f.service.list(workspace, client);
    expect(Object.keys(result.items[0]).sort()).toEqual(['closedAt', 'createdAt', 'id', 'readOnly', 'reference', 'requestedAction', 'status', 'title', 'updatedAt', 'writesAvailable']);
    expect(result.items[0].updatedAt).toBe(updatedAt); expect(JSON.stringify(result)).not.toMatch(/private|secret|2026-10-07/);
  });
  it('PM output adds only mapped internal handoff fields', async () => {
    const f = fixture(); f.add(row('a')); const result = await f.service.list(workspace, pm);
    expect(result.items[0]).toMatchObject({ internal: { updatedAt, actionOwner: 'pm', nextAction: 'review_ticket', projectId: null } });
  });
  it('private note clocks reorder PM view but leave client order, content and counters unchanged', async () => {
    const f = fixture(); f.add(row('a'), row('b')); const before = await f.service.list(workspace, client);
    f.control.rows[0].header.internalUpdatedAt = '2026-10-07T00:00:00.000Z';
    expect(await f.service.list(workspace, client)).toEqual(before);
    expect((await f.service.list(workspace, pm)).items.map(item => item.id)).toEqual(['a', 'b']);
  });
  it.each(['disabled', 'maintenance', undefined] as const)('retains history/counters but disables actions under mode %s', async mode => {
    const f = fixture(); f.add(row('a', 'awaiting_client'), row('b', 'closed')); f.control.mode = mode;
    const result = await f.service.list(workspace, client);
    expect(result.counters).toEqual({ kind: 'client', open: 1, needsClient: 1 });
    expect(result.items.every(item => !item.writesAvailable && item.requestedAction === null)).toBe(true);
  });
  it('an accepted but not closed result remains open without asking for another review', async () => {
    const f = fixture(); const item = row('a', 'ready_for_review'); item.ticket.state.actionOwner = 'pm'; item.ticket.state.nextAction = 'close_ticket'; f.add(item);
    expect((await f.service.list(workspace, client)).counters).toEqual({ kind: 'client', open: 1, needsClient: 0 });
  });
  it('hold/withdrawal/failure are not miscounted as client review', async () => {
    const f = fixture(); const hold = row('hold', 'on_hold'); hold.ticket.state.nextAction = 'resolve_hold';
    const withdrawing = row('withdraw', 'awaiting_client'); withdrawing.ticket.state.withdrawalRequested = true;
    const failure = row('failure', 'under_review'); failure.ticket.state.nextAction = 'assess_result';
    f.add(hold, withdrawing, failure); expect((await f.service.list(workspace, pm)).counters).toMatchObject({ waitingClient: 0, needsPm: 2 });
  });
  it('an inactive client is not falsely counted as someone who can respond', async () => {
    const f = fixture(); const item = row('inactive', 'awaiting_client'); item.clientAccessActive = false; f.add(item);
    expect((await f.service.list(workspace, pm)).counters).toMatchObject({ waitingClient: 0 });
  });
});

describe('pagination and current access', () => {
  it('uses bounded lookahead with descending binary IDs for equal timestamps', async () => {
    const f = fixture(); f.add(row('a'), row('b'), row('c'));
    const first = await f.service.list(workspace, client, { limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(['c', 'b']); expect(first.nextCursor).toBe('b');
    const next = await f.service.list(workspace, client, { limit: 2, after: first.nextCursor });
    expect(next.items.map(item => item.id)).toEqual(['a']); expect(next.nextCursor).toBeNull(); expect(next.counters).toEqual(first.counters);
  });
  it.each(['foreign', 'revoked', 'wrong-filter', 'wrong-search'])('refuses %s cursors without a global lookup', async condition => {
    const f = fixture(); f.add(row('a'), row('b', 'closed'));
    const page: Record<string, unknown> = { after: 'a' };
    if (condition === 'foreign') page.after = 'other';
    if (condition === 'revoked') f.control.grants.delete('a');
    if (condition === 'wrong-filter') page.filter = 'history';
    if (condition === 'wrong-search') page.search = 'Request b';
    await expect(f.service.list(workspace, client, page)).rejects.toMatchObject({ status: 404 });
    expect(f.control.calls).not.toContain('counts');
  });
  it.each(['unavailable', 'revoked', 'identity', 'workspace', 'kind', 'session', 'session-binding'])('authorizes %s before parsing or counts', async condition => {
    const f = fixture(); let subject: TicketSubject = client;
    if (condition === 'unavailable') f.control.available = false;
    if (condition === 'revoked') f.control.active = false;
    if (condition === 'identity') f.control.badIdentity = true;
    if (condition === 'workspace') f.control.badWorkspace = true;
    if (condition === 'kind') f.control.badKind = true;
    if (condition === 'session') f.control.sessions.clear();
    if (condition === 'session-binding') subject = { ...client, sessionId: 'pm-session' };
    await expect(f.service.list(workspace, subject, { malicious: true })).rejects.toMatchObject({ status: 404 }); expect(f.control.calls).toEqual(['authorize']);
  });
  it.each(['membership', 'permission'])('rechecks PM %s before parsing', async condition => {
    const f = fixture(); if (condition === 'membership') f.control.active = false; else f.control.permission = false;
    await expect(f.service.list(workspace, pm, { bad: true })).rejects.toMatchObject({ status: 403 }); expect(f.control.calls).toEqual(['authorize']);
  });
  it('retains existing verified desktop bearer PM identity', async () => {
    const f = fixture(); const bearer: TicketSubject = { ...pm, authentication: { kind: 'verified_github_bearer', verificationId: 'server-request' } };
    f.control.sessions.clear(); f.control.sessions.set(credential(bearer), bearer); f.add(row('a'));
    expect((await f.service.list(workspace, bearer)).counters).toMatchObject({ kind: 'pm', needsPm: 1 });
  });
  it.each(['developer', 'admin'] as const)('does not expose the PM ticket queue to the %s role', async role => {
    const f = fixture(); f.control.role = role;
    await expect(f.service.list(workspace, pm, { bad: true })).rejects.toMatchObject({ status: 403 });
    expect(f.control.calls).toEqual(['authorize']);
  });
  it('reflects revoked ticket grants on the next page and counters', async () => {
    const f = fixture(); f.add(row('a'), row('b')); expect((await f.service.list(workspace, client)).items).toHaveLength(2);
    f.control.grants.delete('b'); const result = await f.service.list(workspace, client);
    expect(result.items.map(item => item.id)).toEqual(['a']); expect(result.counters).toMatchObject({ open: 1 });
  });
});

describe('calendar definitions, filters and safe failures', () => {
  it.each([
    ['Asia/Manila', '2026-09-30T16:00:00.000Z', 2026, 10],
    ['America/Los_Angeles', '2026-10-01T06:59:59.000Z', 2026, 9],
    ['America/Los_Angeles', '2026-10-01T07:00:00.000Z', 2026, 10],
    ['Pacific/Kiritimati', '2026-12-31T10:00:00.000Z', 2027, 1],
    ['America/New_York', '2026-11-01T05:30:00.000Z', 2026, 11],
  ])('uses the configured calendar in %s at %s', (zone, timestamp, year, month) => {
    expect(ticketQueueMonth(new Date(timestamp), zone)).toEqual({ year, month, timeZone: zone });
  });
  it('monthly counts use closure date, not recent private updates, and do not count declines', async () => {
    const f = fixture(); const old = row('old', 'closed'); old.header.closedAt = '2026-09-30T15:59:59.000Z';
    const current = row('current', 'closed'); current.header.closedAt = '2026-09-30T16:00:00.000Z';
    const declined = row('decline', 'declined'); const cancellation = row('cancel', 'cancelled'); f.add(old, current, declined, cancellation);
    const result = await f.service.list(workspace, pm, { filter: 'closed_month' });
    expect(result.items.map(item => item.id)).toEqual(['current', 'cancel']); expect(result.counters).toMatchObject({ closedMonth: 2 });
  });
  it.each(['', 'Invalid/Zone', ' Asia/Manila '])('refuses invalid workspace timezone %s instead of guessing UTC', async zone => {
    const f = fixture(); f.control.timeZone = zone; await expect(f.service.list(workspace, client)).rejects.toBeInstanceOf(TicketReadInvariantError); expect(f.control.calls).toEqual(['authorize']);
  });
  it('refuses an invalid server clock', async () => {
    const f = fixture(); f.control.now = 'invalid'; await expect(f.service.list(workspace, client)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });
  it.each([
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '25' }, { after: '' }, { after: ' padded ' }, { after: 'x'.repeat(201) },
    { search: 'x'.repeat(201) }, { search: null }, { filter: 'unknown' }, { actor: 'pm' }, { workspaceId: 'foreign' }, { timeZone: 'UTC' }, { now: clock }, { grantActive: true }, { filter: 'needs_pm' },
  ])('refuses invalid or server-owned client input', async input => {
    const f = fixture(); await expect(f.service.list(workspace, client, input)).rejects.toMatchObject({ status: 400, code: 'invalid_ticket_page' }); expect(f.control.calls).toEqual(['authorize']);
  });
  it.each(['open', 'needs_client'])('PM cannot accidentally request the client-only filter %s', async filter => {
    const f = fixture(); await expect(f.service.list(workspace, pm, { filter })).rejects.toMatchObject({ status: 400 });
  });
  it.each(['page', 'counts'])('propagates %s outage, never fabricated zero/empty success', async stage => {
    const f = fixture(); f.control.failAt = stage; await expect(f.service.list(workspace, client)).rejects.toThrow(`Injected ${stage} outage`);
  });
  it.each(['tenant', 'actor', 'grant', 'duplicate', 'order', 'cursor', 'filter', 'search', 'timestamp', 'closure', 'too-many'])('rejects inconsistent page evidence (%s)', async failure => {
    const f = fixture(); const item = row('b'); const lookahead = row('a'); f.control.rawRows = [item, lookahead];
    const input: Record<string, unknown> = { limit: 1 };
    if (failure === 'tenant') lookahead.header.workspaceId = 'other';
    if (failure === 'actor') lookahead.ticket.actor.userId = 'other';
    if (failure === 'grant' && lookahead.ticket.actor.kind === 'client') lookahead.ticket.actor.grantActive = false;
    if (failure === 'duplicate') f.control.rawRows = [item, structuredClone(item)];
    if (failure === 'order') f.control.rawRows = [lookahead, item];
    if (failure === 'cursor') input.after = 'b';
    if (failure === 'filter') input.filter = 'history';
    if (failure === 'search') input.search = 'not-matching';
    if (failure === 'timestamp') lookahead.header.clientUpdatedAt = 'invalid';
    if (failure === 'closure') lookahead.header.closedAt = updatedAt;
    if (failure === 'too-many') f.control.rawRows.push(row('extra'));
    await expect(f.service.list(workspace, client, input)).rejects.toBeInstanceOf(Error); expect(f.control.calls).not.toContain('counts');
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1'])('rejects invalid aggregate number %s', async value => {
    const f = fixture(); f.control.counts = { kind: 'client', open: value as number, needsClient: 0 };
    await expect(f.service.list(workspace, client)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });
  it('rejects impossible client subset counts and wrong-audience aggregates', async () => {
    const f = fixture(); f.control.counts = { kind: 'client', open: 0, needsClient: 1 };
    await expect(f.service.list(workspace, client)).rejects.toBeInstanceOf(TicketReadInvariantError);
    f.control.counts = { kind: 'pm', needsPm: 0, inProgress: 0, waitingClient: 0, closedMonth: 0 };
    await expect(f.service.list(workspace, client)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });
  it.each(['open', 'needsClient'])('rejects aggregate %s below matching verified page rows', async field => {
    const f = fixture(); f.add(row('a', 'awaiting_client')); f.control.counts = { kind: 'client', open: 1, needsClient: 1 };
    f.control.counts[field as 'open' | 'needsClient'] = 0;
    await expect(f.service.list(workspace, client)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });
  it.each(['needsPm', 'inProgress', 'waitingClient', 'closedMonth'] as const)('validates PM aggregate %s against safe integers and page minimum', async field => {
    const f = fixture(); const status = field === 'inProgress' ? 'in_progress' : field === 'waitingClient' ? 'awaiting_client' : field === 'closedMonth' ? 'closed' : 'received';
    f.add(row('a', status)); f.control.counts = { kind: 'pm', needsPm: 0, inProgress: 0, waitingClient: 0, closedMonth: 0 };
    await expect(f.service.list(workspace, pm)).rejects.toBeInstanceOf(TicketReadInvariantError);
    f.control.counts[field] = Number.NaN;
    await expect(f.service.list(workspace, pm)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });
});
