import { createHmac } from 'node:crypto';
import type { PublicTicketIntakeGuard } from '../store/ticketPublicIntakeStore.js';

/**
 * Provider-free gate for the public inquiry form. An exact HTTPS Origin check
 * constrains normal browser submissions, while durable PostgreSQL source and
 * entry budgets are the actual abuse controls. Origin is not authentication:
 * non-browser callers can forge it, so never use it as identity.
 *
 * The source address comes only from the server's socket resolver. Behind a
 * shared proxy, unrelated visitors can share a source bucket; the independent
 * per-entry budget still bounds total submissions. Do not parse an untrusted
 * X-Forwarded-For value here.
 */
export function createTicketIntakeOriginRateGuard(config: {
  rateKey: Uint8Array; originAllowed: (origin: string) => boolean;
}, now: () => Date = () => new Date()): PublicTicketIntakeGuard {
  return {
    async admitRequest(entry, request) {
      if (!(config.rateKey instanceof Uint8Array) || config.rateKey.byteLength < 32
        || typeof request?.origin !== 'string' || request.origin.length < 1 || request.origin.length > 2048
        || request.origin.trim() !== request.origin
        || typeof request.remoteAddress !== 'string' || request.remoteAddress.length < 1 || request.remoteAddress.length > 256
        || request.remoteAddress.trim() !== request.remoteAddress) return null;

      let origin: URL;
      try {
        origin = new URL(request.origin);
        if (origin.origin !== request.origin || origin.protocol !== 'https:' || origin.username || origin.password
          || !config.originAllowed(request.origin)) return null;
      } catch { return null; }

      const instant = now();
      const issuedAtMs = instant.getTime();
      if (!Number.isFinite(issuedAtMs)) return null;

      return {
        entryId: entry.id,
        rateSubjectKey: createHmac('sha256', config.rateKey)
          .update(`${entry.id}\0${request.remoteAddress}`).digest('hex'),
        issuedAt: instant.toISOString(),
        expiresAt: new Date(issuedAtMs + 300_000).toISOString(),
      };
    },
  };
}
