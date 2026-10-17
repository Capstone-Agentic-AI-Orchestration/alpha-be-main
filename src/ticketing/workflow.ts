import { z } from 'zod';

import type { IssueStatus } from '../models/index.js';

/**
 * Pure ticket decisions, not a second runner or an authorization middleware.
 * Future services must load actor, snapshot and facts from authoritative stores
 * in the same transaction. Only the command envelope comes from the caller.
 * Nothing here connects to a database, sends email, creates Issues or releases.
 */
export type TicketStatus = 'received' | 'under_review' | 'awaiting_client' | 'in_progress'
  | 'ready_for_review' | 'on_hold' | 'closed' | 'declined' | 'cancelled';
export type ActionOwner = 'pm' | 'client' | 'developer' | null;
export type NextAction = 'review_ticket' | 'reply' | 'agree_scope' | 'authorize_work' | 'execute_work'
  | 'assess_result' | 'share_result' | 'review_result' | 'close_ticket' | 'triage_correction'
  | 'handle_withdrawal' | 'resolve_hold' | null;

export interface TicketDelivery {
  id: string;
  scopeVersionId: string;
  pinnedAssetId: string;
  issueRevisionIds: string[];
  assessedByPmId: string;
  shared: boolean;
  acceptedByClientId: string | null;
}

export interface TicketWorkflow {
  id: string;
  workspaceId: string;
  version: number;
  status: TicketStatus;
  clientId: string | null;
  scopeVersionId: string | null;
  agreedScopeVersionId: string | null;
  authorizedScopeVersionId: string | null;
  projectId: string | null;
  requiredIssueIds: string[];
  delivery: TicketDelivery | null;
  correctionRequestedFor: string | null;
  withdrawalRequested: boolean;
  actionOwner: ActionOwner;
  nextAction: NextAction;
  hold: { status: TicketStatus; actionOwner: ActionOwner; nextAction: NextAction } | null;
  closureReason: 'accepted' | 'answered' | 'cancelled' | null;
}

/** Resolved server identities. Never cast a request body or editable JWT metadata. */
export type TicketActor =
  | { kind: 'pm'; userId: string; workspaceId: string; membershipActive: boolean; canManageTickets: boolean }
  | { kind: 'client'; userId: string; workspaceId: string; ticketId: string; grantActive: boolean }
  | { kind: 'developer'; userId: string; workspaceId: string };

export interface TicketIssueEvidence {
  id: string;
  revisionId: string;
  ticketId: string;
  workspaceId: string;
  projectId: string;
  scopeVersionId: string;
  /** Freshly loaded Alpha Issue status; caller-supplied status is never trusted. */
  status: IssueStatus;
  /** True for any queued/reserved/running execution claim, derived from
   * authoritative run state, not merely the Issue's display status.
   */
  hasActiveRun: boolean;
  requiredReviewsPassed: boolean;
}

/** Trusted, fresh facts obtained by the service, NEVER accepted in an API body. */
export interface TicketFacts {
  clientAccessActive?: boolean;
  project?: { id: string; workspaceId: string; creatorActive: boolean; nonProductionSafe: boolean };
  issues?: readonly TicketIssueEvidence[];
  scope?: { id: string; ticketId: string; workspaceId: string };
  message?: { id: string; ticketId: string; authorId: string; audience: 'client' | 'internal' };
  delivery?: { id: string; scopeVersionId: string; pinnedAssetId: string; immutable: boolean; issueRevisionIds: readonly string[] };
  /** All this ticket's queued/running work resolved; not a request-supplied flag. */
  workStopped?: boolean;
}

