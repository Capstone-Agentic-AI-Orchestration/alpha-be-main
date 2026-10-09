import { createHmac } from 'node:crypto';
import type { PublicTicketIntakeGuard } from '../store/ticketPublicIntakeStore.js';

/** Cloudflare's public dummy keys must never enable production submission. */
export function isTurnstileTestKey(value: string): boolean {
  return /^[123]x0{18,}/.test(value);
}

/** Real provider verification, outside database transactions. No token/IP logs.
 * Proxy headers are deliberately not trusted. Socket addresses may group
 * visitors behind a reverse proxy; that conservative limit fails closed.
 */
export function createTicketIntakeTurnstileGuard(config: {
  secret: string; rateKey: Uint8Array; originAllowed: (origin: string) => boolean;
}, providerFetch: typeof fetch = fetch, now: () => Date = () => new Date()): PublicTicketIntakeGuard {
  return {
    async resolveVerifiedRequest(proofToken, entry, request) {
      if (!config.secret || isTurnstileTestKey(config.secret) || config.rateKey.byteLength < 32 || !request.origin || !request.remoteAddress
        || !config.originAllowed(request.origin) || !proofToken || proofToken.length > 2048) return null;
      let origin: URL;
      try { origin = new URL(request.origin); } catch { return null; }
      if (origin.origin !== request.origin || origin.protocol !== 'https:') return null;
      const response = await providerFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: config.secret, response: proofToken }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Inquiry verification unavailable.');
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const result = value as Record<string, unknown>;
      const instant = now().getTime();
      const providerIssued = typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) : NaN;
      // Provider and workstation clocks can differ by milliseconds. Bound that
      // skew to five seconds; never return a future-issued application proof.
      if (result.success !== true || !Number.isFinite(providerIssued) || providerIssued > instant + 5_000
        || instant - providerIssued >= 300_000) return null;
      const issued = Math.min(providerIssued, instant);
      if (result.hostname !== origin.hostname || result.action !== 'ticket_inquiry' || result.cdata !== entry.slug) return null;
      return {
        verificationId: proofToken, entryId: entry.id,
        rateSubjectKey: createHmac('sha256', config.rateKey).update(`${entry.id}\0${request.remoteAddress}`).digest('hex'),
        issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + 300_000).toISOString(),
      };
    },
  };
}
