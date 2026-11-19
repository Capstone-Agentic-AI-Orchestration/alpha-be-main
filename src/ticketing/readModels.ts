import type { LockedTicket } from '../store/ticketCommandStore.js';
import type {
  TicketDetailRows, TicketMessageReadRow, TicketReadScope,
} from '../store/ticketReadStore.js';
import { assertTicketActor, TicketWorkflowError, type TicketStatus, type NextAction } from './workflow.js';
import { isTicketRequestedDeadline, isTicketInquiryContact } from './intake.js';

/** Safe generic failure on inconsistent trusted rows; never include row values. */
export class TicketReadInvariantError extends Error {
  constructor() { super('The ticket view could not be verified.'); this.name = 'TicketReadInvariantError'; }
}
function requireInvariant(value: unknown): asserts value {
  if (!value) throw new TicketReadInvariantError();
}
export function assertTicketReadScope(ticket: LockedTicket, row: TicketReadScope): void {
  requireInvariant(row.workspaceId === ticket.state.workspaceId && row.ticketId === ticket.state.id);
}
const terminal = (status: TicketStatus) => ['closed', 'declined', 'cancelled'].includes(status);
type ClientAction = 'reply' | 'agree_scope' | 'review_result' | null;
export interface ClientTicketDetail {
  id: string;
  reference: string;
  title: string;
  description: string;
  companyLabel: string;
  status: TicketStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readOnly: boolean;
  writesAvailable: boolean;
  requestedAction: ClientAction;
  sharedProjectName: string | null;
  sharedProjectPreviewUrl?: string;
  relatedTicket: { id: string; reference: string; title: string } | null;
  /** approvedBy says who approved the plan: the client, or the PM using their discretion. */
  scope: { id: string; summary: string; proposedAt: string; agreed: boolean; approvedBy: 'client' | 'pm' | null } | null;
  delivery: { id: string; scopeVersionId: string; summary: string; sharedAt: string; accepted: boolean } | null;
  request: { projectPreference: 'not_sure' | 'new_project' | 'shared_project'; projectLabel: string | null; requestedDeadline: string | null } | null;
}
export interface PublicTicketMessage { id: string; author: 'pm' | 'client'; body: string; createdAt: string }
export interface InternalTicketNote extends PublicTicketMessage { authorId: string }
export interface PmTicketDetail extends ClientTicketDetail {
  internal: {
    updatedAt: string;
    projectId: string | null;
    projectName: string | null;
    projectClientVisible: boolean;
    projectPreview?: { repository: string; branch: 'main' | 'uat'; url: string };
    requiredIssueIds: string[];
    actionOwner: LockedTicket['state']['actionOwner'];
    nextAction: NextAction;
    authorizedScopeVersionId: string | null;
    correctionRequestedFor: string | null;
    withdrawalRequested: boolean;
    closureReason: LockedTicket['state']['closureReason'];
    request: { source: 'authenticated_client' | 'public_inquiry'; preferredProjectId: string | null; projectLabel: string | null; requestedDeadline: string | null; contact: { fullName: string; email: string; company: string | null; verification: 'verified' | 'unverified_submission' } | null } | null;
    scopeVersion: { id: string; summary: string; developerBrief: string | null; proposedAt: string; immutable: boolean; clientVisible: boolean } | null;
    deliveryAssessment: {
      id: string; scopeVersionId: string; summary: string; pinnedAssetId: string; issueRevisionIds: string[];
      immutable: boolean; clientVisible: boolean; shared: boolean;
    } | null;
  };
}

/** Who approved a plan, as shown to readers: older tickets were always approved by the client. */
export function scopeApprovedBy(agreed: boolean, approvedBy: 'client' | 'pm' | null | undefined): 'client' | 'pm' | null {
  if (!agreed) return null;
  return approvedBy ?? 'client';
}

/** Read-model validation: absent on older payloads, otherwise one of the known approvers. */
export function validScopeApprovedBy(value: unknown): boolean {
  return value === undefined || value === null || value === 'client' || value === 'pm';
}

/** Explicit field mapping, not serialize-then-delete. Document history and
 * authorized file/preview endpoints are separate future services, not fake URLs.
 */
