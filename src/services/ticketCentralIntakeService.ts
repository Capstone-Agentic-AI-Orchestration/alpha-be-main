import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isTransactionOutcomeUnknown } from '../store/transactionOutcome.js';
import type { PublicTicketIntakeGuard } from '../store/ticketPublicIntakeStore.js';
import type { CentralIntakeCursor, CentralIntakeFingerprint, CentralIntakeRatePolicy, TicketCentralIntakeStore } from '../store/ticketCentralIntakeStore.js';
import { parsePublicTicketInquiry, type PublicTicketInquiryInput } from '../ticketing/intake.js';
import { PublicTicketIntakeError, type PublicTicketIntakeRequestContext } from '../ticketing/publicIntake.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;
const operationSchema = z.string().uuid();
const cursorSchema = z.object({ submittedAt: z.string().datetime(), id: z.string().min(1).max(200) }).strict();
const ratePolicy: CentralIntakeRatePolicy = { perSourceMax: 8, perOrganizationMax: 500, windowSeconds: 3600 };

function parseCursor(value: unknown): CentralIntakeCursor | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024) throw new TicketWorkflowError(400, 'central_intake_page_invalid', 'The inquiry page is invalid.');
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (!parsed.success || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error();
    return parsed.data;
  } catch { throw new TicketWorkflowError(400, 'central_intake_page_invalid', 'The inquiry page is invalid.'); }
}

