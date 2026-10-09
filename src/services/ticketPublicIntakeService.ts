import { createHmac, randomUUID } from 'node:crypto';
import { isTransactionOutcomeUnknown } from '../store/transactionOutcome.js';

import type { PublishedTicketIntakeEntry, PublicTicketIntakeGuard, TicketPublicIntakeStore } from '../store/ticketPublicIntakeStore.js';
import { parsePublicTicketInquiry } from '../ticketing/intake.js';
import { PublicTicketIntakeError, type PublicTicketInquiryAcknowledgement, type PublicTicketIntakeRequestContext } from '../ticketing/publicIntake.js';
import { newTicketWorkflow, TicketWorkflowError } from '../ticketing/workflow.js';

export interface PublicTicketIntakeSecurity {
  /** Primary first; retain older keys for the operation retention window. Never
   * log these or place them in VITE settings. Missing configuration fails closed.
   */
  fingerprintKeys: readonly { id: string; secret: Uint8Array }[];
  maxProofAgeMs: number;
}
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim().length > 0 && value.trim() === value;
function checkEntry(entry: PublishedTicketIntakeEntry | null, slug: string): asserts entry is PublishedTicketIntakeEntry {
  if (!entry || entry.slug !== slug || entry.published !== true || !opaque(entry.id) || !opaque(entry.workspaceId) || !opaque(entry.companyLabel)) throw new PublicTicketIntakeError('entry_unavailable');
  if (entry.mode !== 'enabled') throw new PublicTicketIntakeError('writes_disabled');
  const policy = entry.policy;
  if (!policy || !opaque(policy.version) || !Number.isSafeInteger(policy.perSourceMax) || policy.perSourceMax <= 0 || policy.perSourceMax > 10000
    || !Number.isSafeInteger(policy.perEntryMax) || policy.perEntryMax <= 0 || policy.perEntryMax > 1000000
    || !Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds <= 0 || policy.windowSeconds > 86400) throw new PublicTicketIntakeError('unavailable');
}
export function createTicketPublicIntakeService(
  store: TicketPublicIntakeStore, guard: PublicTicketIntakeGuard,
  security: PublicTicketIntakeSecurity, now: () => Date = () => new Date(), nextId: () => string = randomUUID,
) {
  // Snapshot key material, do not allow later caller mutation to rewrite hashes.
  let keys: { id: string; secret: Uint8Array }[] = [];
  try {
    if (Array.isArray(security?.fingerprintKeys)) keys = security.fingerprintKeys.map(key => {
      if (!(key.secret instanceof Uint8Array)) throw new Error('Invalid configuration.');
      return { id: key.id, secret: new Uint8Array(key.secret) };
    });
  } catch { keys = []; }
  const maxAge = security?.maxProofAgeMs;
  const configured = keys.length > 0 && new Set(keys.map(key => key.id)).size === keys.length
    && keys.every(key => opaque(key.id) && key.secret.byteLength >= 32 && key.secret.byteLength <= 1024)
    && Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= 3600000;
  async function submit(slug: string, proofToken: string, input: unknown, request: PublicTicketIntakeRequestContext): Promise<PublicTicketInquiryAcknowledgement> {
      if (!configured) throw new PublicTicketIntakeError('unavailable');
      if (!opaque(slug)) throw new PublicTicketIntakeError('entry_unavailable');
      const entry = await store.loadPublishedEntry(slug); checkEntry(entry, slug);
      if (typeof proofToken !== 'string' || !proofToken.length || proofToken.length > 2048
        || proofToken.trim() !== proofToken) throw new PublicTicketIntakeError('not_verified');
      if (!request || typeof request.origin !== 'string' || request.origin.length < 1 || request.origin.length > 2048
        || typeof request.remoteAddress !== 'string' || request.remoteAddress.length < 1 || request.remoteAddress.length > 256
        || request.origin.trim() !== request.origin || request.remoteAddress.trim() !== request.remoteAddress) {
        throw new PublicTicketIntakeError('not_verified');
      }
      let proof;
      try { proof = await guard.resolveVerifiedRequest(proofToken, entry, request); }
      catch { throw new PublicTicketIntakeError('unavailable'); }
      const instant = now(); const time = instant.getTime();
      if (!Number.isFinite(time)) throw new PublicTicketIntakeError('unavailable');
      const occurredAt = instant.toISOString();
      if (!proof || proof.verificationId !== proofToken || proof.entryId !== entry.id
        || !/^[a-f0-9]{64}$/.test(proof.rateSubjectKey)
        || typeof proof.issuedAt !== 'string' || proof.issuedAt.length > 200
        || typeof proof.expiresAt !== 'string' || proof.expiresAt.length > 200
        || !Number.isFinite(Date.parse(proof.issuedAt)) || !Number.isFinite(Date.parse(proof.expiresAt))
        || Date.parse(proof.issuedAt) > time || time - Date.parse(proof.issuedAt) > maxAge
        || Date.parse(proof.expiresAt) <= time || Date.parse(proof.expiresAt) - Date.parse(proof.issuedAt) > maxAge) throw new PublicTicketIntakeError('not_verified');
      // Independently committed budget: invalid bodies/failed writes still count.
      const attempt = await store.consumeIntakeAttempt(entry, proof, occurredAt);
      if (typeof attempt?.allowed !== 'boolean') throw new PublicTicketIntakeError('unavailable');
      if (attempt.allowed === false) {
        if (!Number.isSafeInteger(attempt.retryAfterSeconds) || attempt.retryAfterSeconds <= 0 || attempt.retryAfterSeconds > 86400) throw new PublicTicketIntakeError('unavailable');
        throw new PublicTicketIntakeError('rate_limited', attempt.retryAfterSeconds);
      }
      const parsed = parsePublicTicketInquiry(input);
      return store.transaction(async tx => {
        const current = await tx.lockPublishedEntry(slug); checkEntry(current, slug);
        if (current.id !== entry.id || current.workspaceId !== entry.workspaceId || current.policy.version !== entry.policy.version
          || current.policy.perSourceMax !== entry.policy.perSourceMax || current.policy.perEntryMax !== entry.policy.perEntryMax
          || current.policy.windowSeconds !== entry.policy.windowSeconds) throw new PublicTicketIntakeError('unavailable');
        const writeTime = now().getTime();
        if (!Number.isFinite(writeTime)) throw new PublicTicketIntakeError('unavailable');
        if (Date.parse(proof.issuedAt) > writeTime || Date.parse(proof.expiresAt) <= writeTime || writeTime - Date.parse(proof.issuedAt) > maxAge) throw new PublicTicketIntakeError('not_verified');
        const writeAt = new Date(writeTime).toISOString();
        const key = { workspaceId: current.workspaceId, entryId: current.id, operationId: parsed.operationId };
        const saved = await tx.lockInquiryOperation(key);
        const fingerprint = (secret: Uint8Array) => createHmac('sha256', secret).update(JSON.stringify({ entryId: current.id, input: parsed })).digest('hex');
        if (saved) {
          if (saved.key.workspaceId !== key.workspaceId || saved.key.entryId !== key.entryId || saved.key.operationId !== key.operationId
            || saved.target.workspaceId !== key.workspaceId || !opaque(saved.target.ticketId)
            || !/^[a-f0-9]{64}$/.test(saved.fingerprint)) throw new PublicTicketIntakeError('unavailable');
          const retained = keys.find(candidate => candidate.id === saved.fingerprintKeyId);
          if (!retained) throw new PublicTicketIntakeError('unavailable');
          if (saved.fingerprint !== fingerprint(retained.secret)) throw new PublicTicketIntakeError('operation_conflict');
          return { received: true };
        }
        const ticketId = nextId(); const reference = await tx.allocateReference(current);
        if (!opaque(ticketId) || !opaque(reference)) throw new PublicTicketIntakeError('unavailable');
        const target = { workspaceId: current.workspaceId, ticketId };
        await tx.insertInquiry({
          state: newTicketWorkflow(ticketId, current.workspaceId),
          header: {
            ...target, reference, title: parsed.title, description: parsed.description, clientSafeCompanyLabel: current.companyLabel,
            createdAt: writeAt, clientUpdatedAt: writeAt, internalUpdatedAt: writeAt,
            closedAt: null, relatedTicketId: null, sharedProject: null,
          },
          request: {
            ...target, entryId: current.id, source: 'public_inquiry', projectPreference: { kind: 'not_sure' },
            preferredProjectId: null, requestedProjectLabel: null, requestedDeadline: parsed.requestedDeadline,
            contact: { fullName: parsed.fullName, email: parsed.email, company: parsed.company },
          },
        });
        const audit = { target, entryId: current.id, operationId: parsed.operationId, type: 'inquiry_received' as const, occurredAt: writeAt };
        await tx.appendInquiryAudit(audit); await tx.enqueueInquiryReceived(audit);
        await tx.insertInquiryOperation({ key, target, fingerprint: fingerprint(keys[0].secret), fingerprintKeyId: keys[0].id });
        // No reference, ticket ID, email/account lookup, grant or session here.
        return { received: true };
      });
  }
  return {
    async submit(slug: string, proofToken: string, input: unknown, request: PublicTicketIntakeRequestContext): Promise<PublicTicketInquiryAcknowledgement> {
      try { return await submit(slug, proofToken, input, request); }
      catch (error) {
        if (error instanceof PublicTicketIntakeError) throw error;
        if (error instanceof TicketWorkflowError && error.code === 'invalid_ticket_intake') throw new TicketWorkflowError(400, 'invalid_ticket_intake', 'This ticket request is invalid.');
        if (isTransactionOutcomeUnknown(error)) throw new PublicTicketIntakeError('outcome_unknown');
        // No cause/payload is attached: public adapters must not reach the
        // generic API handler's driver/body logging and raw error messages.
        throw new PublicTicketIntakeError('unavailable');
      }
    },
  };
}
