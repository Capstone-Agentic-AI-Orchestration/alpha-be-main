import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { TicketClientSessionRecord, TicketClientSessionStore } from '../store/ticketClientSessionStore.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketClientIdentityVerifier } from './ticketClientActivationService.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const credentialSchema = z.string().min(1).max(8192).regex(/^\S+$/);
const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;
const hash = (purpose: 'session' | 'csrf', value: string): string => createHash('sha256')
  .update(`alpha-client-${purpose}-v1\0`, 'utf8').update(value, 'utf8').digest('hex');
const secretToken = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === value;
};
const isoDate = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && value.length <= 40;
function constantTimeHashMatches(candidate: string, expectedHash: string, purpose: 'session' | 'csrf'): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hash(purpose, candidate), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function safeUnavailable(): TicketWorkflowError {
  return new TicketWorkflowError(503, 'client_session_unavailable', 'Client sign-in is unavailable right now. Try again.');
}

export interface TicketClientSessionPolicy { lifetimeMs: number }
export interface TicketClientSessionIssue {
  /** Raw values exist only long enough to set browser cookies; never persist or log them. */
  sessionCookieValue: string;
  csrfCookieValue: string;
  expiresAt: string;
}
export type TicketClientSessionCheck =
  | { kind: 'authenticated'; subject: Extract<TicketSubject, { kind: 'client' }>; expiresAt: string }
  | { kind: 'csrf_invalid' }
  | { kind: 'unauthenticated' };

/**
 * Provider-neutral Alpha client session boundary. It never creates a provider
 * account or client grant; only an already-activated provider identity with an
 * active client-service grant can receive a separate revocable session.
 */
export function createTicketClientSessionService(
  store: TicketClientSessionStore,
  identityVerifier: TicketClientIdentityVerifier,
  policy: TicketClientSessionPolicy,
  now: () => Date = () => new Date(),
) {
  const policyValid = Number.isSafeInteger(policy?.lifetimeMs)
    && policy.lifetimeMs >= 5 * 60 * 1000 && policy.lifetimeMs <= MAX_SESSION_LIFETIME_MS;

  async function exchange(providerCredential: unknown): Promise<TicketClientSessionIssue | null> {
    const parsed = credentialSchema.safeParse(providerCredential);
    if (!policyValid || !parsed.success) return null;
    try {
      const identity = await identityVerifier.verifyCredential(parsed.data);
      if (!identity || !opaque(identity.userId) || identity.emailVerified !== true) return null;

      return await store.transaction(async tx => {
        // No open signup: a previous invitation activation must have established
        // this server-owned client account/service grant first.
        if (!await tx.hasActiveClientServiceGrant(identity.userId)) return null;
        const instant = now();
        if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw safeUnavailable();
        const createdAt = instant.toISOString();
        const expiresAt = new Date(instant.getTime() + policy.lifetimeMs).toISOString();
        if (!isoDate(expiresAt) || Date.parse(expiresAt) <= instant.getTime()) throw safeUnavailable();

        const sessionCookieValue = randomBytes(32).toString('base64url');
        const csrfCookieValue = randomBytes(32).toString('base64url');
        const record: TicketClientSessionRecord = {
          sessionIdHash: hash('session', sessionCookieValue),
          providerUserId: identity.userId,
          csrfHash: hash('csrf', csrfCookieValue),
          createdAt,
          expiresAt,
          revokedAt: null,
        };
        await tx.insertSession(record);
        await tx.appendAudit({ providerUserId: identity.userId, type: 'client_session_created', occurredAt: createdAt });
        return { sessionCookieValue, csrfCookieValue, expiresAt };
      });
    } catch {
      // The commit may be uncertain; do not expose provider/database details or credentials.
      throw safeUnavailable();
    }
  }

  async function authenticate(
    rawSessionCookie: unknown,
    rawCsrfCookie?: unknown,
    rawCsrfHeader?: unknown,
    requireCsrf = false,
  ): Promise<TicketClientSessionCheck> {
    if (!secretToken(rawSessionCookie)) return { kind: 'unauthenticated' };
    try {
      const sessionIdHash = hash('session', rawSessionCookie);
      const row = await store.resolveSession(sessionIdHash);
      if (!validSessionRow(row, sessionIdHash)) return { kind: 'unauthenticated' };
      const instant = now();
      if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw safeUnavailable();
      if (row.revokedAt !== null || Date.parse(row.expiresAt) <= instant.getTime()) return { kind: 'unauthenticated' };

      if (requireCsrf) {
        if (!secretToken(rawCsrfCookie) || !secretToken(rawCsrfHeader)) return { kind: 'csrf_invalid' };
        const csrfCookieBytes = Buffer.from(rawCsrfCookie, 'base64url');
        const csrfHeaderBytes = Buffer.from(rawCsrfHeader, 'base64url');
        if (csrfCookieBytes.length !== csrfHeaderBytes.length || !timingSafeEqual(csrfCookieBytes, csrfHeaderBytes)
          || !constantTimeHashMatches(rawCsrfCookie, row.csrfHash, 'csrf')) return { kind: 'csrf_invalid' };
      }

      return {
        kind: 'authenticated',
        subject: { kind: 'client', userId: row.providerUserId, sessionId: row.sessionIdHash },
        expiresAt: row.expiresAt,
      };
    } catch {
      throw safeUnavailable();
    }
  }

  async function revoke(subject: Extract<TicketSubject, { kind: 'client' }>): Promise<void> {
    try {
      if (!subject || subject.kind !== 'client' || !opaque(subject.userId) || !/^[a-f0-9]{64}$/.test(subject.sessionId)) {
        throw safeUnavailable();
      }
      const instant = now();
      if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw safeUnavailable();
      await store.transaction(async tx => {
        const revoked = await tx.revokeSession(subject.sessionId, subject.userId, instant.toISOString());
        if (revoked) await tx.appendAudit({ providerUserId: subject.userId, type: 'client_session_revoked', occurredAt: instant.toISOString() });
      });
    } catch {
      throw safeUnavailable();
    }
  }

  return { exchange, authenticate, revoke };
}

function validSessionRow(row: TicketClientSessionRecord | null, expectedHash: string): row is TicketClientSessionRecord {
  return !!row && row.sessionIdHash === expectedHash && /^[a-f0-9]{64}$/.test(row.sessionIdHash)
    && opaque(row.providerUserId) && /^[a-f0-9]{64}$/.test(row.csrfHash)
    && isoDate(row.createdAt) && isoDate(row.expiresAt)
    && (row.revokedAt === null || isoDate(row.revokedAt))
    && Date.parse(row.expiresAt) > Date.parse(row.createdAt);
}