export function projectClientTicketDetail(ticket: LockedTicket, rows: TicketDetailRows): ClientTicketDetail {
  assertTicketActor(ticket.state, ticket.actor);
  if (ticket.actor.kind === 'client') requireInvariant(rows.currentPmScope == null);
  const state = ticket.state;
  const header = rows.header;
  assertTicketReadScope(ticket, header);
  requireInvariant(!header.closedAt || terminal(state.status));
  if (rows.currentScope) {
    assertTicketReadScope(ticket, rows.currentScope);
    requireInvariant(rows.currentScope.id === state.scopeVersionId);
  }
  const scope = rows.currentScope?.clientVisible && rows.currentScope.immutable ? rows.currentScope : null;
  if (state.nextAction === 'agree_scope' && state.actionOwner === 'client') requireInvariant(scope);
  const row = rows.currentDelivery;
  if (row) {
    assertTicketReadScope(ticket, row);
    requireInvariant(row.id === state.delivery?.id);
  }
  const current = state.delivery;
  let delivery: ClientTicketDetail['delivery'] = null;
  if (current?.shared) {
    requireInvariant(row?.clientVisible && row.immutable && row.sharedAt && row.pinnedAssetId
      && row.pinnedAssetId === current.pinnedAssetId && row.scopeVersionId === current.scopeVersionId
      && current.scopeVersionId === state.scopeVersionId
      && row.issueRevisionIds.length === current.issueRevisionIds.length
      && new Set(row.issueRevisionIds).size === row.issueRevisionIds.length
      && row.issueRevisionIds.every(id => current.issueRevisionIds.includes(id)));
    delivery = {
      id: row.id, scopeVersionId: row.scopeVersionId, summary: row.publicSummary, sharedAt: row.sharedAt,
      accepted: current.acceptedByClientId !== null && current.acceptedByClientId === state.clientId,
    };
  }
  let related: ClientTicketDetail['relatedTicket'] = null;
  if (rows.related) {
    requireInvariant(rows.related.workspaceId === state.workspaceId && rows.related.ticketId === header.relatedTicketId);
    if (rows.related.clientId === state.clientId && rows.related.clientGrantActive) {
      related = { id: rows.related.ticketId, reference: rows.related.reference, title: rows.related.title };
    }
  }
  if (header.sharedProject) requireInvariant(header.sharedProject.projectId === state.projectId);
  const readOnly = terminal(state.status);
  const writesAvailable = !readOnly && ticket.mode === 'enabled';
  const requestedAction = writesAvailable && !state.withdrawalRequested && state.actionOwner === 'client'
    && ['reply', 'agree_scope', 'review_result'].includes(state.nextAction ?? '') ? state.nextAction as ClientAction : null;
  const request = rows.request;
  if (request) {
    assertTicketReadScope(ticket, request);
    requireInvariant(['authenticated_client', 'public_inquiry'].includes(request.source)
      && ['not_sure', 'new_project', 'shared_project'].includes(request.projectPreference.kind)
      && (request.requestedDeadline === null || isTicketRequestedDeadline(request.requestedDeadline)));
    if (request.projectPreference.kind === 'shared_project') {
      requireInvariant(request.preferredProjectId && request.requestedProjectLabel && request.requestedProjectLabel.length <= 200);
    } else requireInvariant(request.preferredProjectId === null && request.requestedProjectLabel === null);
    requireInvariant(request.source !== 'authenticated_client' || request.contact === null);
    requireInvariant(ticket.actor.kind !== 'client' || request.contact === null);
    if (ticket.actor.kind === 'pm' && request.source === 'public_inquiry') {
      requireInvariant(request.contact && isTicketInquiryContact(request.contact)
        && typeof request.contact.emailVerified === 'boolean');
    }
  }
  return {
    id: state.id, reference: header.reference, title: header.title, description: header.description,
    companyLabel: header.clientSafeCompanyLabel, status: state.status, version: state.version,
    createdAt: header.createdAt, updatedAt: header.clientUpdatedAt, closedAt: header.closedAt,
    readOnly, writesAvailable, requestedAction,
    sharedProjectName: header.sharedProject?.clientVisible ? header.sharedProject.displayName : null,
    ...(header.sharedProject?.clientVisible && header.sharedProject.preview
      ? { sharedProjectPreviewUrl: header.sharedProject.preview.url } : {}),
    relatedTicket: related,
    scope: scope ? {
      id: scope.id, summary: scope.publicSummary, proposedAt: scope.proposedAt, agreed: state.agreedScopeVersionId === scope.id,
      approvedBy: scopeApprovedBy(state.agreedScopeVersionId === scope.id, state.scopeApprovedBy),
    } : null,
    delivery,
    request: request ? { projectPreference: request.projectPreference.kind, projectLabel: request.requestedProjectLabel, requestedDeadline: request.requestedDeadline } : null,
  };
}

