import type { TicketCommandReceipt, TicketTarget, TicketWriteMode } from './ticketCommandStore.js';
import type { TicketDecision, TicketFacts, TicketWorkflow, decideTechnicalReadiness } from '../ticketing/workflow.js';

/** Server-owned verification reference for a persisted execution completion.
 * Not a browser identity, bearer token, request body, or arbitrary run ID.
 * The future existing-run integration must obtain it from its verified completion
 * boundary. No public route accepts this type or creates a verification record.
 */
export interface TicketExecutionCompletionSubject {
  kind: 'verified_execution_completion';
  verificationId: string;
}

export interface LockedTicketExecution {
  state: TicketWorkflow;
  actor: Parameters<typeof decideTechnicalReadiness>[1] & { runId: string; completionId: string };
  mode?: TicketWriteMode;
}

/** Distinct namespace from PM/client commands, never exposed by their lookup. */
export interface TicketReadinessOperationKey extends TicketTarget {
  kind: 'technical_work_ready';
  actorId: string;
  runId: string;
  completionId: string;
  operationId: string;
}
export interface TicketReadinessEnvelope {
  schemaVersion: 1;
  operationId: string;
  expectedVersion: number;
}

/** Private immutable evidence for this exact complete approved work revision. */
export interface TicketReadyManifest extends TicketTarget {
  id: string;
  projectId: string;
  scopeVersionId: string;
  issueRevisions: { issueId: string; revisionId: string }[];
}
export interface SavedTicketReadiness {
  key: TicketReadinessOperationKey;
  fingerprint: string;
  manifest: TicketReadyManifest;
  receipt: TicketCommandReceipt;
}
export interface TicketReadinessAudit {
  key: TicketReadinessOperationKey;
  envelope: TicketReadinessEnvelope;
  manifest: TicketReadyManifest;
  event: TicketDecision['event'];
  occurredAt: string;
}

/** Same lock/serialization order as ticket commands and execution claim changes.
 * All authorization, current Issue/review/run facts, manifest uniqueness, state,
 * operation outcome, audit and outbox changes belong to ONE transaction.
 * No provider, runner, file, network or email I/O inside its callback.
 */
export interface TicketTechnicalReadinessTransaction {
  /** Resolve the persisted server verification reference, execution principal,
   * workspace, run, completion receipt, exact ticket/Issue/revision binding and
   * current authority. Completed history may be used for receipt recovery after
   * later ticket changes; a current revision is independently required for a new
   * decision. Missing/revoked/foreign verification or authority returns null.
   * Never infer completion or authority from an Issue's display status alone.
   */
  lockAuthorizedExecution(target: TicketTarget, subject: TicketExecutionCompletionSubject): Promise<LockedTicketExecution | null>;
  findOperation(key: TicketReadinessOperationKey): Promise<SavedTicketReadiness | null>;
  /** Load the entire authoritative current manifest with exact review revisions
   * and all queued/reserved/running claims, not just the triggering Issue.
   */
  loadFacts(ticket: LockedTicketExecution): Promise<TicketFacts>;
  /** Unique per exact workspace/ticket/scope/project/Issue-revision manifest,
   * regardless of which parallel Issue completion triggered the notification.
   * Compare full canonical ownership/revisions, not an unchecked hash alone.
   */
  findRecordedManifest(manifest: TicketReadyManifest): Promise<SavedTicketReadiness | null>;
  saveWorkflow(target: TicketTarget, expectedVersion: number, state: TicketWorkflow): Promise<boolean>;
  appendAudit(audit: TicketReadinessAudit): Promise<void>;
  enqueueChange(signal: { key: TicketReadinessOperationKey; type: 'ticket_changed'; version: number; occurredAt: string }): Promise<void>;
  /** Insert-only operation key AND ready-manifest uniqueness. No upsert. A
   * conflict must roll back everything, including workflow/audit/outbox writes.
   */
  insertOperation(operation: SavedTicketReadiness): Promise<void>;
}
export interface TicketTechnicalReadinessStore {
  /** Full rollback on failure; never automatically retry an ambiguous COMMIT.
   * Recover using the same verified completion + operation ID through lookup.
   */
  transaction<T>(work: (tx: TicketTechnicalReadinessTransaction) => Promise<T>): Promise<T>;
}
