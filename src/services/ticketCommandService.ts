import { randomUUID } from 'node:crypto';

import {
  assertTicketCommandAccess, decideTicketCommand, parseTicketCommand, TicketWorkflowError,
} from '../ticketing/workflow.js';
import type {
  TicketCommandReceipt, TicketCommandStore, TicketOperationReceipt, TicketSubject, TicketTarget,
} from '../store/ticketCommandStore.js';
import { authorizeTicketAccess } from './ticketAccess.js';
import { ticketOperationConflict, ticketOperationFingerprint, ticketOperationKey, ticketOperationReceipt } from './ticketOperations.js';
import type { TicketDeliveryReadPolicy } from '../store/ticketDeliveryStore.js';
import { assertTicketDeliveryReadPolicy } from '../ticketing/deliveryReadModels.js';
import { verifyTicketDeliveryAssessmentCandidate } from './ticketDeliveryAssessmentService.js';

// Pure application service: no env imports, singleton DB, email or runner calls.
export function createTicketCommandService(
  store: TicketCommandStore, now: () => Date = () => new Date(), nextRevisionId: () => string = randomUUID,
  suppliedAssessmentPolicy?: TicketDeliveryReadPolicy,
) {
  if (suppliedAssessmentPolicy) assertTicketDeliveryReadPolicy(suppliedAssessmentPolicy);
  const assessmentPolicy = suppliedAssessmentPolicy ? { ...suppliedAssessmentPolicy } : null;
  return {
    async execute(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketCommandReceipt> {
      return store.transaction(async tx => {
        // Authorization precedes parsing, validation detail and operation replay.
        const ticket = await authorizeTicketAccess(tx, target, subject);
        const envelope = parseTicketCommand(input);
        assertTicketCommandAccess(ticket.state, ticket.actor, envelope.command, ticket.mode ?? 'disabled');
        const key = ticketOperationKey(ticket, envelope.operationId);
        const hash = ticketOperationFingerprint('command', envelope);
        const saved = await tx.findOperation(key);
        if (saved) {
          if (saved.kind !== 'command' || saved.fingerprint !== hash) ticketOperationConflict();
          // Return original outcome, even if a later command advanced the version.
          return ticketOperationReceipt(saved, key);
        }
        let facts = await tx.loadFacts(ticket, envelope);
        if (envelope.command.type === 'assess_delivery') {
          if (!assessmentPolicy) throw new TicketWorkflowError(503, 'ticket_delivery_unavailable', 'Result assessment is unavailable.');
          const candidate = await tx.loadAssessmentCandidate(ticket, envelope.command.deliveryId);
          const verified = verifyTicketDeliveryAssessmentCandidate(ticket, candidate ? { ...candidate, facts } : null, envelope.command.deliveryId, assessmentPolicy);
          const row = verified.snapshot.delivery;
          facts = { ...facts, delivery: { id: row.id, scopeVersionId: row.scopeVersionId, pinnedAssetId: row.pinnedAssetId,
            immutable: row.immutable, issueRevisionIds: row.issueRevisionIds } };
        }
        const decision = decideTicketCommand(ticket.state, ticket.actor, envelope, facts, ticket.mode ?? 'disabled');
        const occurredAt = now().toISOString();
        const result: TicketCommandReceipt = {
          ticketId: decision.state.id, operationId: envelope.operationId,
          version: decision.state.version, status: decision.state.status,
        };
        if (envelope.command.type === 'authorize_work') {
          // decideTicketCommand has validated the exact manifest, workspace,
          // project, agreed scope, revision IDs and startable state. A ticket
          // Issue is not tied to one named developer; project access governs claims.
          // Persist those links with the decision, never as a separate API write.
          await tx.insertWorkBindings(facts.issues!.map(issue => ({
            workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id,
            projectId: issue.projectId, issueId: issue.id,
            scopeVersionId: issue.scopeVersionId, issueRevisionId: issue.revisionId,
            authorizedByPmId: ticket.actor.userId, authorizedAt: occurredAt,
          })));
        }
        if (!await tx.saveWorkflow(target, ticket.state.version, decision.state)) {
          throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before making this decision.');
        }
        if (decision.reopenIssueIds.length) {
          const command = envelope.command;
          if (command.type !== 'request_fixes' && command.type !== 'authorize_correction') {
            throw new Error('A correction decision requires explicit developer instructions.');
          }
          const revisions = new Set(facts.issues!.map(issue => issue.revisionId));
          const corrections = decision.reopenIssueIds.map(issueId => {
            const issue = facts.issues!.find(item => item.id === issueId)!;
            const issueRevisionId = nextRevisionId();
            if (typeof issueRevisionId !== 'string' || !issueRevisionId.length || issueRevisionId.length > 200
              || issueRevisionId.trim() !== issueRevisionId || revisions.has(issueRevisionId)) {
              throw new Error('The server could not prepare a new correction revision.');
            }
            revisions.add(issueRevisionId);
            return {
              workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id, projectId: issue.projectId,
              issueId, scopeVersionId: issue.scopeVersionId, issueRevisionId,
              previousRevisionId: issue.revisionId, developerInstructions: command.reason,
              source: command.type, immutable: true as const,
              authorizedByPmId: ticket.actor.userId, authorizedAt: occurredAt,
            };
          });
          await tx.reopenIssues(ticket, corrections, facts);
        }
        await tx.appendAudit({ key, occurredAt, envelope, event: decision.event, reopenIssueIds: decision.reopenIssueIds });
        await tx.enqueueChange({ key, type: 'ticket_changed', version: decision.state.version, occurredAt });
        await tx.insertOperation({ kind: 'command', key, fingerprint: hash, receipt: result });
        return { ...result };
      });
    },

    /** Reconcile after a lost response/unknown COMMIT, using the SAME operation
     * ID. Fresh access is mandatory, but lookup remains possible while writes
     * are disabled. The receipt describes the original operation, not live state.
     */
    async lookup(target: TicketTarget, subject: TicketSubject, operationId: string): Promise<TicketOperationReceipt | null> {
      return store.transaction(async tx => {
        const ticket = await authorizeTicketAccess(tx, target, subject);
        if (typeof operationId !== 'string' || !operationId.length || operationId.length > 200 || operationId.trim() !== operationId) {
          throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This ticket command is invalid.');
        }
        const key = ticketOperationKey(ticket, operationId);
        const saved = await tx.findOperation(key);
        return saved ? ticketOperationReceipt(saved, key) : null;
      });
    },
  };
}
