import type {
  TicketActor, TicketCommandEnvelope, TicketDecision, TicketFacts, TicketStatus, TicketWorkflow,
} from '../ticketing/workflow.js';
import type { TicketDeliveryAssessmentCandidate } from './ticketDeliveryAssessmentStore.js';

/** Verified by the appropriate server auth boundary, NEVER decoded from a body.
 * Recheck persisted sessions and exact identity binding where applicable.
 * Existing desktop GitHub bearer auth remains request-scoped: verificationId is
 * generated after the current request's GitHub token is verified. It is NOT a
 * token, JWT claim or client header. Cookie sessionId is the persisted hash id.
 * The adapter must resolve it from the current verified request context and
 * recheck internal membership/capability; it must not invent a client session.
 */
export type TicketSubject =
  | { kind: 'client'; userId: string; sessionId: string }
  | { kind: 'internal'; userId: string; authentication:
    | { kind: 'session'; sessionId: string }
    | { kind: 'verified_github_bearer'; verificationId: string } };

export interface TicketTarget { workspaceId: string; ticketId: string }
export type TicketWriteMode = 'enabled' | 'disabled' | 'maintenance';
export interface LockedTicket {
  state: TicketWorkflow;
  actor: TicketActor;
  /** Fresh server-owned workspace/project gate. Absent means disabled. */
  mode?: TicketWriteMode;
}

/** All columns form the unique operation key; never concatenate ambiguous IDs. */
export interface TicketOperationKey extends TicketTarget {
  actorKind: TicketActor['kind'];
  actorId: string;
  operationId: string;
}

/** Safe for either identity. No internal project, Issue, asset, note or actor IDs. */
export interface TicketCommandReceipt {
  ticketId: string;
  operationId: string;
  version: number;
  status: TicketStatus;
}

export interface TicketMessageReceipt extends TicketCommandReceipt { messageId: string }
export interface TicketCreationReceipt extends TicketCommandReceipt { reference: string }
export type TicketOperationReceipt = TicketCommandReceipt | TicketMessageReceipt | TicketCreationReceipt;

export type SavedTicketOperation = {
  key: TicketOperationKey;
  fingerprint: string;
  receipt: TicketCommandReceipt;
} & ({ kind: 'command' } | { kind: 'message' | 'note'; messageId: string } | { kind: 'create'; reference: string });

/** Private audit, not the client conversation or a log payload. The validated
 * command preserves the exact scope/delivery/Issue references and decision reason.
 */
export interface TicketCommandAudit {
  key: TicketOperationKey;
  occurredAt: string;
  envelope: TicketCommandEnvelope;
  event: TicketDecision['event'];
  reopenIssueIds: readonly string[];
}

/** Durable signal only. It is not an email, execution or deployment instruction.
 * A future worker must resolve authorized recipients and public projection anew.
 */
export interface TicketChangeSignal {
  key: TicketOperationKey;
  type: 'ticket_changed';
  version: number;
  occurredAt: string;
}

/** Private link to an EXISTING Alpha Issue, not a second task record. Immutable
 * initial revision; corrections retain this link and append their own history.
 * Never expose this record through a client projection.
 */
export interface TicketWorkBinding extends TicketTarget {
  projectId: string;
  issueId: string;
  scopeVersionId: string;
  issueRevisionId: string;
  authorizedByPmId: string;
  authorizedAt: string;
}

/** Append-only internal correction brief for one new execution revision.
 * Contains only the PM's explicit developer instructions, never an automatically
 * copied client thread, contact details or private PM notes.
 */
export interface TicketIssueCorrection extends TicketWorkBinding {
  previousRevisionId: string;
  developerInstructions: string;
  source: 'request_fixes' | 'authorize_correction';
  immutable: true;
}

/** One database transaction on one connection. Production adapter is deferred.
 * Shared lock order: current session + principal/workspace membership or client
 * service grant first; then ticket; then ticket grant and evidence rows in
 * stable ID order; finally operation, audit and outbox rows. If an operation
 * spans tickets, lock ticket IDs in stable order. Concurrent revocation/evidence
 * edits must follow this order or use equivalent serializable checks; a ticket
 * row lock alone does not protect authorization.
 * Every query is explicitly workspace/ticket/actor scoped, including an owner DB
 * connection. No network/provider/runner calls may happen in this callback.
 */
