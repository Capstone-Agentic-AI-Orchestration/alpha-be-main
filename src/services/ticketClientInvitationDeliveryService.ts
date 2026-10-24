import { createHash, timingSafeEqual } from 'node:crypto';

import type { TicketInvitationSecretContext, TicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';
import type { TicketClientEmailLinkSecretProtector } from '../ticketing/clientEmailLinkSecret.js';
import type { TicketClientIdentityProvider } from './ticketClientIdentityProvider.js';
import type { TicketInvitationContentEmailProvider } from './ticketInvitationEmailProvider.js';
import { TicketInvitationEmailError } from './ticketInvitationEmailProvider.js';
import type { ClientInvitationFailureCode, TicketClientInvitationClaim,
  TicketClientInvitationDeliveryStore } from '../store/ticketClientInvitationDeliveryStore.js';

export const CLIENT_INVITATION_MAX_ATTEMPTS = 5;

export interface TicketClientInvitationDeliveryPolicy {
  webOrigin: string;
  leaseDurationMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxAttempts: number;
}

export interface TicketClientInvitationDeliveryService {
  deliverNext(): Promise<'idle' | 'delivered' | 'retry_scheduled' | 'dead_lettered' | 'outcome_unknown'>;
}

function normalizedWebOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length > 2048) throw new Error('Client email is unavailable.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Client email is unavailable.');
  }
  return url.origin;
}

