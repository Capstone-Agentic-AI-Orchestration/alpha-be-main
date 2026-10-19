import { Router, type Request } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketQueueCounters } from '../store/ticketQueueStore.js';
import type { ClientTicketQueueItem, PmTicketQueueItem } from '../ticketing/queueModels.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

type QueueItem = ClientTicketQueueItem | PmTicketQueueItem;
interface TicketQueuePage {
  items: QueueItem[];
  nextCursor: string | null;
  counters: TicketQueueCounters;
}

export interface PmTicketQueueApplication {
  list(workspaceId: string, subject: TicketSubject, input: unknown): Promise<TicketQueuePage>;
}

const statusValues = new Set([
  'received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review',
  'on_hold', 'closed', 'declined', 'cancelled',
]);
const actionValues = new Set([
  'review_ticket', 'reply', 'agree_scope', 'authorize_work', 'execute_work',
  'assess_result', 'share_result', 'review_result', 'close_ticket', 'triage_correction',
  'handle_withdrawal', 'resolve_hold',
]);
const requestedActionValues = new Set(['reply', 'agree_scope', 'review_result']);
const invitationStateValues = new Set(['pending', 'expired', 'revoked', 'consumed']);
const invitationDeliveryValues = new Set(['queued', 'sending', 'retrying', 'accepted_by_provider', 'failed', 'unknown']);
const allowedQueryKeys = new Set(['limit', 'after', 'search', 'filter']);
const terminalStatuses = new Set(['closed', 'declined', 'cancelled']);
const validTimestamp = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 40 && Number.isFinite(Date.parse(value));

function invalidPage(): never {
  throw new TicketWorkflowError(400, 'invalid_ticket_page', 'This ticket page is invalid.');
}

/** Express query values are strings (or arrays/objects for malformed input). */
function pageInput(req: Request): unknown {
  const query = req.query as Record<string, unknown>;
  if (Object.keys(query).some(key => !allowedQueryKeys.has(key))) invalidPage();

  const input: Record<string, unknown> = {};
  for (const key of allowedQueryKeys) {
    const value = query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') invalidPage();
    if (key === 'limit') {
      if (!/^\d{1,3}$/.test(value)) invalidPage();
      const limit = Number(value);
      if (!Number.isSafeInteger(limit)) invalidPage();
      input.limit = limit;
    } else input[key] = value;
  }
  return input;
}

function safePmItem(value: QueueItem): PmTicketQueueItem {
  if (!value || !opaqueTicketRequestValue(value.id) || !opaqueTicketRequestValue(value.reference)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.trim() !== value.title || value.title.length > 500
    || !statusValues.has(value.status) || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || (value.closedAt !== null && !validTimestamp(value.closedAt))
    || typeof value.readOnly !== 'boolean' || typeof value.writesAvailable !== 'boolean'
    || (value.requestedAction !== null && !requestedActionValues.has(value.requestedAction))
    || !('internal' in value)) {
    throw new TicketReadInvariantError();
  }
  if (value.readOnly !== terminalStatuses.has(value.status)
    || (value.writesAvailable && value.readOnly)
    || (!value.writesAvailable && value.requestedAction !== null)) throw new TicketReadInvariantError();
  const internal = value.internal;
  const invitation = internal?.clientInvitation;
  const clientGroup = internal?.clientGroup;
  if (!internal || !validTimestamp(internal.updatedAt)
    || (internal.actionOwner !== null && !['pm', 'client', 'developer'].includes(internal.actionOwner))
    || (internal.nextAction !== null && !actionValues.has(internal.nextAction))
    || (internal.projectId !== null && !opaqueTicketRequestValue(internal.projectId))
    || (invitation !== undefined && invitation !== null && (!invitationStateValues.has(invitation.status)
      || !invitationDeliveryValues.has(invitation.delivery) || !validTimestamp(invitation.expiresAt)))
    || typeof internal.clientAccessActive !== 'boolean'
    || typeof internal.clientReplyUnread !== 'boolean'
    || (clientGroup !== undefined && (!clientGroup || !opaqueTicketRequestValue(clientGroup.key)
      || typeof clientGroup.displayName !== 'string' || !clientGroup.displayName.trim()
      || clientGroup.displayName.trim() !== clientGroup.displayName || clientGroup.displayName.length > 200
      || typeof clientGroup.acceptsNewRequests !== 'boolean' || typeof clientGroup.accessActive !== 'boolean'))
    || (internal.projectName !== undefined && internal.projectName !== null
      && (typeof internal.projectName !== 'string' || !internal.projectName.trim()
        || internal.projectName.trim() !== internal.projectName || internal.projectName.length > 200))
    || (internal.projectName !== undefined && ((internal.projectId === null) !== (internal.projectName === null)))) {
    throw new TicketReadInvariantError();
  }
  // Explicit allowlist: never serialize a store/query row from the service.
  return {
    id: value.id,
    reference: value.reference,
    title: value.title,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt,
    readOnly: value.readOnly,
    writesAvailable: value.writesAvailable,
    requestedAction: value.requestedAction,
    internal: {
      updatedAt: internal.updatedAt,
      actionOwner: internal.actionOwner,
      nextAction: internal.nextAction,
      projectId: internal.projectId,
      clientAccessActive: internal.clientAccessActive,
      clientReplyUnread: internal.clientReplyUnread,
      clientInvitation: invitation ?? null,
      ...(clientGroup ? { clientGroup: {
        key: clientGroup.key, displayName: clientGroup.displayName,
        acceptsNewRequests: clientGroup.acceptsNewRequests, accessActive: clientGroup.accessActive,
      } } : {}),
      ...(internal.projectName !== undefined ? { projectName: internal.projectName } : {}),
    },
  };
}

function safeCounters(value: TicketQueueCounters): Extract<TicketQueueCounters, { kind: 'pm' }> {
  if (!value || value.kind !== 'pm'
    || !Number.isSafeInteger(value.needsPm) || value.needsPm < 0
    || !Number.isSafeInteger(value.inProgress) || value.inProgress < 0
    || !Number.isSafeInteger(value.waitingClient) || value.waitingClient < 0
    || !Number.isSafeInteger(value.closedMonth) || value.closedMonth < 0) {
    throw new TicketReadInvariantError();
  }
  return {
    kind: 'pm', needsPm: value.needsPm, inProgress: value.inProgress,
    waitingClient: value.waitingClient, closedMonth: value.closedMonth,
  };
}

/**
 * PM-only ticket queue transport. Mount after the existing session/workspace
 * middleware and only when a durable ticket store has been configured. The
 * workspace is derived from authenticated request state, never from query data.
 */
export function createTicketQueueRouter(
  application: PmTicketQueueApplication,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
): Router {
  const router = Router();

  router.get('/', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (await relayRequest(req, res)) return;

    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const workspace = req.workspace;
    if (!workspace) throw new TicketReadInvariantError();

    const page = await application.list(workspace.workspaceId, subject, pageInput(req));
    if (!page || !Array.isArray(page.items) || page.items.length > 100
      || (page.nextCursor !== null && !opaqueTicketRequestValue(page.nextCursor))) {
      throw new TicketReadInvariantError();
    }
    const items = page.items.map(safePmItem);
    if (page.nextCursor !== null && items.at(-1)?.id !== page.nextCursor) {
      throw new TicketReadInvariantError();
    }
    return res.json({ items, nextCursor: page.nextCursor, counters: safeCounters(page.counters) });
  }));

  return router;
}
