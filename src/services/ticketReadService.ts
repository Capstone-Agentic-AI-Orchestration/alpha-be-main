import { z } from 'zod';

import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketReadStore } from '../store/ticketReadStore.js';
import {
  projectClientTicketDetail, projectPmTicketDetail, projectTicketMessage, TicketReadInvariantError,
  type ClientTicketDetail, type PmTicketDetail, type PublicTicketMessage, type InternalTicketNote,
} from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { authorizeTicketAccess } from './ticketAccess.js';

const pageSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  after: z.string().min(1).max(200).refine(value => value.trim() === value).nullable().default(null),
}).strict();
export interface TicketMessagePage<T> { items: T[]; nextCursor: string | null }

export function createTicketReadService(store: TicketReadStore) {
  async function messages(target: TicketTarget, subject: TicketSubject, audience: 'client' | 'internal', input: unknown) {
    return store.transaction(async tx => {
      const ticket = await authorizeTicketAccess(tx, target, subject);
      if (audience === 'internal' && ticket.actor.kind !== 'pm') {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot read internal ticket notes.');
      }
      const parsed = pageSchema.safeParse(input);
      if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_page', 'This ticket page is invalid.');
      const rows = await tx.loadMessages(ticket, audience, parsed.data);
      if (rows.length > parsed.data.limit + 1) throw new TicketReadInvariantError();
      // Validate the lookahead too: never turn a hidden/foreign row into a cursor.
      const projected = rows.map(row => projectTicketMessage(ticket, row, audience));
      const ids = new Set<string>();
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const previous = rows[i - 1];
        if (ids.has(row.id) || row.id === parsed.data.after || !Number.isFinite(Date.parse(row.createdAt))
          || (previous && (Date.parse(previous.createdAt) > Date.parse(row.createdAt)
            || (Date.parse(previous.createdAt) === Date.parse(row.createdAt) && previous.id >= row.id)))) {
          throw new TicketReadInvariantError();
        }
        ids.add(row.id);
      }
      if (ticket.actor.kind === 'pm' && audience === 'client') {
        const lastVisibleClientMessage = rows.slice(0, parsed.data.limit).filter(row => row.authorKind === 'client').at(-1);
        if (lastVisibleClientMessage) await tx.markClientMessagesRead?.(ticket, lastVisibleClientMessage.id);
      }
      const items = projected.slice(0, parsed.data.limit);
      return { items, nextCursor: projected.length > parsed.data.limit ? items[items.length - 1].id : null };
    });
  }
  return {
    async detail(target: TicketTarget, subject: TicketSubject): Promise<ClientTicketDetail | PmTicketDetail> {
      return store.transaction(async tx => {
        const ticket = await authorizeTicketAccess(tx, target, subject);
        const rows = await tx.loadDetail(ticket);
        return ticket.actor.kind === 'client' ? projectClientTicketDetail(ticket, rows) : projectPmTicketDetail(ticket, rows);
      });
    },
    conversation(target: TicketTarget, subject: TicketSubject, input: unknown = {}): Promise<TicketMessagePage<PublicTicketMessage>> {
      return messages(target, subject, 'client', input);
    },
    async notes(target: TicketTarget, subject: TicketSubject, input: unknown = {}): Promise<TicketMessagePage<InternalTicketNote>> {
      // Every projected item is an internal note after the audience/PM checks.
      return await messages(target, subject, 'internal', input) as TicketMessagePage<InternalTicketNote>;
    },
  };
}
