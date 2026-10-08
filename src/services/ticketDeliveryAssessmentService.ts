import { z } from 'zod';

import type { LockedTicket, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketDeliveryAssessmentCandidate, TicketDeliveryAssessmentStore } from '../store/ticketDeliveryAssessmentStore.js';
import type { TicketDeliveryObjectReader, TicketDeliveryReadPolicy } from '../store/ticketDeliveryStore.js';
import { assertTicketDeliveryReadPolicy, verifyTicketDeliveryRegistration } from '../ticketing/deliveryReadModels.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { sameTicketReadyManifest, ticketReadyManifest } from '../ticketing/technicalReadiness.js';
import { decideTicketCommand, TicketWorkflowError } from '../ticketing/workflow.js';
import { authorizeTicketAccess } from './ticketAccess.js';
import { readVerifiedTicketDeliveryContent } from './ticketDeliveryContent.js';

const opaque = z.string().min(1).max(200).refine(value => value.trim() === value);
const pageSchema = z.object({ limit: z.number().int().min(1).max(20).default(10), after: opaque.nullable().default(null) }).strict();
export interface TicketDeliveryCandidateSummary { id: string; scopeVersionId: string; summary: string; fileCount: number }
export interface TicketDeliveryCandidateList { items: TicketDeliveryCandidateSummary[]; nextCursor: string | null }
const missing = () => new TicketWorkflowError(404, 'ticket_delivery_not_found', 'Result candidate not found.');

function assertInspectionStage(ticket: LockedTicket) {
  if (ticket.actor.kind !== 'pm') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only the PM can inspect an unassessed result.');
  if (ticket.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
  if (ticket.state.delivery || ticket.state.status !== 'in_progress' || ticket.state.withdrawalRequested) throw missing();
}
export function verifyTicketDeliveryAssessmentCandidate(ticket: LockedTicket, candidate: TicketDeliveryAssessmentCandidate | null, deliveryId: string, policy: TicketDeliveryReadPolicy) {
  assertInspectionStage(ticket);
  if (!candidate || candidate.snapshot.delivery.id !== deliveryId) throw missing();
  const ready = ticketReadyManifest(ticket.state, candidate.facts);
  const recorded = candidate.readiness;
  if (!recorded || !sameTicketReadyManifest(recorded.manifest, ready)
    || recorded.key.kind !== 'technical_work_ready' || recorded.key.workspaceId !== ticket.state.workspaceId
    || recorded.key.ticketId !== ticket.state.id || recorded.receipt.ticketId !== ticket.state.id
    || recorded.receipt.operationId !== recorded.key.operationId || recorded.receipt.status !== 'in_progress'
    || !Number.isSafeInteger(recorded.receipt.version) || recorded.receipt.version < 1 || recorded.receipt.version > ticket.state.version) throw new TicketReadInvariantError();
  const snapshot = verifyTicketDeliveryRegistration(candidate.snapshot, ready, policy);
  // Pure preflight with the actual verified PM actor: no state is saved and no
  // assessment is fabricated to obtain access. The command rechecks on write.
  decideTicketCommand(ticket.state, ticket.actor, { schemaVersion: 1, operationId: 'inspect_delivery_candidate', expectedVersion: ticket.state.version,
    command: { type: 'assess_delivery', deliveryId } }, { ...candidate.facts, delivery: {
      id: snapshot.delivery.id, scopeVersionId: snapshot.delivery.scopeVersionId, pinnedAssetId: snapshot.delivery.pinnedAssetId,
      immutable: true, issueRevisionIds: snapshot.delivery.issueRevisionIds,
    } }, ticket.mode ?? 'disabled');
  return { snapshot, manifest: { deliveryId, scopeVersionId: snapshot.delivery.scopeVersionId,
    files: snapshot.manifest.files.map(file => ({ id: file.id, filename: file.filename, mediaType: file.mediaType, byteLength: file.byteLength, sha256: file.sha256 })) } };
}

/** PM-only pre-assessment inspection. No candidate is available to the client
 * read service; its existing current/shared pointer checks remain unchanged.
 */
export function createTicketDeliveryAssessmentService(store: TicketDeliveryAssessmentStore, objects: TicketDeliveryObjectReader, suppliedPolicy: TicketDeliveryReadPolicy) {
  assertTicketDeliveryReadPolicy(suppliedPolicy);
  const policy = { ...suppliedPolicy };
  async function inspect(target: TicketTarget, subject: TicketSubject, deliveryId: string) {
    return store.transaction(async tx => {
      const ticket = await authorizeTicketAccess(tx, target, subject);
      assertInspectionStage(ticket);
      if (!opaque.safeParse(deliveryId).success) throw missing();
      return verifyTicketDeliveryAssessmentCandidate(ticket, await tx.loadCandidate(ticket, deliveryId), deliveryId, policy);
    });
  }
  return {
    async list(target: TicketTarget, subject: TicketSubject, input: unknown = {}): Promise<TicketDeliveryCandidateList> {
      return store.transaction(async tx => {
        const ticket = await authorizeTicketAccess(tx, target, subject);
        assertInspectionStage(ticket);
        const parsed = pageSchema.safeParse(input);
        if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_command', 'This ticket page is invalid.');
        const rows = await tx.loadCandidates(ticket, parsed.data);
        if (!Array.isArray(rows) || rows.length > parsed.data.limit + 1) throw new TicketReadInvariantError();
        let previous = parsed.data.after;
        const items = rows.map(row => {
          const id = row.snapshot.delivery.id;
          if (!opaque.safeParse(id).success || (previous !== null && id <= previous)) throw new TicketReadInvariantError();
          previous = id;
          const value = verifyTicketDeliveryAssessmentCandidate(ticket, row, id, policy);
          return { id, scopeVersionId: value.manifest.scopeVersionId, summary: value.snapshot.delivery.publicSummary, fileCount: value.manifest.files.length };
        });
        return { items: items.slice(0, parsed.data.limit), nextCursor: items.length > parsed.data.limit ? items[parsed.data.limit - 1].id : null };
      });
    },
    async manifest(target: TicketTarget, subject: TicketSubject, deliveryId: string) { return (await inspect(target, subject, deliveryId)).manifest; },
    async content(target: TicketTarget, subject: TicketSubject, deliveryId: string, fileId: string) {
      const initial = await inspect(target, subject, deliveryId);
      return readVerifiedTicketDeliveryContent(target, fileId, initial, () => inspect(target, subject, deliveryId), objects, policy);
    },
  };
}
