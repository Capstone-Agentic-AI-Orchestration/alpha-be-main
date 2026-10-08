import type { TicketSubject, TicketWriteMode } from './ticketCommandStore.js';
import type { TicketDeveloperContextSnapshot } from './ticketDeveloperContextStore.js';

export interface TicketIssueTarget { workspaceId: string; issueId: string }
export type TicketExecutor = { kind: 'agent' | 'squad'; id: string };
/** Only an authorized, coherent read can positively classify an Issue as unlinked.
 * Missing/foreign/unavailable binding evidence must never take the legacy path.
 */
export type LockedTicketIssue =
  | (TicketIssueTarget & { kind: 'unlinked'; developerId: string })
  | { kind: 'ticket'; snapshot: TicketDeveloperContextSnapshot; clientAccessActive: boolean;
      projectCreatorActive: boolean; mode?: TicketWriteMode;
      executor: TicketExecutor & { active: boolean; allowed: boolean } };

/** One logical Issue execution; a squad owns ONE claim, not one per member.
 * Reserved and admitted claims both block new claims and technical readiness.
 * Admitted is an admission decision, not proof of a spawned/completed process.
 */
export interface TicketExecutionClaim extends TicketIssueTarget {
  id: string;
  ticketId: string;
  projectId: string;
  scopeVersionId: string;
  issueRevisionId: string;
  developerId: string;
  executor: TicketExecutor;
  phase: 'reserved' | 'admitted' | 'stopped';
  runId: string | null;
}
export interface TicketAdmissionKey extends TicketIssueTarget { actorId: string; operationId: string }
/** Private internal receipt, never a client DTO or executable capability. */
export interface TicketAdmissionReceipt extends TicketIssueTarget {
  operationId: string; claimId: string; issueRevisionId: string;
}
export interface SavedTicketAdmission { key: TicketAdmissionKey; fingerprint: string; receipt: TicketAdmissionReceipt }
export interface TicketRunAdmissionSubject { kind: 'verified_run_admission'; verificationId: string }
export interface LockedTicketRunAdmission {
  issue: Extract<LockedTicketIssue, { kind: 'ticket' }>;
  claimId: string;
  runId: string;
  developerId: string;
  executor: TicketExecutor;
}

/** One transaction with the shared command/revision/grant/claim lock order.
 * No process, git, filesystem, provider, email or network I/O in this callback.
 * Durable adapter and existing-run integration are intentionally deferred.
 */
export interface TicketExecutionAdmissionTransaction {
  /** Resolve verified internal identity, active developer membership/assignment,
   * exact tenant/Issue binding and selected executor from authoritative rows.
   * Never classify an unavailable ticket store as an unlinked Issue. Lock the
   * binding slot even when absent, serializing with PM authorize_work.
   */
  lockAssignedIssue(target: TicketIssueTarget, subject: TicketSubject): Promise<LockedTicketIssue | null>;
  /** Resolve a persisted worker verification reference, original developer's
   * CURRENT authority, exact persisted run + claim + executor relation, and fresh
   * Issue evidence. Not a browser run ID, an expired request context, or token.
   * Lock in the same order as lockAssignedIssue, then the claim/run rows.
   */
  lockVerifiedRun(target: TicketIssueTarget, subject: TicketRunAdmissionSubject): Promise<LockedTicketRunAdmission | null>;
  findOperation(key: TicketAdmissionKey): Promise<SavedTicketAdmission | null>;
  findActiveClaim(target: TicketIssueTarget): Promise<TicketExecutionClaim | null>;
  /** Insert-only; unique active (workspaceId, issueId) across ALL revisions,
   * agents, squads and operations. Reject conflicting old-revision claims too.
   * Persist the logical existing run/dispatch intent under this same transaction
   * in the future adapter; never launch a process or silently change assignment.
   */
  insertClaim(claim: TicketExecutionClaim): Promise<void>;
  /** Compare exact reserved claim + run relation; return false on drift. This
   * must atomically save the admission and its durable dispatch state. It does
   * not mean a process exists; ambiguous commits require reconciliation.
   */
  admitClaim(claim: TicketExecutionClaim, runId: string): Promise<boolean>;
  appendAudit(event: { type: 'ticket_execution_reserved' | 'ticket_execution_admitted'; claim: TicketExecutionClaim; occurredAt: string }): Promise<void>;
  insertOperation(operation: SavedTicketAdmission): Promise<void>;
}
export interface TicketExecutionAdmissionStore {
  /** Roll back all claims/dispatch/audit/outcomes on any failure. Never blindly
   * retry ambiguous COMMIT. Test actual distributed serialization in staging.
   */
  transaction<T>(work: (tx: TicketExecutionAdmissionTransaction) => Promise<T>): Promise<T>;
}
