import { z } from 'zod';

import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketQueueStore, TicketQueuePageRequest, TicketQueueClientSummary } from '../store/ticketQueueStore.js';
import { TICKET_CLIENT_CONVERSATION_LIMIT, TICKET_CONVERSATION_PREVIEW_LENGTH } from '../store/ticketQueueStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { matchesTicketQueueFilter, projectTicketQueueCounters, projectTicketQueueRow, queueSortTime, ticketQueueMonth } from '../ticketing/queueModels.js';
import { authorizeTicketQueueAccess } from './ticketAccess.js';

const pageSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(200).refine(value => value.trim() === value).nullable().default(null),
  search: z.string().trim().max(200).default(''),
  filter: z.enum(['all', 'history', 'open', 'needs_client', 'needs_pm', 'in_progress', 'waiting_client', 'closed_month']).default('all'),
  clientGroupKey: z.string().trim().min(1).max(200).optional(),
}).strict();
const clientGroupKeySchema = z.string().min(1).max(200).refine(value => value.trim() === value);
const filters = {
  client: new Set(['all', 'history', 'open', 'needs_client']),
  pm: new Set(['all', 'history', 'needs_pm', 'in_progress', 'waiting_client', 'closed_month']),
};

export function createTicketQueueService(store: TicketQueueStore, now: () => Date = () => new Date()) {
  return {
    async list(workspaceId: string, subject: TicketSubject, input: unknown = {}) {
      return store.transaction(async tx => {
        const scope = await authorizeTicketQueueAccess(tx, workspaceId, subject);
        const parsed = pageSchema.safeParse(input);
        if (!parsed.success || !filters[scope.principal.kind].has(parsed.data.filter)
          || (parsed.data.clientGroupKey !== undefined && scope.principal.kind !== 'pm')) {
          throw new TicketWorkflowError(400, 'invalid_ticket_page', 'This ticket page is invalid.');
        }
        const page: TicketQueuePageRequest = parsed.data;
        const month = ticketQueueMonth(now(), scope.timeZone);
        const rows = await tx.loadQueue(scope, page, month);
        if (rows.length > page.limit + 1) throw new TicketReadInvariantError();
        // Validate lookahead too. The store MUST already apply scoped filtering;
        // this is fail-closed defense, never postfiltering an unrestricted query.
        const projected = rows.map(row => projectTicketQueueRow(scope, row));
        const ids = new Set<string>();
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]; const previous = rows[i - 1];
          if (ids.has(row.ticket.state.id) || row.ticket.state.id === page.after
            || !matchesTicketQueueFilter(row, page.filter, month)
            || (page.clientGroupKey !== undefined && row.pmClientGroup?.key !== page.clientGroupKey)
            || !`${row.header.reference} ${row.header.title} ${scope.principal.kind === 'pm' ? row.pmClientGroup?.displayName ?? '' : ''}`
              .toLowerCase().includes(page.search.toLowerCase())
            || (previous && (queueSortTime(scope, previous) < queueSortTime(scope, row)
              || (queueSortTime(scope, previous) === queueSortTime(scope, row) && previous.ticket.state.id <= row.ticket.state.id)))) {
            throw new TicketReadInvariantError();
          }
          ids.add(row.ticket.state.id);
        }
        // Counters follow a PM's client filter: on a client's page they are that client's.
        const counters = projectTicketQueueCounters(scope, await tx.countQueue(scope, month, page.clientGroupKey));
        const minimum = (filter: TicketQueuePageRequest['filter']) => rows.filter(row => matchesTicketQueueFilter(row, filter, month)).length;
        // Aggregates cover the complete authorized queue, so they cannot be
        // smaller than the matching records already proven in this snapshot.
        if (counters.kind === 'client'
          ? counters.open < minimum('open') || counters.needsClient < minimum('needs_client')
          : counters.needsPm < minimum('needs_pm') || counters.inProgress < minimum('in_progress')
            || counters.waitingClient < minimum('waiting_client') || counters.closedMonth < minimum('closed_month')) {
          throw new TicketReadInvariantError();
        }
        const items = projected.slice(0, page.limit);
        return { items, nextCursor: projected.length > page.limit ? items[items.length - 1].id : null, counters };
      });
    },
    /** PM-only: each request in one client group with its newest client-visible message. */
    async listClientConversations(workspaceId: string, subject: TicketSubject, clientGroupKey: unknown) {
      return store.transaction(async tx => {
        const scope = await authorizeTicketQueueAccess(tx, workspaceId, subject);
        if (scope.principal.kind !== 'pm') {
          throw new TicketWorkflowError(403, 'ticket_client_groups_forbidden', 'Client pages are only available to project managers.');
        }
        const key = clientGroupKeySchema.safeParse(clientGroupKey);
        if (!key.success) throw new TicketWorkflowError(400, 'invalid_ticket_client', 'This client is invalid.');
        const rows = await tx.listClientConversations(scope, key.data);
        if (!Array.isArray(rows) || rows.length > TICKET_CLIENT_CONVERSATION_LIMIT + 1) throw new TicketReadInvariantError();
        const ids = new Set<string>();
        let previous = '';
        for (const row of rows) {
          const latest = row?.latest;
          if (!row || typeof row.ticketId !== 'string' || !row.ticketId || ids.has(row.ticketId)
            || (previous && Buffer.compare(Buffer.from(previous), Buffer.from(row.ticketId)) >= 0)
            || (latest !== null && (!latest || typeof latest.id !== 'string' || !latest.id
              || (latest.authorKind !== 'pm' && latest.authorKind !== 'client')
              || typeof latest.preview !== 'string' || latest.preview.length > TICKET_CONVERSATION_PREVIEW_LENGTH
              || typeof latest.truncated !== 'boolean' || !Number.isFinite(Date.parse(latest.createdAt))))) {
            throw new TicketReadInvariantError();
          }
          ids.add(row.ticketId); previous = row.ticketId;
        }
        return { items: rows.slice(0, TICKET_CLIENT_CONVERSATION_LIMIT), complete: rows.length <= TICKET_CLIENT_CONVERSATION_LIMIT };
      });
    },
    async listClientGroups(workspaceId: string, subject: TicketSubject) {
      return store.transaction(async tx => {
        const scope = await authorizeTicketQueueAccess(tx, workspaceId, subject);
        if (scope.principal.kind !== 'pm') {
          throw new TicketWorkflowError(403, 'ticket_client_groups_forbidden', 'Client filtering is only available to project managers.');
        }
        const groups = await tx.listClientGroups(scope);
        const keys = new Set<string>();
        for (const group of groups) {
          if (!group || typeof group.key !== 'string' || !group.key.trim() || group.key.trim() !== group.key
            || group.key.length > 200 || typeof group.displayName !== 'string' || !group.displayName.trim()
            || group.displayName.trim() !== group.displayName || group.displayName.length > 200
            || keys.has(group.key)) throw new TicketReadInvariantError();
          keys.add(group.key);
        }
        return groups;
      });
    },
    async listClients(workspaceId: string, subject: TicketSubject): Promise<TicketQueueClientSummary[]> {
      return store.transaction(async tx => {
        const scope = await authorizeTicketQueueAccess(tx, workspaceId, subject);
        if (scope.principal.kind !== 'pm') {
          throw new TicketWorkflowError(403, 'ticket_clients_forbidden', 'The client list is only available to project managers.');
        }
        const clients = await tx.listClients(scope);
        const keys = new Set<string>();
        for (const client of clients) {
          if (!validClientSummary(client) || keys.has(client.key)) throw new TicketReadInvariantError();
          keys.add(client.key);
        }
        return clients;
      });
    },
  };
}

const count = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

/** Fail closed on anything the store should never return. */
function validClientSummary(client: TicketQueueClientSummary): boolean {
  if (!client || typeof client.key !== 'string' || !/^client:\S+$/.test(client.key) || client.key.length > 200
    || typeof client.displayName !== 'string' || !client.displayName.trim() || client.displayName.length > 200
    || (client.company !== null && (typeof client.company !== 'string' || !client.company.trim() || client.company.length > 200))
    || (client.access !== 'active' && client.access !== 'inactive')
    || typeof client.lastActivityAt !== 'string' || !Number.isFinite(Date.parse(client.lastActivityAt))
    || !Array.isArray(client.projects) || client.projects.length > 200) return false;
  const t = client.tickets;
  if (!t || ![t.needsPm, t.waitingClient, t.open, t.closed, t.unlinkedOpen, t.accessRevoked].every(count)
    || t.needsPm > t.open || t.waitingClient > t.open || t.unlinkedOpen > t.open) return false;
  const projects = new Set<string>();
  for (const project of client.projects) {
    if (!project || typeof project.projectId !== 'string' || !project.projectId || projects.has(project.projectId)
      || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200
      || typeof project.previewPublished !== 'boolean') return false;
    projects.add(project.projectId);
  }
  return true;
}