const id = z.string().min(1).max(200).refine(value => value.trim() === value && value.length > 0);
const reason = z.string().trim().min(1).max(4000);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const issueIds = z.array(id).min(1).refine(values => new Set(values).size === values.length);
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('review') }).strict(),
  z.object({ type: z.literal('decline'), reason }).strict(),
  z.object({ type: z.literal('request_details'), messageId: id }).strict(),
  z.object({ type: z.literal('reply'), messageId: id }).strict(),
  z.object({ type: z.literal('propose_scope'), scopeVersionId: id }).strict(),
  z.object({ type: z.literal('agree_scope'), scopeVersionId: id }).strict(),
  z.object({ type: z.literal('authorize_work'), scopeVersionId: id, projectId: id, issueIds }).strict(),
  z.object({ type: z.literal('assess_delivery'), deliveryId: id }).strict(),
  z.object({ type: z.literal('share_delivery'), deliveryId: id }).strict(),
  z.object({ type: z.literal('request_correction'), deliveryId: id, messageId: id }).strict(),
  z.object({ type: z.literal('authorize_correction'), deliveryId: id, issueIds, reason }).strict(),
  z.object({ type: z.literal('request_fixes'), issueIds, reason }).strict(),
  z.object({ type: z.literal('accept_delivery'), deliveryId: id }).strict(),
  z.object({ type: z.literal('close_accepted'), deliveryId: id }).strict(),
  z.object({ type: z.literal('answer_close'), messageId: id }).strict(),
  z.object({ type: z.literal('request_withdrawal'), reason }).strict(),
  z.object({ type: z.literal('cancel'), reason }).strict(),
  z.object({ type: z.literal('hold'), reason }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
]);
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: id,
  expectedVersion: version,
  command: commandSchema,
}).strict();
export type TicketCommandEnvelope = z.infer<typeof envelopeSchema>;
export type TicketCommand = TicketCommandEnvelope['command'];

export class TicketWorkflowError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, readonly code: string, message: string) {
    super(message);
    this.name = 'TicketWorkflowError';
  }
}

export function parseTicketCommand(input: unknown): TicketCommandEnvelope {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This ticket command is invalid.');
  return parsed.data;
}

export function newTicketWorkflow(id: string, workspaceId: string, clientId: string | null = null): TicketWorkflow {
  return {
    id, workspaceId, version: 0, status: 'received', clientId, scopeVersionId: null,
    agreedScopeVersionId: null, authorizedScopeVersionId: null, projectId: null,
    requiredIssueIds: [], delivery: null, correctionRequestedFor: null, withdrawalRequested: false,
    actionOwner: 'pm', nextAction: 'review_ticket', hold: null, closureReason: null,
  };
}

const terminal = new Set<TicketStatus>(['closed', 'declined', 'cancelled']);
const clientCommands = new Set<TicketCommand['type']>(['reply', 'agree_scope', 'request_correction', 'accept_delivery', 'request_withdrawal']);
function conflict(code: string, message: string): never { throw new TicketWorkflowError(409, code, message); }
function requireStatus(state: TicketWorkflow, allowed: readonly TicketStatus[]): void {
  if (!allowed.includes(state.status)) conflict('invalid_ticket_transition', 'This action is not available at the ticket’s current stage.');
}
export function assertTicketActor(state: TicketWorkflow, actor: TicketActor): void {
  if (actor.workspaceId !== state.workspaceId) throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
  if (actor.kind === 'client') {
    if (!actor.grantActive || actor.ticketId !== state.id || actor.userId !== state.clientId) {
      throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
    }
  } else if (actor.kind !== 'pm' || !actor.membershipActive || !actor.canManageTickets) {
    throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot make this ticket decision.');
  }
}

/** Reused for append-only PM notes without advancing the shared workflow. */
export function assertTicketWritable(state: TicketWorkflow, expectedVersion: number): void {
  if (state.version !== expectedVersion) conflict('ticket_version_conflict', 'The ticket changed. Refresh before making this decision.');
  if (terminal.has(state.status)) conflict('ticket_is_read_only', 'This ticket is read-only. Submit a new linked ticket for further work.');
}

