import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketDeliveryReadPolicy } from '../store/ticketDeliveryStore.js';
import type {
  LockedTicketArtifacts, SavedTicketDeliveryRegistration, TicketArtifactSubject,
  TicketDeliveryRegistrationKey, TicketDeliveryRegistrationReceipt, TicketDeliveryRegistrationStore,
  TicketDeliveryRegistrationTransaction,
} from '../store/ticketDeliveryRegistrationStore.js';
import { assertTicketDeliveryReadPolicy, verifyTicketDeliveryRegistration } from '../ticketing/deliveryReadModels.js';
import { sameTicketReadyManifest, ticketReadyManifest } from '../ticketing/technicalReadiness.js';
import { assertTicketWritable, TicketWorkflowError } from '../ticketing/workflow.js';

const opaque = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const inputSchema = z.object({ schemaVersion: z.literal(1), operationId: opaque,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  publicSummary: z.string().trim().min(1).max(4000),
}).strict();
const missing = () => new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
async function authorize(tx: TicketDeliveryRegistrationTransaction, target: TicketTarget, subject: TicketArtifactSubject) {
  if (!opaque.safeParse(target?.workspaceId).success || !opaque.safeParse(target?.ticketId).success
    || subject?.kind !== 'verified_delivery_artifacts' || !opaque.safeParse(subject.verificationId).success) throw missing();
  const ticket = await tx.lockAuthorizedArtifacts(target, subject);
  const source = ticket?.source;
  if (!ticket || !source || source.authorized !== true || ticket.state.id !== target.ticketId || ticket.state.workspaceId !== target.workspaceId
    || source.workspaceId !== target.workspaceId || source.ticketId !== target.ticketId
    || ![source.userId, source.runId, source.completionId, source.issueId, source.issueRevisionId, source.bundleId].every(value => opaque.safeParse(value).success)) throw missing();
  return ticket;
}
function keyFor(ticket: LockedTicketArtifacts, operationId: string): TicketDeliveryRegistrationKey {
  return { kind: 'delivery_registration', workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id,
    actorId: ticket.source.userId, runId: ticket.source.runId, completionId: ticket.source.completionId,
    bundleId: ticket.source.bundleId, operationId };
}
function receipt(saved: SavedTicketDeliveryRegistration, key: TicketDeliveryRegistrationKey): TicketDeliveryRegistrationReceipt {
  const value = saved.receipt;
  if (Object.keys(key).some(field => saved.key[field as keyof TicketDeliveryRegistrationKey] !== key[field as keyof TicketDeliveryRegistrationKey])
    || value.ticketId !== key.ticketId || value.operationId !== key.operationId || !opaque.safeParse(value.deliveryId).success
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.status !== 'in_progress') throw new Error('Invalid stored delivery registration outcome.');
  return { ticketId: value.ticketId, operationId: value.operationId, deliveryId: value.deliveryId, version: value.version, status: value.status };
}

/** Registers a protected candidate, NOT a PM assessment or publication. No
 * production adapter, scanner/provider, singleton or HTTP mount is supplied.
 */
export function createTicketDeliveryRegistrationService(
  store: TicketDeliveryRegistrationStore, suppliedPolicy: TicketDeliveryReadPolicy,
  now: () => Date = () => new Date(), nextId: () => string = randomUUID,
) {
  assertTicketDeliveryReadPolicy(suppliedPolicy);
  const policy = { ...suppliedPolicy };
  return {
    async register(target: TicketTarget, subject: TicketArtifactSubject, input: unknown): Promise<TicketDeliveryRegistrationReceipt> {
      return store.transaction(async tx => {
        const ticket = await authorize(tx, target, subject);
        if (ticket.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
        const parsed = inputSchema.safeParse(input);
        if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This ticket command is invalid.');
        const envelope = parsed.data;
        const key = keyFor(ticket, envelope.operationId);
        const fingerprint = createHash('sha256').update(JSON.stringify(['ticket_delivery_registration_v1', key, envelope])).digest('hex');
        const saved = await tx.findOperation(key);
        if (saved) {
          if (saved.fingerprint !== fingerprint) throw new TicketWorkflowError(409, 'ticket_operation_conflict', 'This operation ID was already used for a different decision.');
          return receipt(saved, key);
        }
        assertTicketWritable(ticket.state, envelope.expectedVersion);
        if (ticket.state.delivery) throw new TicketWorkflowError(409, 'delivery_already_assessed', 'Reconcile the current assessed result before preparing another.');
        const evidence = await tx.loadEvidence(ticket);
        const ready = ticketReadyManifest(ticket.state, evidence.facts);
        const committed = evidence.readiness;
        if (!committed || !sameTicketReadyManifest(committed.manifest, ready)
          || committed.key.kind !== 'technical_work_ready' || committed.key.workspaceId !== target.workspaceId
          || committed.key.ticketId !== target.ticketId || committed.receipt.ticketId !== target.ticketId
          || committed.receipt.operationId !== committed.key.operationId || committed.receipt.status !== 'in_progress'
          || !Number.isSafeInteger(committed.receipt.version) || committed.receipt.version < 1 || committed.receipt.version > ticket.state.version
          || !ready.issueRevisions.some(issue => issue.issueId === ticket.source.issueId && issue.revisionId === ticket.source.issueRevisionId)
          || evidence.manifest.id !== ticket.source.bundleId) {
          throw new TicketWorkflowError(409, 'delivery_source_not_current', 'The result must match the complete current reviewed work.');
        }
        if (await tx.findRegisteredBundle(ticket)) throw new TicketWorkflowError(409, 'delivery_already_registered', 'Reconcile the existing delivery registration.');
        const deliveryId = nextId();
        if (!opaque.safeParse(deliveryId).success) throw new Error('The server could not prepare this delivery.');
        const snapshot = verifyTicketDeliveryRegistration({
          delivery: { ...target, id: deliveryId, scopeVersionId: ready.scopeVersionId, pinnedAssetId: ticket.source.bundleId,
            issueRevisionIds: ready.issueRevisions.map(issue => issue.revisionId), immutable: true, clientVisible: true,
            publicSummary: envelope.publicSummary, sharedAt: null }, manifest: evidence.manifest,
        }, ready, policy);
        const occurredAt = now().toISOString();
        if (!await tx.insertDelivery(ticket, ticket.state.version, snapshot, occurredAt)) {
          throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before registering this result.');
        }
        const result: TicketDeliveryRegistrationReceipt = {
          ticketId: target.ticketId, operationId: envelope.operationId, deliveryId, version: ticket.state.version, status: 'in_progress',
        };
        await tx.appendAudit({ key, deliveryId, readyManifest: ready, workflowVersion: ticket.state.version, type: 'delivery_registered', occurredAt });
        await tx.insertOperation({ key, fingerprint, readyManifest: ready, receipt: result });
        return { ...result };
      });
    },
    async lookup(target: TicketTarget, subject: TicketArtifactSubject, operationId: string): Promise<TicketDeliveryRegistrationReceipt | null> {
      return store.transaction(async tx => {
        const ticket = await authorize(tx, target, subject);
        if (!opaque.safeParse(operationId).success) throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This ticket command is invalid.');
        const key = keyFor(ticket, operationId);
        const saved = await tx.findOperation(key);
        return saved ? receipt(saved, key) : null;
      });
    },
  };
}