function tokenMatches(token: string, secretHash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(secretHash)) return false;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) return false;
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(secretHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function context(claim: TicketClientInvitationClaim): TicketInvitationSecretContext {
  return {
    workspaceId: claim.invitation.workspaceId,
    ticketId: claim.invitation.ticketId,
    invitationId: claim.invitation.id,
    expiresAt: claim.invitation.expiresAt,
  };
}

function link(origin: string, invitationToken: string, providerTokenHash: string, type: 'invite' | 'magiclink'): string {
  const url = new URL('/', origin);
  url.hash = `/client/activate?${new URLSearchParams({ token: invitationToken,
    providerTokenHash, providerTokenType: type }).toString()}`;
  return url.toString();
}

/** A readable deadline for the client, e.g. "Tuesday 27 October 2026 at 09:12 UTC". */
export function invitationExpiryText(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return 'soon';
  return `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
}

function retryDelay(attempt: number, policy: TicketClientInvitationDeliveryPolicy): number {
  return Math.min(policy.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1), policy.retryMaxDelayMs);
}

/** Sends only a verified-email activation link; network calls stay outside DB transactions. */
export function createTicketClientInvitationDeliveryService(
  store: TicketClientInvitationDeliveryStore,
  identityProvider: TicketClientIdentityProvider,
  emailProvider: TicketInvitationContentEmailProvider,
  invitationSecretProtector: TicketInvitationSecretProtector,
  providerLinkProtector: TicketClientEmailLinkSecretProtector,
  policy: TicketClientInvitationDeliveryPolicy,
  now: () => Date = () => new Date(),
): TicketClientInvitationDeliveryService {
  const origin = normalizedWebOrigin(policy?.webOrigin);
  if (!Number.isSafeInteger(policy.leaseDurationMs) || policy.leaseDurationMs < 1000 || policy.leaseDurationMs > 15 * 60_000
    || !Number.isSafeInteger(policy.retryBaseDelayMs) || policy.retryBaseDelayMs < 1000
    || !Number.isSafeInteger(policy.retryMaxDelayMs) || policy.retryMaxDelayMs < policy.retryBaseDelayMs
    || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > CLIENT_INVITATION_MAX_ATTEMPTS
    || typeof emailProvider.sendContent !== 'function') throw new Error('Client email delivery is not configured.');
  const providerIdentity = createHash('sha256').update(JSON.stringify([
    'ticket-client-activation-email-v1', emailProvider.identity,
  ])).digest('hex');

  async function fail(claim: TicketClientInvitationClaim, at: string, code: ClientInvitationFailureCode) {
    if (claim.attempt >= policy.maxAttempts) {
      const dead = await store.deadLetter(claim, at, code);
      return dead ? 'dead_lettered' as const : 'outcome_unknown' as const;
    }
    const retryAt = new Date(Date.parse(at) + retryDelay(claim.attempt, policy)).toISOString();
    const scheduled = await store.scheduleRetry(claim, retryAt, code);
    return scheduled ? 'retry_scheduled' as const : 'outcome_unknown' as const;
  }

  return {
    async deliverNext(): Promise<'idle' | 'delivered' | 'retry_scheduled' | 'dead_lettered' | 'outcome_unknown'> {
      const instant = now();
      if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) return 'outcome_unknown';
      const claimedAt = instant.toISOString();
      const claim = await store.claimNext({ now: claimedAt,
        leaseUntil: new Date(instant.getTime() + policy.leaseDurationMs).toISOString(), providerIdentity });
      if (!claim) return 'idle';
      if (!claim.identityMatches) {
        const dead = await store.deadLetter(claim, claimedAt, 'provider_failure');
        return dead ? 'dead_lettered' : 'outcome_unknown';
      }

      const inactive = claim.invitation.status !== 'pending'
        || Date.parse(claim.invitation.expiresAt) <= instant.getTime()
        ? 'expired'
        : claim.ticket.status !== 'under_review' || claim.ticket.source !== 'public_inquiry'
          || claim.ticket.clientId !== null || claim.ticket.scopeVersionId !== null
          || claim.ticket.agreedScopeVersionId !== null || claim.ticket.authorizedScopeVersionId !== null
          || claim.ticket.requiredIssueIds.length !== 0
          ? 'ticket_ineligible'
          : claim.contact.bindingId !== claim.invitation.contactBindingId
            || claim.contact.source !== 'public_inquiry' || claim.contact.emailVerified !== false
            ? 'contact_changed' : null;
      if (inactive) {
        const changed = await store.discard(claim, claimedAt, inactive);
        return changed ? 'dead_lettered' : 'outcome_unknown';
      }
      const recipient = claim.contact.email?.trim().toLowerCase() ?? '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient.length > 254) {
        const changed = await store.discard(claim, claimedAt, 'contact_changed');
        return changed ? 'dead_lettered' : 'outcome_unknown';
      }

      let invitationToken: string;
      try {
        invitationToken = invitationSecretProtector.unprotect(claim.signal.protectedToken, context(claim));
      } catch { return fail(claim, claimedAt, 'secret_unavailable'); }
      if (!tokenMatches(invitationToken, claim.invitation.secretHash)) {
        const changed = await store.deadLetter(claim, claimedAt, 'secret_integrity_failure');
        return changed ? 'dead_lettered' : 'outcome_unknown';
      }

      let providerEnvelope = claim.invitation.providerLinkEnvelope;
      let providerType = claim.invitation.providerLinkType;
      if (!providerEnvelope || !providerType) {
        try {
          const generated = await identityProvider.generateEmailLink(recipient, 'invite');
          providerEnvelope = providerLinkProtector.protect(generated.tokenHash, context(claim));
          providerType = generated.type;
          const saved = await store.cacheProviderLink(claim, providerEnvelope, providerType);
          if (!saved) return 'outcome_unknown';
          providerEnvelope = saved.envelope;
          providerType = saved.type;
        } catch { return fail(claim, claimedAt, 'provider_failure'); }
      }

      let providerTokenHash: string;
      try { providerTokenHash = providerLinkProtector.unprotect(providerEnvelope, context(claim)); }
      catch { return fail(claim, claimedAt, 'secret_unavailable'); }
      const activationLink = link(origin, invitationToken, providerTokenHash, providerType);
      const body = [
        'Your inquiry has been reviewed by Alpha’s project manager.',
        'Use this secure, one-time link to verify your email and activate access to the ticket for this inquiry:',
        activationLink,
        `This invitation is valid until ${invitationExpiryText(claim.invitation.expiresAt)}. If it has expired, ask your project manager to send you a new one.`,
        'Your account will not provide access to Alpha’s desktop app, other client tickets, projects, or internal developer work.',
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n\n');
      try {
        await emailProvider.sendContent(recipient, 'Activate your Alpha client access', body,
          `ticket-client-activation:${claim.invitation.workspaceId}:${claim.invitation.id}`);
      } catch (error) {
        if (error instanceof TicketInvitationEmailError && !error.retryable) {
          const dead = await store.deadLetter(claim, claimedAt, 'provider_failure');
          return dead ? 'dead_lettered' : 'outcome_unknown';
        }
        return fail(claim, claimedAt, 'provider_failure');
      }

      const sent = now();
      if (!(sent instanceof Date) || !Number.isFinite(sent.getTime())) return 'outcome_unknown';
      return await store.markDelivered(claim, sent.toISOString()) ? 'delivered' : 'outcome_unknown';
    },
  };
}