export interface TicketCommandTransaction {
  /** Non-enumerating null for absent ticket, session, or current access. */
  lockAuthorizedTicket(target: TicketTarget, subject: TicketSubject): Promise<LockedTicket | null>;
  /** Return the saved operation for this exact ticket key. For client creates,
   * the implementation must also consult ticket_creation_operations and map a
   * matching row to kind=create, so the create ID cannot be replayed as a new
   * command. Creation remains stored in its dedicated table because the
   * deployed ticket_operation_receipts constraint intentionally excludes it.
   */
  findOperation(key: TicketOperationKey): Promise<SavedTicketOperation | null>;
  /** Obtain authoritative scoped, version-pinned evidence, never caller facts.
   * For initial authorize_work, lock the selected existing Project/Issues and
   * return candidate links for exactly this ticket/scope with server-generated
   * revision IDs. Reject any existing ticket binding, even to this ticket: only
   * replay of a saved operation can reuse an already committed initial handoff.
   * No candidate may be inferred from request-supplied facts or Issue text.
   * For later commands, load the persisted links/current revisions instead.
   * For assess_delivery, facts.delivery MUST come from this ticket's immutable
   * registered candidate, joined to its exact committed ready manifest and fresh
   * clean scan/object generations. Reuse the protected registration validators;
   * never convert an arbitrary artifact ID or caller flags into delivery facts.
   * Recheck complete current reviews/claims and registration/scan validity in
   * this same transaction, including after a PM inspected the files earlier.
   * The command alone is not proof of human inspection or client publication.
   */
  loadFacts(ticket: LockedTicket, command: TicketCommandEnvelope): Promise<TicketFacts>;
  /** assess_delivery only: re-read the exact registered immutable bundle,
   * committed readiness, current scans and object generations under THIS command
   * transaction. The service revalidates it with loadFacts before saving approval.
   * Null for missing/foreign/unregistered candidate. Never fetch files here.
   */
  loadAssessmentCandidate(ticket: LockedTicket, deliveryId: string): Promise<TicketDeliveryAssessmentCandidate | null>;
  /** Insert the exact validated initial links in THIS transaction. Insert-only;
   * enforce unique (workspaceId, issueId) across all tickets, never upsert/rebind.
   * Recheck candidate/Project ownership, workspace/project developer access and
   * run eligibility under the shared execution serialization boundary. Do not mutate existing
   * Issue text/status/agent/squad assignment or create a Project/Issue/run.
   * Any conflicting/missing link must throw and roll back the entire handoff.
   */
  insertWorkBindings(bindings: readonly TicketWorkBinding[]): Promise<void>;
  /** Compare-and-swap even after locking. False must cause full rollback. */
  saveWorkflow(target: TicketTarget, expectedVersion: number, state: TicketWorkflow): Promise<boolean>;
  /** Reopen only these affected existing Issues; preserve immutable history.
   * Append each exact correction record, CAS its previous/current revision,
   * point current work at the new revision, and reopen as todo with fresh review
   * requirements. The original binding, reviews and deliveries stay immutable.
   * Verify fresh assignment, manifest/revision ownership and ticket execution gate;
   * selected Issues must still be review/done without any queued/running claim.
   * Reject duplicate revision IDs or conflicting revision/Issue writes and roll
   * back everything. Current revision + instructions must be readable together.
   * No implicit restart or launch. Future existing runner integration is separate.
   */
  reopenIssues(ticket: LockedTicket, corrections: readonly TicketIssueCorrection[], facts: TicketFacts): Promise<void>;
  appendAudit(audit: TicketCommandAudit): Promise<void>;
  enqueueChange(signal: TicketChangeSignal): Promise<void>;
  /** Insert-only unique key, never overwrite another operation's result. */
  insertOperation(operation: SavedTicketOperation): Promise<void>;
}

export interface TicketCommandStore {
  /** Roll back ALL mutations on any error. Do not retry an ambiguous commit.
   * State, initial work links, affected Issues, audit, signal and operation
   * outcome commit together.
   */
  transaction<T>(work: (tx: TicketCommandTransaction) => Promise<T>): Promise<T>;
}
