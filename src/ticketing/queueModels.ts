import type {
  LockedTicketQueue, TicketQueueCounters,
  TicketQueueFilter, TicketQueueMonth, TicketQueueRow,
} from '../store/ticketQueueStore.js';
import { TicketReadInvariantError } from './readModels.js';
import { assertTicketActor, type TicketStatus, type ActionOwner, type NextAction } from './workflow.js';

export interface ClientTicketQueueItem {
  id: string; reference: string; title: string; status: TicketStatus;
  createdAt: string; updatedAt: string; closedAt: string | null;
  readOnly: boolean; writesAvailable: boolean;
  requestedAction: 'reply' | 'agree_scope' | 'review_result' | null;
}
export interface PmTicketQueueItem extends ClientTicketQueueItem {
  internal: {
    updatedAt: string;
    actionOwner: ActionOwner;
    nextAction: NextAction;
    projectId: string | null;
    clientAccessActive: boolean;
  };
}

function invariant(value: unknown): asserts value { if (!value) throw new TicketReadInvariantError(); }
const statuses = new Set(['received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review', 'on_hold', 'closed', 'declined', 'cancelled']);
export function queueTerminal(row: TicketQueueRow): boolean { return ['closed', 'declined', 'cancelled'].includes(row.ticket.state.status); }
function clientAction(row: TicketQueueRow): ClientTicketQueueItem['requestedAction'] {
  const state = row.ticket.state;
  return !queueTerminal(row) && state.status !== 'on_hold' && !state.withdrawalRequested
    && state.clientId !== null && row.clientAccessActive && state.actionOwner === 'client'
    && (state.nextAction === 'reply' || state.nextAction === 'agree_scope' || state.nextAction === 'review_result') ? state.nextAction : null;
}
/** Calendar keys, not a fixed 30-day window. Trusted workspace timezone only. */
export function ticketQueueMonth(now: Date, timeZone: string): TicketQueueMonth {
  try {
    invariant(timeZone && timeZone.trim() === timeZone && Number.isFinite(now.getTime()));
    const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(now);
    const year = Number(parts.find(part => part.type === 'year')?.value);
    const month = Number(parts.find(part => part.type === 'month')?.value);
    invariant(Number.isInteger(year) && month >= 1 && month <= 12);
    return { year, month, timeZone };
  } catch { throw new TicketReadInvariantError(); }
}
export function matchesTicketQueueFilter(row: TicketQueueRow, filter: TicketQueueFilter, month: TicketQueueMonth): boolean {
  const state = row.ticket.state;
  switch (filter) {
    case 'all': return true;
    case 'history': return queueTerminal(row);
    case 'open': return !queueTerminal(row);
    case 'needs_client': case 'waiting_client': return clientAction(row) !== null;
    case 'needs_pm': return !queueTerminal(row) && state.actionOwner === 'pm' && state.nextAction !== null;
    case 'in_progress': return state.status === 'in_progress';
    case 'closed_month': {
      if (!row.header.closedAt || !['closed', 'cancelled'].includes(state.status)
        || !['accepted', 'answered', 'cancelled'].includes(state.closureReason ?? '')) return false;
      const closed = ticketQueueMonth(new Date(row.header.closedAt), month.timeZone);
      return closed.year === month.year && closed.month === month.month;
    }
  }
}
export function queueSortTime(scope: LockedTicketQueue, row: TicketQueueRow): number {
  return Date.parse(scope.principal.kind === 'pm' ? row.header.internalUpdatedAt : row.header.clientUpdatedAt);
}
export function projectTicketQueueRow(scope: LockedTicketQueue, row: TicketQueueRow): ClientTicketQueueItem | PmTicketQueueItem {
  const { state, actor } = row.ticket;
  const header = row.header;
  invariant(state.workspaceId === scope.workspaceId && header.workspaceId === scope.workspaceId && header.ticketId === state.id
    && actor.kind === scope.principal.kind && actor.userId === scope.principal.userId);
  assertTicketActor(state, actor);
  invariant(typeof row.clientAccessActive === 'boolean' && (actor.kind !== 'client' || row.clientAccessActive));
  invariant(state.id && state.id.trim() === state.id && state.id.length <= 200 && statuses.has(state.status)
    && header.reference && header.title && Number.isFinite(Date.parse(header.createdAt))
    && Number.isFinite(Date.parse(header.clientUpdatedAt)) && Number.isFinite(Date.parse(header.internalUpdatedAt))
    && Date.parse(header.clientUpdatedAt) >= Date.parse(header.createdAt)
    && Date.parse(header.internalUpdatedAt) >= Date.parse(header.clientUpdatedAt));
  invariant(header.closedAt === null || (queueTerminal(row) && Number.isFinite(Date.parse(header.closedAt))
    && Date.parse(header.closedAt) >= Date.parse(header.createdAt)));
  const readOnly = queueTerminal(row);
  const writesAvailable = !readOnly && scope.mode === 'enabled' && row.ticket.mode === 'enabled';
  const item: ClientTicketQueueItem = {
    id: state.id, reference: header.reference, title: header.title, status: state.status,
    createdAt: header.createdAt, updatedAt: header.clientUpdatedAt, closedAt: header.closedAt,
    readOnly, writesAvailable, requestedAction: writesAvailable ? clientAction(row) : null,
  };
  return scope.principal.kind === 'pm' ? {
    ...item, internal: {
      updatedAt: header.internalUpdatedAt, actionOwner: state.actionOwner, nextAction: state.nextAction,
      projectId: state.projectId, clientAccessActive: row.clientAccessActive,
    },
  } : item;
}
/** Map exact fields; never serialize an aggregate row from a driver directly. */
export function projectTicketQueueCounters(scope: LockedTicketQueue, counts: TicketQueueCounters): TicketQueueCounters {
  invariant(counts.kind === scope.principal.kind);
  const number = (value: number) => { invariant(Number.isSafeInteger(value) && value >= 0); return value; };
  if (counts.kind === 'client') {
    const open = number(counts.open); const needsClient = number(counts.needsClient);
    invariant(needsClient <= open); return { kind: 'client', open, needsClient };
  }
  return { kind: 'pm', needsPm: number(counts.needsPm), inProgress: number(counts.inProgress), waitingClient: number(counts.waitingClient), closedMonth: number(counts.closedMonth) };
}
