import { z } from 'zod';

import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketQueueStore, TicketQueuePageRequest } from '../store/ticketQueueStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { matchesTicketQueueFilter, projectTicketQueueCounters, projectTicketQueueRow, queueSortTime, ticketQueueMonth } from '../ticketing/queueModels.js';
import { authorizeTicketQueueAccess } from './ticketAccess.js';

const pageSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(200).refine(value => value.trim() === value).nullable().default(null),
  search: z.string().trim().max(200).default(''),
  filter: z.enum(['all', 'history', 'open', 'needs_client', 'needs_pm', 'in_progress', 'waiting_client', 'closed_month']).default('all'),
}).strict();
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
        if (!parsed.success || !filters[scope.principal.kind].has(parsed.data.filter)) {
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
            || !`${row.header.reference} ${row.header.title}`.toLowerCase().includes(page.search.toLowerCase())
            || (previous && (queueSortTime(scope, previous) < queueSortTime(scope, row)
              || (queueSortTime(scope, previous) === queueSortTime(scope, row) && previous.ticket.state.id <= row.ticket.state.id)))) {
            throw new TicketReadInvariantError();
          }
          ids.add(row.ticket.state.id);
        }
        const counters = projectTicketQueueCounters(scope, await tx.countQueue(scope, month));
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
  };
}