/** Shared by the transaction service before looking up a saved operation. */
export function assertTicketCommandAccess(
  state: TicketWorkflow, actor: TicketActor, command: TicketCommand,
  mode: 'enabled' | 'disabled' | 'maintenance',
): void {
  assertTicketActor(state, actor);
  if (command.type !== 'reply' && (actor.kind === 'client') !== clientCommands.has(command.type)) {
    throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot make this ticket decision.');
  }
  if (mode !== 'enabled' && !(mode === 'maintenance' && actor.kind === 'pm' && command.type === 'cancel')) {
    throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
  }
}
function assertClientAvailable(state: TicketWorkflow, facts: TicketFacts): void {
  if (!state.clientId || !facts.clientAccessActive) conflict('client_access_inactive', 'The client must have active ticket access.');
}
function assertMessage(state: TicketWorkflow, actor: TicketActor, messageId: string, facts: TicketFacts): void {
  const message = facts.message;
  if (!message || message.id !== messageId || message.ticketId !== state.id
    || message.authorId !== actor.userId || message.audience !== 'client') {
    conflict('public_message_required', 'This action requires an authorized client-visible message.');
  }
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && a.every(value => b.includes(value));
}
function assertProject(state: TicketWorkflow, projectId: string, facts: TicketFacts): void {
  if (state.projectId && state.projectId !== projectId) {
    conflict('ticket_project_conflict', 'A ticket cannot silently move to another project.');
  }
  const project = facts.project;
  if (!project || project.id !== projectId || project.workspaceId !== state.workspaceId
    || !project.creatorActive || !project.nonProductionSafe) {
    conflict('ticket_project_ineligible', 'The project is not ready for authorized ticket work.');
  }
}
function assertIssues(state: TicketWorkflow, ids: readonly string[], projectId: string, scopeVersionId: string, facts: TicketFacts, passed: boolean): TicketIssueEvidence[] {
  const issues = facts.issues;
  if (!issues || !ids.length || !sameSet(ids, issues.map(issue => issue.id))) {
    conflict('ticket_manifest_incomplete', 'The required Issue manifest is missing or has changed.');
  }
  const revisions = new Set<string>();
  for (const issue of issues) {
    if (issue.ticketId !== state.id || issue.workspaceId !== state.workspaceId || issue.projectId !== projectId
      || issue.scopeVersionId !== scopeVersionId || !issue.revisionId || revisions.has(issue.revisionId)) {
      conflict('ticket_manifest_conflict', 'An Issue does not match this ticket’s approved work.');
    }
    revisions.add(issue.revisionId);
    if (passed && (issue.status !== 'done' || !issue.requiredReviewsPassed || issue.hasActiveRun !== false)) {
      conflict('technical_review_incomplete', 'All required work and technical reviews must pass first.');
    }
  }
  return [...issues];
}
function assertIssuesStartable(issues: readonly TicketIssueEvidence[]): void {
  if (issues.some(issue => (issue.status !== 'backlog' && issue.status !== 'todo') || issue.hasActiveRun !== false)) {
    conflict('ticket_issue_not_startable', 'New ticket work must use Issues that have not started or completed.');
  }
}
function assertAuthorizedWork(state: TicketWorkflow, facts: TicketFacts, passed: boolean, needsExecutionSafety = true): TicketIssueEvidence[] {
  assertClientAvailable(state, facts);
  if (!state.scopeVersionId || state.agreedScopeVersionId !== state.scopeVersionId
    || state.authorizedScopeVersionId !== state.scopeVersionId || !state.projectId) {
    conflict('work_not_authorized', 'Current scope agreement and PM work authorization are required.');
  }
  if (needsExecutionSafety) assertProject(state, state.projectId, facts);
  return assertIssues(state, state.requiredIssueIds, state.projectId, state.scopeVersionId, facts, passed);
}
function assertDeliveryPointer(state: TicketWorkflow, deliveryId: string, facts: TicketFacts, shared: boolean): TicketDelivery {
  const current = state.delivery;
  const evidence = facts.delivery;
  if (!current || current.id !== deliveryId || !current.assessedByPmId || (shared && !current.shared)
    || !evidence || !evidence.immutable || !evidence.pinnedAssetId
    || evidence.id !== current.id || evidence.scopeVersionId !== state.scopeVersionId
    || current.scopeVersionId !== state.scopeVersionId || evidence.pinnedAssetId !== current.pinnedAssetId
    || !sameSet(evidence.issueRevisionIds, current.issueRevisionIds)) {
    conflict('delivery_not_current', 'Review the current approved, pinned delivery instead.');
  }
  return current;
}
function assertDelivery(state: TicketWorkflow, deliveryId: string, facts: TicketFacts, shared: boolean): TicketDelivery {
  const current = assertDeliveryPointer(state, deliveryId, facts, shared);
  // Client review/closure does not launch work or require a former developer
  // to remain assigned. Execution/release eligibility is checked separately.
  const work = assertAuthorizedWork(state, facts, true, false);
  if (!sameSet(current.issueRevisionIds, work.map(issue => issue.revisionId))) {
    conflict('delivery_not_current', 'Review the current approved, pinned delivery instead.');
  }
  return current;
}

