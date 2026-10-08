import { createHash, timingSafeEqual } from 'node:crypto';

import type {
  TicketInvitationDeliveryClaim, TicketInvitationDeliveryFailureCode,
  TicketInvitationDeliverySkipReason, TicketInvitationDeliveryStore,
} from '../store/ticketInvitationDeliveryStore.js';
import type { TicketInvitationSecretContext, TicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;

export interface TicketInvitationEmailProvider {
  /**
   * Send plain text only. The stable idempotency key is reused for retries;
   * delivery remains at-least-once, so identical duplicate email is possible.
   * Do not log the recipient, token, activation URL or body.
   */
  send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<void>;
}

export interface TicketInvitationDeliveryPolicy {
  /** Exact public Alpha web origin, not a caller-provided URL. */
  webOrigin: string;
  leaseDurationMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export type TicketInvitationDeliveryResult =
  | { kind: 'idle' }
  | { kind: 'delivered' }
  | { kind: 'suppressed'; reason: TicketInvitationDeliverySkipReason }
  | { kind: 'retry_scheduled'; retryAt: string }
  | { kind: 'dead_lettered' }
  | { kind: 'outcome_unknown' };

export class TicketInvitationDeliveryInvariantError extends Error {
  constructor() {
    super('The invitation delivery record is unavailable.');
    this.name = 'TicketInvitationDeliveryInvariantError';
  }
}

function normalizeWebOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) {
    throw new Error('Invitation delivery configuration is invalid.');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invitation delivery configuration is invalid.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invitation delivery configuration is invalid.');
  }
  return url.origin;
}

function validPolicy(policy: TicketInvitationDeliveryPolicy): boolean {
  return Number.isSafeInteger(policy.leaseDurationMs) && policy.leaseDurationMs >= 1000 && policy.leaseDurationMs <= 15 * 60_000
    && Number.isSafeInteger(policy.maxAttempts) && policy.maxAttempts >= 1 && policy.maxAttempts <= 12
    && Number.isSafeInteger(policy.retryBaseDelayMs) && policy.retryBaseDelayMs >= 1000
    && Number.isSafeInteger(policy.retryMaxDelayMs) && policy.retryMaxDelayMs >= policy.retryBaseDelayMs
    && policy.retryMaxDelayMs <= 24 * 60 * 60_000;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function canonicalEmail(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function validateClaimIdentity(claim: TicketInvitationDeliveryClaim): void {
  const { signal, invitation, ticket, contact } = claim;
  if (!opaque(claim.eventId) || !opaque(claim.leaseToken) || !Number.isSafeInteger(claim.attempt) || claim.attempt < 1
    || signal?.type !== 'ticket_invitation_requested' || !opaque(signal.target?.workspaceId)
    || !opaque(signal.target?.ticketId) || !opaque(signal.invitationId) || !opaque(signal.protectedToken)
    || signal.protectedToken.length > 512 || !validDate(signal.occurredAt)
    || !opaque(invitation?.id) || !opaque(invitation.workspaceId) || !opaque(invitation.ticketId)
    || invitation.workspaceId !== signal.target.workspaceId || invitation.ticketId !== signal.target.ticketId
    || invitation.id !== signal.invitationId || ticket?.workspaceId !== invitation.workspaceId || ticket.id !== invitation.ticketId
    || !['pending', 'expired', 'revoked', 'consumed'].includes(invitation.status)
    || !opaque(invitation.contactBindingId)
    || !opaque(contact?.bindingId) || typeof contact.source !== 'string' || typeof contact.emailVerified !== 'boolean'
    || !Array.isArray(ticket.requiredIssueIds) || !ticket.requiredIssueIds.every(opaque)
    || new Set(ticket.requiredIssueIds).size !== ticket.requiredIssueIds.length
    || !/^[a-f0-9]{64}$/.test(invitation.secretHash) || !validDate(invitation.createdAt) || !validDate(invitation.expiresAt)
    || Date.parse(invitation.expiresAt) <= Date.parse(invitation.createdAt)) {
    throw new TicketInvitationDeliveryInvariantError();
  }
}

function ineligibleReason(claim: TicketInvitationDeliveryClaim, nowMs: number): TicketInvitationDeliverySkipReason | null {
  const { invitation, ticket, contact } = claim;
  if (invitation.status !== 'pending') return 'invitation_inactive';
  if (Date.parse(invitation.expiresAt) <= nowMs) return 'expired';
  if (ticket.status !== 'under_review' || ticket.clientId !== null || ticket.scopeVersionId !== null
    || ticket.agreedScopeVersionId !== null || ticket.authorizedScopeVersionId !== null
    || ticket.projectId !== null || ticket.requiredIssueIds.length !== 0) return 'ticket_ineligible';
  if (contact.source !== 'public_inquiry' || contact.bindingId !== invitation.contactBindingId
    || !canonicalEmail(contact.email)) return 'contact_changed';
  return null;
}

function invitationContext(claim: TicketInvitationDeliveryClaim): TicketInvitationSecretContext {
  return {
    workspaceId: claim.invitation.workspaceId,
    ticketId: claim.invitation.ticketId,
    invitationId: claim.invitation.id,
    expiresAt: claim.invitation.expiresAt,
  };
}

function verifyTokenMatchesInvitation(token: string, secretHash: string): boolean {
  if (!tokenPattern.test(token) || !/^[a-f0-9]{64}$/.test(secretHash)) return false;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== token) return false;
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(secretHash, 'hex');
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
}

function buildActivationLink(origin: string, token: string): string {
  const link = new URL('/', origin);
  // The fragment keeps the one-time token out of HTTP request paths and referrers.
  link.hash = `/client/activate?token=${encodeURIComponent(token)}`;
  return link.toString();
}

function retryDelay(attempt: number, policy: TicketInvitationDeliveryPolicy): number {
  return Math.min(policy.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)), policy.retryMaxDelayMs);
}

