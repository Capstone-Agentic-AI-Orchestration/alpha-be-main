import { Router, type Request, type Response } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { ClientTicketDetail, InternalTicketNote, PmTicketDetail, PublicTicketMessage } from '../ticketing/readModels.js';
import type { TicketMessagePage } from '../services/ticketReadService.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

export interface PmTicketReadApplication {
  detail(target: TicketTarget, subject: TicketSubject): Promise<ClientTicketDetail | PmTicketDetail>;
  conversation(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketMessagePage<PublicTicketMessage>>;
  notes(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketMessagePage<InternalTicketNote>>;
}

const statuses = new Set([
  'received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review',
  'on_hold', 'closed', 'declined', 'cancelled',
]);
const actions = new Set([
  'review_ticket', 'reply', 'agree_scope', 'authorize_work', 'execute_work',
  'assess_result', 'share_result', 'review_result', 'close_ticket', 'triage_correction',
  'handle_withdrawal', 'resolve_hold',
]);
const terminal = new Set(['closed', 'declined', 'cancelled']);
const pageKeys = new Set(['limit', 'after']);

function invalidPage(): never {
  throw new TicketWorkflowError(400, 'invalid_ticket_page', 'This ticket page is invalid.');
}
function date(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function requiredText(value: unknown, max = 50000): value is string {
  return typeof value === 'string' && value.length <= max;
}
function pageInput(req: Request): unknown {
  const query = req.query as Record<string, unknown>;
  if (Object.keys(query).some(key => !pageKeys.has(key))) invalidPage();
  const input: Record<string, unknown> = {};
  for (const key of pageKeys) {
    const value = query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') invalidPage();
    if (key === 'limit') {
      if (!/^\d{1,3}$/.test(value)) invalidPage();
      input.limit = Number(value);
    } else input.after = value;
  }
  return input;
}

/** Return an exact PM DTO; never serialize arbitrary adapter/service objects. */
function safeDetail(value: PmTicketDetail): PmTicketDetail {
  if (!value || !opaqueTicketRequestValue(value.id) || !opaqueTicketRequestValue(value.reference)
    || !requiredText(value.title, 500) || !requiredText(value.description)
    || !requiredText(value.companyLabel, 200) || !statuses.has(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 0
    || !date(value.createdAt) || !date(value.updatedAt)
    || (value.closedAt !== null && !date(value.closedAt))
    || typeof value.readOnly !== 'boolean' || typeof value.writesAvailable !== 'boolean'
    || (value.requestedAction !== null && !['reply', 'agree_scope', 'review_result'].includes(value.requestedAction))
    || (value.sharedProjectName !== null && !requiredText(value.sharedProjectName, 200))
    || !value.internal || !date(value.internal.updatedAt)
    || (value.internal.projectId !== null && !opaqueTicketRequestValue(value.internal.projectId))
    || !Array.isArray(value.internal.requiredIssueIds)
    || value.internal.requiredIssueIds.some(id => !opaqueTicketRequestValue(id))
    || (value.internal.scopeVersion !== null && (!opaqueTicketRequestValue(value.internal.scopeVersion.id)
      || !requiredText(value.internal.scopeVersion.summary, 4000)
      || (value.internal.scopeVersion.developerBrief !== null && !requiredText(value.internal.scopeVersion.developerBrief, 12000))
      || !date(value.internal.scopeVersion.proposedAt)))
    || (value.internal.actionOwner !== null && !['pm', 'client', 'developer'].includes(value.internal.actionOwner))
    || (value.internal.nextAction !== null && !actions.has(value.internal.nextAction))) {
    throw new TicketReadInvariantError();
  }

  const relatedTicket = value.relatedTicket === null ? null : {
    id: value.relatedTicket.id, reference: value.relatedTicket.reference, title: value.relatedTicket.title,
  };
  const scope = value.scope === null ? null : {
    id: value.scope.id, summary: value.scope.summary, proposedAt: value.scope.proposedAt, agreed: value.scope.agreed,
  };
  const delivery = value.delivery === null ? null : {
    id: value.delivery.id, scopeVersionId: value.delivery.scopeVersionId, summary: value.delivery.summary,
    sharedAt: value.delivery.sharedAt, accepted: value.delivery.accepted,
  };
  const request = value.request === null ? null : {
    projectPreference: value.request.projectPreference, projectLabel: value.request.projectLabel,
    requestedDeadline: value.request.requestedDeadline,
  };
  const internalRequest = value.internal.request === null ? null : {
    source: value.internal.request.source,
    preferredProjectId: value.internal.request.preferredProjectId,
    projectLabel: value.internal.request.projectLabel,
    requestedDeadline: value.internal.request.requestedDeadline,
    contact: value.internal.request.contact === null ? null : {
      fullName: value.internal.request.contact.fullName,
      email: value.internal.request.contact.email,
      company: value.internal.request.contact.company,
      verification: value.internal.request.contact.verification,
    },
  };
  const scopeVersion = value.internal.scopeVersion === null ? null : {
    id: value.internal.scopeVersion.id, summary: value.internal.scopeVersion.summary,
    developerBrief: value.internal.scopeVersion.developerBrief,
    proposedAt: value.internal.scopeVersion.proposedAt, immutable: value.internal.scopeVersion.immutable,
    clientVisible: value.internal.scopeVersion.clientVisible,
  };
  const deliveryAssessment = value.internal.deliveryAssessment === null ? null : {
    id: value.internal.deliveryAssessment.id, scopeVersionId: value.internal.deliveryAssessment.scopeVersionId,
    summary: value.internal.deliveryAssessment.summary, pinnedAssetId: value.internal.deliveryAssessment.pinnedAssetId,
    issueRevisionIds: [...value.internal.deliveryAssessment.issueRevisionIds],
    immutable: value.internal.deliveryAssessment.immutable, clientVisible: value.internal.deliveryAssessment.clientVisible,
    shared: value.internal.deliveryAssessment.shared,
  };

  return {
    id: value.id, reference: value.reference, title: value.title, description: value.description,
    companyLabel: value.companyLabel, status: value.status, version: value.version,
    createdAt: value.createdAt, updatedAt: value.updatedAt, closedAt: value.closedAt,
    readOnly: value.readOnly, writesAvailable: value.writesAvailable, requestedAction: value.requestedAction,
    sharedProjectName: value.sharedProjectName, relatedTicket, scope, delivery, request,
    internal: {
      updatedAt: value.internal.updatedAt, projectId: value.internal.projectId,
      requiredIssueIds: [...value.internal.requiredIssueIds], actionOwner: value.internal.actionOwner,
      nextAction: value.internal.nextAction, authorizedScopeVersionId: value.internal.authorizedScopeVersionId,
      correctionRequestedFor: value.internal.correctionRequestedFor,
      withdrawalRequested: value.internal.withdrawalRequested, closureReason: value.internal.closureReason,
      request: internalRequest, scopeVersion, deliveryAssessment,
    },
  };
}

function safeMessages<T extends PublicTicketMessage | InternalTicketNote>(
  page: TicketMessagePage<T>, includeAuthorId: boolean,
): TicketMessagePage<T> {
  if (!page || !Array.isArray(page.items) || page.items.length > 100
    || (page.nextCursor !== null && !opaqueTicketRequestValue(page.nextCursor))) {
    throw new TicketReadInvariantError();
  }
  const items = page.items.map(message => {
    if (!message || !opaqueTicketRequestValue(message.id)
      || !['pm', 'client'].includes(message.author) || !requiredText(message.body)
      || !date(message.createdAt)) throw new TicketReadInvariantError();
    if (includeAuthorId) {
      const note = message as InternalTicketNote;
      if (!opaqueTicketRequestValue(note.authorId) || note.author !== 'pm') throw new TicketReadInvariantError();
      return { id: note.id, author: note.author, body: note.body, createdAt: note.createdAt, authorId: note.authorId } as T;
    }
    return { id: message.id, author: message.author, body: message.body, createdAt: message.createdAt } as T;
  });
  if (page.nextCursor !== null && items.at(-1)?.id !== page.nextCursor) throw new TicketReadInvariantError();
  return { items, nextCursor: page.nextCursor };
}

/** PM-only ticket read transport. Mounted only through the opt-in read-only
 * cloud composition; client session routes use a separate auth boundary. */
export function createTicketReadRouter(application: PmTicketReadApplication): Router {
  const router = Router();
  const secureHeaders = (res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };

  function targetFromRequest(req: Request): TicketTarget | null {
    const workspace = req.workspace;
    const ticketId = req.params.ticketId ?? '';
    if (!workspace || !opaqueTicketRequestValue(ticketId)) return null;
    return { workspaceId: workspace.workspaceId, ticketId };
  }

  router.get('/:ticketId', route(async (req, res) => {
    secureHeaders(res);
    if (await relayPmTicketRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const target = targetFromRequest(req);
    if (!target) return res.status(404).json({ error: 'Ticket not found.' });
    const detail = await application.detail(target, subject);
    if (!detail || !('internal' in detail)) throw new TicketReadInvariantError();
    return res.json(safeDetail(detail));
  }));

  router.get('/:ticketId/messages', route(async (req, res) => {
    secureHeaders(res);
    if (await relayPmTicketRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const target = targetFromRequest(req);
    if (!target) return res.status(404).json({ error: 'Ticket not found.' });
    return res.json(safeMessages(await application.conversation(target, subject, pageInput(req)), false));
  }));

  router.get('/:ticketId/notes', route(async (req, res) => {
    secureHeaders(res);
    if (await relayPmTicketRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const target = targetFromRequest(req);
    if (!target) return res.status(404).json({ error: 'Ticket not found.' });
    return res.json(safeMessages(await application.notes(target, subject, pageInput(req)), true));
  }));

  return router;
}