export interface TicketDecision {
  state: TicketWorkflow;
  /** The store must persist this event and any affected Issue changes atomically. */
  event: { type: TicketCommand['type'] | 'technical_work_ready'; operationId: string; actorKind: TicketActor['kind'] | 'execution'; actorId: string; fromVersion: number; toVersion: number };
  reopenIssueIds: string[];
}

/** Completed technical evidence is not PM assessment or client publication.
 * Reused by trusted internal artifact registration; never accepts browser facts.
 */
export function assertCompletedTicketWork(state: TicketWorkflow, facts: TicketFacts): TicketIssueEvidence[] {
  requireStatus(state, ['in_progress']);
  if (state.withdrawalRequested) conflict('withdrawal_pending', 'The PM must resolve the withdrawal request before work continues.');
  return assertAuthorizedWork(state, facts, true, false);
}

/**
 * Internal integration hook, not a client/PM command. The existing Issue/run
 * service must resolve the assigned execution identity and verify its signed
 * revision before calling; the public command parser cannot express this event.
 */
export function decideTechnicalReadiness(
  state: TicketWorkflow,
  actor: { kind: 'execution'; userId: string; workspaceId: string; ticketId: string; issueId: string; issueRevisionId: string; authorized: boolean },
  operationId: string, expectedVersion: number, facts: TicketFacts,
  mode: 'enabled' | 'disabled' = 'disabled',
): TicketDecision {
  if (!actor.authorized || actor.workspaceId !== state.workspaceId || actor.ticketId !== state.id) {
    throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
  }
  if (mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
  if (!id.safeParse(operationId).success || !version.safeParse(expectedVersion).success) {
    throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This ticket command is invalid.');
  }
  if (state.version !== expectedVersion) conflict('ticket_version_conflict', 'The ticket changed. Refresh before making this decision.');
  const work = assertCompletedTicketWork(state, facts);
  if (!work.some(issue => issue.id === actor.issueId && issue.revisionId === actor.issueRevisionId)) {
    conflict('execution_revision_conflict', 'The execution event does not match the approved Issue revision.');
  }
  if (state.delivery || state.nextAction === 'assess_result') conflict('technical_readiness_already_recorded', 'Reconcile the existing technical readiness decision.');
  const next = structuredClone(state);
  next.version += 1; next.actionOwner = 'pm'; next.nextAction = 'assess_result';
  return {
    state: next, reopenIssueIds: [],
    event: { type: 'technical_work_ready', operationId, actorKind: 'execution', actorId: actor.userId, fromVersion: state.version, toVersion: next.version },
  };
}

/** Pure decision only. Idempotency, locking, durable audit and effects belong to the transaction service. */
export function decideTicketCommand(
  state: TicketWorkflow, actor: TicketActor, input: unknown, facts: TicketFacts = {},
  mode: 'enabled' | 'disabled' | 'maintenance' = 'disabled',
): TicketDecision {
  assertTicketActor(state, actor); // Refuse outsiders before revealing stage/version/validation details.
  const envelope = parseTicketCommand(input);
  const command = envelope.command;
  assertTicketCommandAccess(state, actor, command, mode);
  assertTicketWritable(state, envelope.expectedVersion);
  if (state.withdrawalRequested && !['cancel', 'hold', 'reply'].includes(command.type)) {
    conflict('withdrawal_pending', 'The PM must resolve the withdrawal request before work continues.');
  }
  const next = structuredClone(state);
  let reopenIssueIds: string[] = [];
  const action = (owner: ActionOwner, name: NextAction) => { next.actionOwner = owner; next.nextAction = name; };
  const correction = (ids: string[]) => {
    if (!ids.every(issueId => state.requiredIssueIds.includes(issueId))) conflict('correction_outside_manifest', 'Corrections must belong to this ticket’s agreed work.');
    // Keep the full ownership/revision manifest, but only reopen affected work.
    // Ticket-linked Issues are claimable by any developer authorized for the project.
    const work = assertAuthorizedWork(state, facts, false, true);
    if (work.some(issue => ids.includes(issue.id)
      && ((issue.status !== 'review' && issue.status !== 'done') || issue.hasActiveRun !== false))) {
      conflict('ticket_correction_not_ready', 'Return only reviewed or completed Issues with no active run. Already queued work must not be restarted.');
    }
    reopenIssueIds = [...ids];
    next.delivery = null; // Supersede the current pointer; never delete delivery/audit history.
    next.correctionRequestedFor = null;
    next.status = 'in_progress';
    action('developer', 'execute_work');
  };
  switch (command.type) {
    case 'review':
      requireStatus(state, ['received']);
      next.status = 'under_review'; action('pm', 'review_ticket'); break;
    case 'decline':
      requireStatus(state, ['received', 'under_review']);
      if (state.authorizedScopeVersionId || state.requiredIssueIds.length) conflict('work_already_authorized', 'Use the cancellation process for authorized work.');
      next.status = 'declined'; action(null, null); break;
    case 'request_details':
      requireStatus(state, ['under_review', 'awaiting_client', 'in_progress', 'ready_for_review']);
      assertClientAvailable(state, facts); assertMessage(state, actor, command.messageId, facts);
      if (['under_review', 'awaiting_client'].includes(state.status)) next.status = 'awaiting_client';
      action('client', 'reply'); break;
    case 'reply':
      assertMessage(state, actor, command.messageId, facts);
      if (actor.kind === 'client') {
        if (state.status === 'awaiting_client') next.status = 'under_review';
        if (next.hold?.status === 'awaiting_client') {
          next.hold = { status: 'under_review', actionOwner: 'pm', nextAction: 'reply' };
        }
        action('pm', state.status === 'on_hold' ? 'resolve_hold' : state.withdrawalRequested ? 'handle_withdrawal' : 'reply');
      }
      // A PM's ordinary update is not automatically a request for client action.
      break;
    case 'propose_scope':
      if (state.authorizedScopeVersionId || state.requiredIssueIds.length > 0) {
        conflict('scope_change_requires_linked_ticket', 'New or changed work after authorization must use a linked ticket. Existing work is unchanged.');
      }
      requireStatus(state, ['under_review', 'awaiting_client']);
      assertClientAvailable(state, facts);
      if (!facts.scope || facts.scope.id !== command.scopeVersionId || facts.scope.ticketId !== state.id || facts.scope.workspaceId !== state.workspaceId) {
        conflict('scope_not_current', 'An authorized scope version for this ticket is required.');
      }
      if (command.scopeVersionId === state.scopeVersionId) conflict('scope_not_new', 'Propose a new immutable scope version.');
      next.scopeVersionId = command.scopeVersionId; next.agreedScopeVersionId = null; next.authorizedScopeVersionId = null;
      next.delivery = null; next.correctionRequestedFor = null; next.status = 'awaiting_client'; action('client', 'agree_scope'); break;
    case 'agree_scope':
      requireStatus(state, ['awaiting_client', 'under_review']);
      if (command.scopeVersionId !== state.scopeVersionId) conflict('scope_not_current', 'Only the current proposed scope can be agreed.');
      if (state.agreedScopeVersionId === command.scopeVersionId) conflict('scope_already_agreed', 'Agreement is already recorded; reconcile the original operation.');
      next.agreedScopeVersionId = command.scopeVersionId; next.status = 'under_review'; action('pm', 'authorize_work'); break;
    case 'authorize_work':
      requireStatus(state, ['under_review']); assertClientAvailable(state, facts);
      if (state.authorizedScopeVersionId) conflict('work_already_authorized', 'Use targeted corrections or a newly agreed scope instead of replacing authorized work.');
      if (state.scopeVersionId !== command.scopeVersionId || state.agreedScopeVersionId !== command.scopeVersionId) conflict('scope_not_agreed', 'The client must agree this scope before work is authorized.');
      assertProject(state, command.projectId, facts);
      assertIssuesStartable(assertIssues(state, command.issueIds, command.projectId, command.scopeVersionId, facts, false));
      next.authorizedScopeVersionId = command.scopeVersionId; next.projectId = command.projectId;
      next.requiredIssueIds = [...command.issueIds]; next.delivery = null; next.status = 'in_progress'; action('developer', 'execute_work'); break;
    case 'assess_delivery': {
      requireStatus(state, ['in_progress']);
      const work = assertAuthorizedWork(state, facts, true);
      const delivery = facts.delivery;
      if (!delivery || delivery.id !== command.deliveryId || delivery.scopeVersionId !== state.scopeVersionId
        || !delivery.immutable || !delivery.pinnedAssetId || !sameSet(delivery.issueRevisionIds, work.map(issue => issue.revisionId))) {
        conflict('delivery_not_current', 'Assessment requires a pinned result for the complete current work manifest.');
      }
      next.delivery = {
        id: delivery.id, scopeVersionId: delivery.scopeVersionId, pinnedAssetId: delivery.pinnedAssetId,
        issueRevisionIds: [...delivery.issueRevisionIds], assessedByPmId: actor.userId, shared: false, acceptedByClientId: null,
      };
      action('pm', 'share_result'); break;
    }
    case 'share_delivery':
      requireStatus(state, ['in_progress']); assertAuthorizedWork(state, facts, true); assertDelivery(state, command.deliveryId, facts, false);
      next.delivery!.shared = true; next.status = 'ready_for_review'; action('client', 'review_result'); break;
    case 'request_correction':
      requireStatus(state, ['ready_for_review']); assertDeliveryPointer(state, command.deliveryId, facts, true);
      assertMessage(state, actor, command.messageId, facts);
      next.delivery!.acceptedByClientId = null; next.correctionRequestedFor = command.deliveryId;
      next.status = 'under_review'; action('pm', 'triage_correction'); break;
    case 'authorize_correction':
      requireStatus(state, ['under_review']);
      if (state.correctionRequestedFor !== command.deliveryId || state.delivery?.id !== command.deliveryId) conflict('correction_not_current', 'The PM must review the current delivery feedback.');
      correction(command.issueIds); break;
    case 'request_fixes':
      requireStatus(state, ['in_progress']); correction(command.issueIds); break;
    case 'accept_delivery':
      requireStatus(state, ['ready_for_review']); assertDelivery(state, command.deliveryId, facts, true);
      if (state.delivery!.acceptedByClientId) conflict('delivery_already_accepted', 'Acceptance is already recorded; reconcile the original operation.');
      next.delivery!.acceptedByClientId = actor.userId; action('pm', 'close_ticket'); break;
    case 'close_accepted':
      requireStatus(state, ['ready_for_review']); assertDelivery(state, command.deliveryId, facts, true);
      if (state.delivery!.acceptedByClientId !== state.clientId) conflict('client_acceptance_required', 'The client must accept this delivery before closure.');
      next.status = 'closed'; next.closureReason = 'accepted'; action(null, null); break;
    case 'answer_close':
      requireStatus(state, ['under_review']); assertMessage(state, actor, command.messageId, facts);
      if (state.authorizedScopeVersionId || state.requiredIssueIds.length) conflict('implementation_outstanding', 'Authorized implementation cannot be closed as an answer-only request.');
      next.status = 'closed'; next.closureReason = 'answered'; action(null, null); break;
    case 'request_withdrawal':
      next.withdrawalRequested = true; action('pm', 'handle_withdrawal'); break;
    case 'cancel':
      if (!facts.workStopped) conflict('ticket_work_not_stopped', 'Resolve this ticket’s queued and running work before cancellation.');
      next.status = 'cancelled'; next.closureReason = 'cancelled'; next.authorizedScopeVersionId = null;
      next.hold = null; action(null, null); break;
    case 'hold':
      if (state.status === 'on_hold') conflict('ticket_already_held', 'This ticket is already on hold.');
      next.hold = { status: state.status, actionOwner: state.actionOwner, nextAction: state.nextAction };
      next.status = 'on_hold'; action('pm', 'resolve_hold'); break;
    case 'resume':
      requireStatus(state, ['on_hold']);
      if (!state.hold || terminal.has(state.hold.status) || state.hold.status === 'on_hold') conflict('invalid_hold_state', 'The saved stage cannot be resumed.');
      if (state.authorizedScopeVersionId) assertAuthorizedWork(state, facts, false);
      if (state.hold.status === 'ready_for_review') assertDelivery(state, state.delivery?.id ?? '', facts, true);
      if (state.hold.actionOwner === 'client') assertClientAvailable(state, facts);
      next.status = state.hold.status; action(state.hold.actionOwner, state.hold.nextAction); next.hold = null; break;
  }
  next.version = state.version + 1;
  return {
    state: next, reopenIssueIds,
    event: { type: command.type, operationId: envelope.operationId, actorKind: actor.kind, actorId: actor.userId, fromVersion: state.version, toVersion: next.version },
  };
}