export function projectPmTicketDetail(ticket: LockedTicket, rows: TicketDetailRows): PmTicketDetail {
  assertTicketActor(ticket.state, ticket.actor);
  if (ticket.actor.kind !== 'pm') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot read internal ticket details.');
  const state = ticket.state;
  const pmScope = rows.currentPmScope ?? null;
  if (pmScope) {
    assertTicketReadScope(ticket, pmScope);
    requireInvariant(state.scopeVersionId === pmScope.id && rows.currentScope?.id === pmScope.id
      && typeof pmScope.developerBrief === 'string'
      && pmScope.developerBrief.trim().length > 0
      && pmScope.developerBrief.length <= 12000);
  }
  return {
    ...projectClientTicketDetail(ticket, rows),
    internal: {
      updatedAt: rows.header.internalUpdatedAt, projectId: state.projectId,
      projectName: rows.header.sharedProject?.displayName ?? null,
      projectClientVisible: rows.header.sharedProject?.clientVisible ?? false,
      ...(rows.header.sharedProject?.preview ? { projectPreview: rows.header.sharedProject.preview } : {}),
      requiredIssueIds: [...state.requiredIssueIds],
      actionOwner: state.actionOwner, nextAction: state.nextAction, authorizedScopeVersionId: state.authorizedScopeVersionId,
      correctionRequestedFor: state.correctionRequestedFor, withdrawalRequested: state.withdrawalRequested,
      closureReason: state.closureReason,
      request: rows.request ? {
        source: rows.request.source, preferredProjectId: rows.request.preferredProjectId,
        projectLabel: rows.request.requestedProjectLabel, requestedDeadline: rows.request.requestedDeadline,
        contact: rows.request.source === 'public_inquiry' && rows.request.contact ? {
          fullName: rows.request.contact.fullName, email: rows.request.contact.email, company: rows.request.contact.company,
          verification: rows.request.contact.emailVerified ? 'verified' : 'unverified_submission',
        } : null,
      } : null,
      scopeVersion: rows.currentScope ? {
        id: rows.currentScope.id, summary: rows.currentScope.publicSummary, proposedAt: rows.currentScope.proposedAt,
        developerBrief: pmScope?.id === rows.currentScope.id ? pmScope.developerBrief : null,
        immutable: rows.currentScope.immutable, clientVisible: rows.currentScope.clientVisible,
      } : null,
      deliveryAssessment: rows.currentDelivery ? {
        id: rows.currentDelivery.id, scopeVersionId: rows.currentDelivery.scopeVersionId,
        summary: rows.currentDelivery.publicSummary, pinnedAssetId: rows.currentDelivery.pinnedAssetId,
        issueRevisionIds: [...rows.currentDelivery.issueRevisionIds], immutable: rows.currentDelivery.immutable,
        clientVisible: rows.currentDelivery.clientVisible, shared: state.delivery?.shared === true,
      } : null,
    },
  };
}

export function projectTicketMessage(ticket: LockedTicket, row: TicketMessageReadRow, audience: 'client' | 'internal'): PublicTicketMessage | InternalTicketNote {
  assertTicketActor(ticket.state, ticket.actor);
  assertTicketReadScope(ticket, row);
  requireInvariant(row.audience === audience && (row.authorKind === 'client' || row.authorKind === 'pm'));
  if (row.authorKind === 'client') requireInvariant(row.authorId === ticket.state.clientId);
  if (audience === 'internal') requireInvariant(row.authorKind === 'pm' && ticket.actor.kind === 'pm');
  const message = { id: row.id, author: row.authorKind, body: row.body, createdAt: row.createdAt };
  return audience === 'internal' ? { ...message, authorId: row.authorId } : message;
}
