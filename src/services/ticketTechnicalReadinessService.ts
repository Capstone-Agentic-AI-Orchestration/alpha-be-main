import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { TicketCommandReceipt, TicketTarget } from '../store/ticketCommandStore.js';
import type {
  LockedTicketExecution, SavedTicketReadiness, TicketExecutionCompletionSubject,
  TicketReadinessEnvelope, TicketReadinessOperationKey,
  TicketTechnicalReadinessStore, TicketTechnicalReadinessTransaction,
} from '../store/ticketTechnicalReadinessStore.js';
import { decideTechnicalReadiness, TicketWorkflowError } from '../ticketing/workflow.js';
import { ticketReadyManifest } from '../ticketing/technicalReadiness.js';

const opaque = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const inputSchema = z.object({
  schemaVersion: z.literal(1), operationId: opaque,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
const notFound = () => new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
const invalid = () => new TicketWorkflowError(400, 'invalid_ticket_command', 'This ticket command is invalid.');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function authorize(
  tx: TicketTechnicalReadinessTransaction, target: TicketTarget, subject: TicketExecutionCompletionSubject,
): Promise<LockedTicketExecution> {
  if (!opaque.safeParse(target?.workspaceId).success || !opaque.safeParse(target?.ticketId).success
    || subject?.kind !== 'verified_execution_completion' || !opaque.safeParse(subject.verificationId).success) throw notFound();
  const ticket = await tx.lockAuthorizedExecution(target, subject);
  const actor = ticket?.actor;
  if (!ticket || !actor || actor.kind !== 'execution' || actor.authorized !== true
    || ticket.state.workspaceId !== target.workspaceId || ticket.state.id !== target.ticketId
    || actor.workspaceId !== target.workspaceId || actor.ticketId !== target.ticketId
    || ![actor.userId, actor.runId, actor.completionId, actor.issueId, actor.issueRevisionId].every(value => opaque.safeParse(value).success)) throw notFound();
  return ticket;
}
function keyFor(ticket: LockedTicketExecution, operationId: string): TicketReadinessOperationKey {
  return {
    workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id, kind: 'technical_work_ready',
    actorId: ticket.actor.userId, runId: ticket.actor.runId, completionId: ticket.actor.completionId, operationId,
  };
}
function receipt(saved: SavedTicketReadiness, key: TicketReadinessOperationKey): TicketCommandReceipt {
  if (Object.keys(key).some(field => saved.key[field as keyof TicketReadinessOperationKey] !== key[field as keyof TicketReadinessOperationKey])
    || saved.receipt.ticketId !== key.ticketId || saved.receipt.operationId !== key.operationId
    || saved.receipt.status !== 'in_progress' || !Number.isSafeInteger(saved.receipt.version) || saved.receipt.version < 1) {
    throw new Error('Ticket readiness store returned a mismatched outcome.');
  }
  return { ticketId: saved.receipt.ticketId, operationId: saved.receipt.operationId, version: saved.receipt.version, status: saved.receipt.status };
}

/** Internal completion application boundary only. No HTTP route, singleton,
 * process-memory runtime store, automatic share/closure or runner side effect.
 */
export function createTicketTechnicalReadinessService(
  store: TicketTechnicalReadinessStore, now: () => Date = () => new Date(),
) {
  return {
    async record(target: TicketTarget, subject: TicketExecutionCompletionSubject, input: unknown): Promise<TicketCommandReceipt> {
      return store.transaction(async tx => {
        const ticket = await authorize(tx, target, subject); // Before parsing/replay.
        if (ticket.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
        const parsed = inputSchema.safeParse(input);
        if (!parsed.success) throw invalid();
        const envelope: TicketReadinessEnvelope = parsed.data;
        const key = keyFor(ticket, envelope.operationId);
        const fingerprint = digest(['technical_work_ready_v1', key, envelope, ticket.actor.issueId, ticket.actor.issueRevisionId]);
        const saved = await tx.findOperation(key);
        if (saved) {
          if (saved.fingerprint !== fingerprint) throw new TicketWorkflowError(409, 'ticket_operation_conflict', 'This operation ID was already used for a different decision.');
          return receipt(saved, key);
        }
        const facts = await tx.loadFacts(ticket);
        const decision = decideTechnicalReadiness(ticket.state, ticket.actor, envelope.operationId, envelope.expectedVersion, facts, 'enabled');
        const manifest = ticketReadyManifest(ticket.state, facts);
        // A later reply can change nextAction after readiness. Never notify the PM
        // again for the same work just because another completion arrived late.
        if (await tx.findRecordedManifest(manifest)) throw new TicketWorkflowError(409, 'technical_readiness_already_recorded', 'Reconcile the existing technical readiness decision.');
        const occurredAt = now().toISOString();
        const result: TicketCommandReceipt = {
          ticketId: decision.state.id, operationId: envelope.operationId,
          version: decision.state.version, status: decision.state.status,
        };
        if (!await tx.saveWorkflow(target, ticket.state.version, decision.state)) {
          throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before making this decision.');
        }
        await tx.appendAudit({ key, envelope, manifest, event: decision.event, occurredAt });
        await tx.enqueueChange({ key, type: 'ticket_changed', version: result.version, occurredAt });
        await tx.insertOperation({ key, fingerprint, manifest, receipt: result });
        return { ...result };
      });
    },

    /** Fresh verified authority still required, but recovery works while writes
     * are disabled and after a later correction/closure advanced the ticket.
     */
    async lookup(target: TicketTarget, subject: TicketExecutionCompletionSubject, operationId: string): Promise<TicketCommandReceipt | null> {
      return store.transaction(async tx => {
        const ticket = await authorize(tx, target, subject);
        if (!opaque.safeParse(operationId).success) throw invalid();
        const key = keyFor(ticket, operationId);
        const saved = await tx.findOperation(key);
        return saved ? receipt(saved, key) : null;
      });
    },
  };
}