/** Provider-neutral at-least-once invitation delivery; never called inside a DB transaction. */
export function createTicketInvitationDeliveryService(
  store: TicketInvitationDeliveryStore,
  provider: TicketInvitationEmailProvider,
  secretProtector: TicketInvitationSecretProtector,
  policy: TicketInvitationDeliveryPolicy,
  now: () => Date = () => new Date(),
) {
  const origin = normalizeWebOrigin(policy?.webOrigin);
  if (!validPolicy(policy) || typeof store?.claimNext !== 'function' || typeof provider?.send !== 'function'
    || typeof secretProtector?.unprotect !== 'function') {
    throw new Error('Invitation delivery configuration is invalid.');
  }

  async function failOrRetry(
    claim: TicketInvitationDeliveryClaim,
    occurredAt: string,
    code: TicketInvitationDeliveryFailureCode,
  ): Promise<TicketInvitationDeliveryResult> {
    if (claim.attempt >= policy.maxAttempts) {
      const changed = await store.deadLetter(claim, occurredAt, code);
      return changed ? { kind: 'dead_lettered' } : { kind: 'outcome_unknown' };
    }
    const retryAt = new Date(Date.parse(occurredAt) + retryDelay(claim.attempt, policy)).toISOString();
    const changed = await store.scheduleRetry(claim, retryAt, code);
    return changed ? { kind: 'retry_scheduled', retryAt } : { kind: 'outcome_unknown' };
  }

  return {
    async deliverNext(): Promise<TicketInvitationDeliveryResult> {
      const instant = now();
      const nowMs = instant instanceof Date ? instant.getTime() : Number.NaN;
      if (!Number.isFinite(nowMs)) throw new TicketInvitationDeliveryInvariantError();
      const claimedAt = new Date(nowMs).toISOString();
      const claim = await store.claimNext({
        now: claimedAt,
        leaseUntil: new Date(nowMs + policy.leaseDurationMs).toISOString(),
      });
      if (!claim) return { kind: 'idle' };

      validateClaimIdentity(claim);
      if (claim.attempt > policy.maxAttempts) {
        const changed = await store.deadLetter(claim, claimedAt, 'attempt_limit_reached');
        return changed ? { kind: 'dead_lettered' } : { kind: 'outcome_unknown' };
      }

      const suppressed = ineligibleReason(claim, nowMs);
      if (suppressed) {
        const changed = await store.discard(claim, claimedAt, suppressed);
        return changed ? { kind: 'suppressed', reason: suppressed } : { kind: 'outcome_unknown' };
      }

      let token: string;
      try {
        token = secretProtector.unprotect(claim.signal.protectedToken, invitationContext(claim));
      } catch {
        return failOrRetry(claim, claimedAt, 'secret_unavailable');
      }
      if (!verifyTokenMatchesInvitation(token, claim.invitation.secretHash)) {
        const changed = await store.deadLetter(claim, claimedAt, 'secret_integrity_failure');
        return changed ? { kind: 'dead_lettered' } : { kind: 'outcome_unknown' };
      }

      const recipient = canonicalEmail(claim.contact.email);
      if (!recipient) {
        const changed = await store.discard(claim, claimedAt, 'contact_changed');
        return changed ? { kind: 'suppressed', reason: 'contact_changed' } : { kind: 'outcome_unknown' };
      }
      const activationLink = buildActivationLink(origin, token);
      const text = [
        'You have been invited to Alpha’s client portal.',
        'Use this secure link to activate your client access:',
        activationLink,
        `This invitation expires at ${claim.invitation.expiresAt}.`,
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n\n');

      try {
        await provider.send({
          to: recipient,
          subject: 'Your Alpha client portal invitation',
          text,
          idempotencyKey: `ticket-invitation:${claim.invitation.workspaceId}:${claim.invitation.id}`,
        });
      } catch {
        return failOrRetry(claim, claimedAt, 'provider_failure');
      }

      const sentAt = now();
      const sentMs = sentAt instanceof Date ? sentAt.getTime() : Number.NaN;
      if (!Number.isFinite(sentMs)) return { kind: 'outcome_unknown' };
      const recorded = await store.markDelivered(claim, new Date(sentMs).toISOString());
      return recorded ? { kind: 'delivered' } : { kind: 'outcome_unknown' };
    },
  };
}
