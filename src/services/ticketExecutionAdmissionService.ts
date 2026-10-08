import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { TicketSubject } from '../store/ticketCommandStore.js';
import type {
  LockedTicketIssue, SavedTicketAdmission, TicketAdmissionKey, TicketAdmissionReceipt,
  TicketExecutionAdmissionStore, TicketExecutionAdmissionTransaction, TicketExecutionClaim, TicketExecutor, TicketIssueTarget, TicketRunAdmissionSubject,
} from '../store/ticketExecutionAdmissionStore.js';
import { projectDeveloperTicketContext } from '../ticketing/developerContext.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const opaque = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const executorSchema = z.object({ kind: z.enum(['agent', 'squad']), id: opaque }).strict();
const inputSchema = z.object({ schemaVersion: z.literal(1), operationId: opaque,
  expectedRevisionId: opaque, executor: executorSchema }).strict();
const missing = () => new TicketWorkflowError(404, 'ticket_work_not_found', 'Issue work not found.');
const conflict = () => new TicketWorkflowError(409, 'ticket_execution_conflict', 'Reconcile the current Issue execution before starting work.');
function invariant(value: unknown): asserts value { if (!value) throw new TicketReadInvariantError(); }
function validTarget(target: TicketIssueTarget) { return opaque.safeParse(target?.workspaceId).success && opaque.safeParse(target?.issueId).success; }
function sameExecutor(a: TicketExecutor, b: TicketExecutor) { return a.kind === b.kind && a.id === b.id; }
function sameKey(a: TicketAdmissionKey, b: TicketAdmissionKey) {
  return a.workspaceId === b.workspaceId && a.issueId === b.issueId && a.actorId === b.actorId && a.operationId === b.operationId;
}
function assertOwner(target: TicketIssueTarget, userId: string, issue: LockedTicketIssue) {
  if (issue.kind === 'unlinked') {
    invariant(issue.workspaceId === target.workspaceId && issue.issueId === target.issueId && issue.developerId === userId);
  } else {
    const snapshot = issue.snapshot;
    invariant(snapshot.workspaceId === target.workspaceId && snapshot.issue.workspaceId === target.workspaceId
      && snapshot.issue.id === target.issueId && snapshot.issue.assignedDeveloperId === userId
      && snapshot.ticket.workspaceId === target.workspaceId && snapshot.ticket.state.workspaceId === target.workspaceId
      && snapshot.ticket.id === snapshot.ticket.state.id && snapshot.issue.ticketId === snapshot.ticket.id
      && snapshot.project.workspaceId === target.workspaceId && snapshot.project.id === snapshot.issue.projectId
      && snapshot.scope.workspaceId === target.workspaceId && snapshot.scope.ticketId === snapshot.ticket.id);
  }
}
function currentContext(target: TicketIssueTarget, userId: string, issue: Extract<LockedTicketIssue, { kind: 'ticket' }>, executor: TicketExecutor) {
  assertOwner(target, userId, issue);
  if (issue.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket execution is unavailable right now.');
  if (issue.clientAccessActive !== true || issue.projectCreatorActive !== true) {
    throw new TicketWorkflowError(409, 'ticket_work_not_authorized', 'This Issue has no current approved work context.');
  }
  if (issue.executor.active !== true || issue.executor.allowed !== true || !sameExecutor(issue.executor, executor)) throw conflict();
  return projectDeveloperTicketContext(target.workspaceId, target.issueId, userId, issue.snapshot);
}
function receipt(saved: SavedTicketAdmission, key: TicketAdmissionKey): TicketAdmissionReceipt {
  const value = saved.receipt;
  invariant(sameKey(saved.key, key) && value.workspaceId === key.workspaceId && value.issueId === key.issueId
    && value.operationId === key.operationId && opaque.safeParse(value.claimId).success && opaque.safeParse(value.issueRevisionId).success);
  return { workspaceId: value.workspaceId, issueId: value.issueId, operationId: value.operationId,
    claimId: value.claimId, issueRevisionId: value.issueRevisionId };
}
function ownsClaim(claim: TicketExecutionClaim, target: TicketIssueTarget, issue: Extract<LockedTicketIssue, { kind: 'ticket' }>, developerId: string, executor: TicketExecutor) {
  const { snapshot } = issue;
  return opaque.safeParse(claim.id).success && claim.workspaceId === target.workspaceId && claim.issueId === target.issueId
    && claim.developerId === developerId && claim.ticketId === snapshot.ticket.id && claim.projectId === snapshot.project.id
    && claim.scopeVersionId === snapshot.scope.id && claim.issueRevisionId === snapshot.issue.revisionId && sameExecutor(claim.executor, executor);
}

/** Application-only logical Issue reservation and queue-front admission.
 * Not mounted or connected to runners; receipts are not process-start permits.
 */
export function createTicketExecutionAdmissionService(store: TicketExecutionAdmissionStore,
  now: () => Date = () => new Date(), nextId: () => string = randomUUID) {
  async function authorize(tx: TicketExecutionAdmissionTransaction, target: TicketIssueTarget, subject: TicketSubject) {
    if (!validTarget(target) || subject?.kind !== 'internal' || !opaque.safeParse(subject.userId).success) throw missing();
    const issue = await tx.lockAssignedIssue(target, subject);
    if (!issue) throw missing();
    assertOwner(target, subject.userId, issue);
    return issue;
  }
  return {
    async reserve(target: TicketIssueTarget, subject: TicketSubject, input: unknown): Promise<{ kind: 'unlinked' } | { kind: 'ticket'; receipt: TicketAdmissionReceipt }> {
      return store.transaction(async tx => {
        const issue = await authorize(tx, target, subject);
        // This is a positive authorized classification, NEVER an error fallback.
        // The adapter must serialize absence with future binding/legacy claims.
        if (issue.kind === 'unlinked') return { kind: 'unlinked' };
        const parsed = inputSchema.safeParse(input);
        if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This execution request is invalid.');
        const inputValue = parsed.data;
        const key: TicketAdmissionKey = { workspaceId: target.workspaceId, issueId: target.issueId, actorId: subject.userId, operationId: inputValue.operationId };
        const fingerprint = createHash('sha256').update(JSON.stringify(['ticket_execution_reservation_v1', key,
          inputValue.expectedRevisionId, inputValue.executor.kind, inputValue.executor.id])).digest('hex');
        const saved = await tx.findOperation(key);
        if (saved) {
          if (saved.fingerprint !== fingerprint) throw new TicketWorkflowError(409, 'ticket_operation_conflict', 'This operation ID was already used for a different execution.');
          return { kind: 'ticket', receipt: receipt(saved, key) };
        }
        const context = currentContext(target, subject.userId, issue, inputValue.executor);
        if (context.issueRevisionId !== inputValue.expectedRevisionId) throw conflict();
        if (await tx.findActiveClaim(target)) throw conflict();
        // Existing in-progress/agent-running status without a matching claim is
        // not evidence of a safe retry. Historical reconciliation comes first.
        if (issue.snapshot.issue.status !== 'todo') throw conflict();
        const claim: TicketExecutionClaim = { workspaceId: target.workspaceId, issueId: target.issueId, id: nextId(), ticketId: issue.snapshot.ticket.id,
          projectId: context.projectId, scopeVersionId: context.scopeVersionId, issueRevisionId: context.issueRevisionId,
          developerId: subject.userId, executor: { ...inputValue.executor }, phase: 'reserved', runId: null };
        invariant(opaque.safeParse(claim.id).success);
        await tx.insertClaim(claim);
        await tx.appendAudit({ type: 'ticket_execution_reserved', claim, occurredAt: now().toISOString() });
        const value: TicketAdmissionReceipt = { workspaceId: target.workspaceId, issueId: target.issueId, operationId: key.operationId, claimId: claim.id, issueRevisionId: claim.issueRevisionId };
        await tx.insertOperation({ key, fingerprint, receipt: value });
        return { kind: 'ticket', receipt: { ...value } };
      });
    },
    async lookup(target: TicketIssueTarget, subject: TicketSubject, operationId: string): Promise<TicketAdmissionReceipt | null> {
      return store.transaction(async tx => {
        const issue = await authorize(tx, target, subject);
        if (issue.kind === 'unlinked') return null;
        if (!opaque.safeParse(operationId).success) throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This execution request is invalid.');
        const key = { workspaceId: target.workspaceId, issueId: target.issueId, actorId: subject.userId, operationId };
        const saved = await tx.findOperation(key);
        return saved ? receipt(saved, key) : null;
      });
    },
    async admit(target: TicketIssueTarget, subject: TicketRunAdmissionSubject) {
      return store.transaction(async tx => {
        if (!validTarget(target) || subject?.kind !== 'verified_run_admission' || !opaque.safeParse(subject.verificationId).success) throw missing();
        const run = await tx.lockVerifiedRun(target, subject);
        if (!run) throw missing();
        invariant(opaque.safeParse(run.runId).success && opaque.safeParse(run.claimId).success && opaque.safeParse(run.developerId).success
          && executorSchema.safeParse(run.executor).success);
        const context = currentContext(target, run.developerId, run.issue, run.executor);
        const claim = await tx.findActiveClaim(target);
        if (!claim || claim.id !== run.claimId || !ownsClaim(claim, target, run.issue, run.developerId, run.executor)) throw conflict();
        if (claim.phase === 'admitted' && claim.runId === run.runId) {
          // Recovery may report prior admission, but must never respawn it.
          return { claimId: claim.id, runId: run.runId, newlyAdmitted: false, context };
        }
        if (claim.phase !== 'reserved' || claim.runId !== null || !await tx.admitClaim(claim, run.runId)) throw conflict();
        await tx.appendAudit({ type: 'ticket_execution_admitted', claim: { ...claim, phase: 'admitted', runId: run.runId }, occurredAt: now().toISOString() });
        return { claimId: claim.id, runId: run.runId, newlyAdmitted: true, context };
      });
    },
  };
}