function encodeCursor(cursor: CentralIntakeCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function createTicketCentralIntakeService(input: {
  store: TicketCentralIntakeStore; guard: PublicTicketIntakeGuard; organizationKey: string;
  fingerprintKeys: readonly { id: string; secret: Uint8Array }[]; maxRequestAgeMs: number;
  now?: () => Date; nextId?: () => string;
}) {
  let keys: { id: string; secret: Uint8Array }[] = [];
  try {
    if (Array.isArray(input.fingerprintKeys)) keys = input.fingerprintKeys.map(key => {
      if (!(key.secret instanceof Uint8Array)) throw new Error();
      return { id: key.id, secret: new Uint8Array(key.secret) };
    });
  } catch { keys = []; }
  const configured = opaque(input.organizationKey) && keys.length > 0
    && new Set(keys.map(key => key.id)).size === keys.length
    && keys.every(key => opaque(key.id) && key.secret.byteLength >= 32 && key.secret.byteLength <= 1024)
    && Number.isSafeInteger(input.maxRequestAgeMs) && input.maxRequestAgeMs > 0 && input.maxRequestAgeMs <= 3600000;
  const now = input.now ?? (() => new Date());
  const nextId = input.nextId ?? randomUUID;

  return {
    async submit(raw: unknown, request: PublicTicketIntakeRequestContext): Promise<{ received: true; publicReference: string }> {
      if (!configured) throw new PublicTicketIntakeError('unavailable');
      if (!request || typeof request.origin !== 'string' || typeof request.remoteAddress !== 'string'
        || request.origin.length < 1 || request.origin.length > 2048 || request.remoteAddress.length < 1
        || request.remoteAddress.length > 256 || request.origin.trim() !== request.origin
        || request.remoteAddress.trim() !== request.remoteAddress) throw new PublicTicketIntakeError('not_verified');

      const occurred = now(); const occurredAt = occurred.toISOString();
      if (!Number.isFinite(occurred.getTime())) throw new PublicTicketIntakeError('unavailable');
      const admission = await input.guard.admitRequest({ id: input.organizationKey }, request);
      if (!admission || admission.entryId !== input.organizationKey || !/^[a-f0-9]{64}$/.test(admission.rateSubjectKey)
        || !Number.isFinite(Date.parse(admission.issuedAt)) || !Number.isFinite(Date.parse(admission.expiresAt))
        || Date.parse(admission.issuedAt) > occurred.getTime()
        || occurred.getTime() - Date.parse(admission.issuedAt) > input.maxRequestAgeMs
        || Date.parse(admission.expiresAt) <= occurred.getTime()
        || Date.parse(admission.expiresAt) - Date.parse(admission.issuedAt) > input.maxRequestAgeMs) {
        throw new PublicTicketIntakeError('not_verified');
      }
      const budget = await input.store.consumeAttempt(input.organizationKey, admission.rateSubjectKey, occurredAt, ratePolicy);
      if (!budget.allowed) throw new PublicTicketIntakeError('rate_limited', budget.retryAfterSeconds);
      let parsed: PublicTicketInquiryInput;
      try { parsed = parsePublicTicketInquiry(raw); }
      catch { throw new PublicTicketIntakeError('invalid_request'); }
      parsed = { ...parsed, email: parsed.email.toLowerCase() };
      const fingerprints: CentralIntakeFingerprint[] = keys.map(key => ({
        keyId: key.id,
        fingerprint: createHmac('sha256', key.secret).update(JSON.stringify(parsed)).digest('hex'),
      }));
      const id = nextId();
      const publicReference = `INQ-${createHash('sha256').update(`${input.organizationKey}:${id}`).digest('hex').slice(0, 32).toUpperCase()}`;
      const outcome = await input.store.submit(input.organizationKey, id, publicReference, parsed, fingerprints, occurredAt);
      if (outcome.kind === 'conflict') throw new PublicTicketIntakeError('operation_conflict');
      return { received: true, publicReference: outcome.publicReference };
    },

    async listPending(workspaceId: string, subject: TicketSubject, raw: { after?: unknown; limit?: unknown; filter?: unknown; client?: unknown }) {
      if (!configured) throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The shared inquiry inbox is unavailable.');
      if (!opaque(workspaceId) || subject.kind !== 'internal' || !opaque(subject.userId)) {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot view the shared inquiry inbox.');
      }
      const limit = raw.limit === undefined ? 50 : Number(raw.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TicketWorkflowError(400, 'central_intake_page_invalid', 'The inquiry page is invalid.');
      const cursor = parseCursor(raw.after);
      const filter = raw.filter ?? 'pending';
      if (filter !== 'pending' && filter !== 'handled') throw new TicketWorkflowError(400, 'central_intake_page_invalid', 'Choose pending or handled inquiries.');
      // A client account: only that client's project proposals, for their page in Clients.
      if (raw.client !== undefined && !opaque(raw.client)) throw new TicketWorkflowError(400, 'central_intake_page_invalid', 'The inquiry page is invalid.');
      const clientUserId = raw.client === undefined ? null : raw.client as string;
      const page = await input.store.listPending(input.organizationKey, workspaceId, subject, cursor, limit, filter, clientUserId);
      if (page === 'forbidden') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot view the shared inquiry inbox.');
      return { items: page.items, nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null };
    },

    async accept(intakeId: string, workspaceId: string, subject: TicketSubject, raw: unknown, discoverySummary?: string) {
      if (!configured) throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The shared inquiry inbox is unavailable.');
      const parsed = z.object({ schemaVersion: z.literal(1), operationId: operationSchema }).strict().safeParse(raw);
      if (!parsed.success || !opaque(intakeId) || !opaque(workspaceId) || subject.kind !== 'internal' || !opaque(subject.userId)) {
        throw new TicketWorkflowError(400, 'central_intake_accept_invalid', 'The inquiry could not be accepted.');
      }
      const instant = now();
      if (!Number.isFinite(instant.getTime())) throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The inquiry could not be accepted right now.');
      const occurredAt = instant.toISOString();
      try {
        const result = await input.store.accept({ organizationKey: input.organizationKey, intakeId, workspaceId,
          subject, operationId: parsed.data.operationId, ticketId: nextId(),
          reference: `TKT-${nextId().replaceAll('-', '').toUpperCase()}`, occurredAt,
          ...(discoverySummary === undefined ? {} : { discoverySummary }) });
        if (result === 'not_found') throw new TicketWorkflowError(404, 'central_intake_not_found', 'This inquiry is no longer available.');
        if (result === 'already_handled') throw new TicketWorkflowError(409, 'central_intake_already_handled', 'Another PM has already handled this inquiry. Refresh the inbox.');
        if (result === 'operation_conflict') throw new TicketWorkflowError(409, 'central_intake_operation_conflict', 'This acceptance already recorded a different discovery summary. Retry with the original summary.');
        if (result === 'invalid_discovery_summary') throw new TicketWorkflowError(400, 'central_intake_accept_invalid', 'Only signed-in project proposals can have a discovery summary.');
        if (result === 'workspace_unavailable') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket creation is unavailable in the selected workspace.');
        if (result === 'client_access_unavailable') throw new TicketWorkflowError(409, 'client_access_unavailable', 'Client access is suspended or unavailable in this workspace.');
        if (result === 'forbidden') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot accept inquiries in this workspace.');
        return result;
      } catch (error) {
        if (error instanceof TicketWorkflowError) throw error;
        if (isTransactionOutcomeUnknown(error)) throw new TicketWorkflowError(503, 'central_intake_outcome_unknown', 'The result is not confirmed. Retry with the same operation ID.');
        throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The inquiry could not be accepted right now.');
      }
    },

    async clarify(intakeId: string, workspaceId: string, subject: TicketSubject, raw: unknown) {
      if (!configured || !input.store.clarify) throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The shared inquiry inbox is unavailable.');
      const parsed = z.object({
        schemaVersion: z.literal(1), operationId: operationSchema,
        body: z.string().trim().min(1).max(4000),
      }).strict().safeParse(raw);
      if (!parsed.success || !opaque(intakeId) || !opaque(workspaceId) || subject.kind !== 'internal' || !opaque(subject.userId)) {
        throw new TicketWorkflowError(400, 'central_intake_clarification_invalid', 'Add a question for the client before sending it.');
      }
      const instant = now();
      if (!Number.isFinite(instant.getTime())) throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The question could not be sent right now.');
      try {
        const result = await input.store.clarify({ organizationKey: input.organizationKey, intakeId, workspaceId,
          subject, operationId: parsed.data.operationId, body: parsed.data.body, occurredAt: instant.toISOString() });
        if (result === 'not_found') throw new TicketWorkflowError(404, 'central_intake_not_found', 'This proposal is no longer available.');
        if (result === 'already_handled') throw new TicketWorkflowError(409, 'central_intake_already_handled', 'This proposal is no longer waiting for PM review. Refresh the inbox.');
        if (result === 'operation_conflict') throw new TicketWorkflowError(409, 'central_intake_operation_conflict', 'This question could not be retried with a different message. Refresh the inbox.');
        if (result === 'forbidden') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot message this client from the selected workspace.');
        return result;
      } catch (error) {
        if (error instanceof TicketWorkflowError) throw error;
        if (isTransactionOutcomeUnknown(error)) throw new TicketWorkflowError(503, 'central_intake_outcome_unknown', 'The result is not confirmed. Retry with the same operation ID.');
        throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The question could not be sent right now.');
      }
    },

    async decline(intakeId: string, workspaceId: string, subject: TicketSubject, raw: unknown) {
      if (!configured) throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The shared inquiry inbox is unavailable.');
      const parsed = z.object({
        schemaVersion: z.literal(1), operationId: operationSchema,
        reason: z.string().trim().min(1).max(1000).nullable().optional(),
      }).strict().safeParse(raw);
      if (!parsed.success || !opaque(intakeId) || !opaque(workspaceId) || subject.kind !== 'internal' || !opaque(subject.userId)) {
        throw new TicketWorkflowError(400, 'central_intake_decline_invalid', 'The inquiry could not be declined.');
      }
      const instant = now();
      if (!Number.isFinite(instant.getTime())) throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The inquiry could not be declined right now.');
      try {
        const result = await input.store.decline({ organizationKey: input.organizationKey, intakeId, workspaceId,
          subject, operationId: parsed.data.operationId, reason: parsed.data.reason || null, occurredAt: instant.toISOString() });
        if (result === 'not_found') throw new TicketWorkflowError(404, 'central_intake_not_found', 'This inquiry is no longer available.');
        if (result === 'already_handled') throw new TicketWorkflowError(409, 'central_intake_already_handled', 'Another PM has already handled this inquiry. Refresh the inbox.');
        if (result === 'forbidden') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot decline inquiries from this workspace.');
        return result;
      } catch (error) {
        if (error instanceof TicketWorkflowError) throw error;
        if (isTransactionOutcomeUnknown(error)) throw new TicketWorkflowError(503, 'central_intake_outcome_unknown', 'The result is not confirmed. Retry with the same operation ID.');
        throw new TicketWorkflowError(503, 'central_intake_unavailable', 'The inquiry could not be declined right now.');
      }
    },
  };
}
