import { Router, type Request } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketClientConversationRow, TicketQueueClientGroup, TicketQueueClientSummary, TicketQueueCounters } from '../store/ticketQueueStore.js';
import { TICKET_CLIENT_CONVERSATION_LIMIT, TICKET_CONVERSATION_PREVIEW_LENGTH } from '../store/ticketQueueStore.js';
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
  listClientGroups(workspaceId: string, subject: TicketSubject): Promise<TicketQueueClientGroup[]>;
  listClients(workspaceId: string, subject: TicketSubject): Promise<TicketQueueClientSummary[]>;
  listClientConversations(workspaceId: string, subject: TicketSubject, clientGroupKey: string):
    Promise<{ items: TicketClientConversationRow[]; complete: boolean }>;
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
const allowedQueryKeys = new Set(['limit', 'after', 'search', 'filter', 'clientGroupKey']);
const terminalStatuses = new Set(['closed', 'declined', 'cancelled']);
const validTimestamp = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 40 && Number.isFinite(Date.parse(value));

function invalidPage(): never {
  throw new TicketWorkflowError(400, 'invalid_ticket_page', 'This ticket page is invalid.');
}

function safeClientGroup(value: TicketQueueClientGroup): TicketQueueClientGroup {
  if (!value || !opaqueTicketRequestValue(value.key)
    || typeof value.displayName !== 'string' || !value.displayName.trim()
    || value.displayName.trim() !== value.displayName || value.displayName.length > 200) {
    throw new TicketReadInvariantError();
  }
  return { key: value.key, displayName: value.displayName };
}

/** Only the documented fields leave the server, whatever the application returns. */
function safeClientSummary(value: TicketQueueClientSummary): TicketQueueClientSummary {
  if (!value || !opaqueTicketRequestValue(value.key) || !value.key.startsWith('client:')
    || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 200
    || (value.company !== null && (typeof value.company !== 'string' || !value.company.trim() || value.company.length > 200))
    || (value.access !== 'active' && value.access !== 'inactive')
    || !validTimestamp(value.lastActivityAt) || !value.tickets || !Array.isArray(value.projects)) {
    throw new TicketReadInvariantError();
  }
  const count = (n: unknown) => {
    if (!Number.isSafeInteger(n) || (n as number) < 0) throw new TicketReadInvariantError();
    return n as number;
  };
  return {
    key: value.key,
    displayName: value.displayName,
    company: value.company,
    access: value.access,
    tickets: {
      needsPm: count(value.tickets.needsPm),
      waitingClient: count(value.tickets.waitingClient),
      open: count(value.tickets.open),
      closed: count(value.tickets.closed),
      unlinkedOpen: count(value.tickets.unlinkedOpen),
      accessRevoked: count(value.tickets.accessRevoked),
    },
    projects: value.projects.map(project => {
      if (!project || !opaqueTicketRequestValue(project.projectId)
        || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200
        || typeof project.previewPublished !== 'boolean') throw new TicketReadInvariantError();
      return { projectId: project.projectId, name: project.name, previewPublished: project.previewPublished };
    }),
    lastActivityAt: value.lastActivityAt,
  };
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
      || clientGroup.displayName.trim() !== clientGroup.displayName || clientGroup.displayName.length > 200))
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

  router.get('/client-groups', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (await relayRequest(req, res)) return;

    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const workspace = req.workspace;
    if (!workspace) throw new TicketReadInvariantError();

    const groups = await application.listClientGroups(workspace.workspaceId, subject);
    if (!Array.isArray(groups)) throw new TicketReadInvariantError();
    const keys = new Set<string>();
    const items = groups.map(group => {
      const safe = safeClientGroup(group);
      if (keys.has(safe.key)) throw new TicketReadInvariantError();
      keys.add(safe.key);
      return safe;
    });
    return res.json({ items });
  }));

  // Registered here, in the queue router, because the read router mounted after
  // it has GET /:ticketId, which would otherwise take "clients" for a ticket id.
  router.get('/clients', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (await relayRequest(req, res)) return;

    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const workspace = req.workspace;
    if (!workspace) throw new TicketReadInvariantError();
    if (Object.keys(req.query as Record<string, unknown>).length > 0) invalidPage();

    const clients = await application.listClients(workspace.workspaceId, subject);
    if (!Array.isArray(clients)) throw new TicketReadInvariantError();
    const keys = new Set<string>();
    const items = clients.map(client => {
      const safe = safeClientSummary(client);
      if (keys.has(safe.key)) throw new TicketReadInvariantError();
      keys.add(safe.key);
      return safe;
    });
    return res.json({ items });
  }));

  /** A client's page: each of their requests with its newest client-visible message. */
  router.get('/clients/:clientGroupKey/conversations', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (await relayRequest(req, res)) return;

    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const workspace = req.workspace;
    if (!workspace) throw new TicketReadInvariantError();
    const clientGroupKey = req.params.clientGroupKey;
    if (Object.keys(req.query as Record<string, unknown>).length > 0 || !opaqueTicketRequestValue(clientGroupKey)) {
      throw new TicketWorkflowError(400, 'invalid_ticket_client', 'This client is invalid.');
    }

    const result = await application.listClientConversations(workspace.workspaceId, subject, clientGroupKey);
    if (!result || !Array.isArray(result.items) || result.items.length > TICKET_CLIENT_CONVERSATION_LIMIT
      || typeof result.complete !== 'boolean') throw new TicketReadInvariantError();
    const ids = new Set<string>();
    // Explicit allowlist: never serialize a store row.
    const items = result.items.map(row => {
      const latest = row?.latest;
      if (!row || !opaqueTicketRequestValue(row.ticketId) || ids.has(row.ticketId)
        || (latest !== null && (!latest || !opaqueTicketRequestValue(latest.id)
          || (latest.authorKind !== 'pm' && latest.authorKind !== 'client')
          || typeof latest.preview !== 'string' || latest.preview.length > TICKET_CONVERSATION_PREVIEW_LENGTH
          || typeof latest.truncated !== 'boolean' || !validTimestamp(latest.createdAt)))) {
        throw new TicketReadInvariantError();
      }
      ids.add(row.ticketId);
      return {
        ticketId: row.ticketId,
        latestMessage: latest ? {
          id: latest.id, author: latest.authorKind, preview: latest.preview, truncated: latest.truncated, createdAt: latest.createdAt,
        } : null,
      };
    });
    return res.json({ items, complete: result.complete });
  }));

  return router;
}
