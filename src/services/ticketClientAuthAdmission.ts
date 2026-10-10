import type { Request } from 'express';
import type { TicketClientSessionAdmission } from '../controllers/ticketClientSessionController.js';
import type { ClientAuthRateLimitBucket, PostgresTicketClientAuthRateLimitStore } from '../store/ticketClientAuthRateLimitPostgresStore.js';
import { ticketClientRateSubject } from '../store/ticketClientAuthRateLimitPostgresStore.js';

const WINDOW_MS = 60_000;

/** Uses only the socket peer address; never trusts caller-supplied forwarded-IP headers. */
export function createTicketClientAuthAdmission(config: {
  store: PostgresTicketClientAuthRateLimitStore;
  secret: string;
  bucket: ClientAuthRateLimitBucket;
  maximumPerMinute: number;
}, now: () => Date = () => new Date()): TicketClientSessionAdmission {
  return {
    async check(req: Request) {
      const address = req.socket.remoteAddress;
      const instant = now();
      if (typeof config.secret !== 'string' || config.secret.length < 32
        || typeof address !== 'string' || !address.trim() || address.length > 256
        || !(instant instanceof Date) || !Number.isFinite(instant.getTime())
        || !Number.isSafeInteger(config.maximumPerMinute) || config.maximumPerMinute < 1) {
        return { allowed: false, retryAfterSeconds: 60 };
      }
      const bucketStart = new Date(Math.floor(instant.getTime() / WINDOW_MS) * WINDOW_MS).toISOString();
      const allowed = await config.store.consume({
        bucket: config.bucket,
        subjectHash: ticketClientRateSubject(config.secret, config.bucket, address),
        windowStartedAt: bucketStart,
        maximum: config.maximumPerMinute,
      });
      return { allowed, retryAfterSeconds: allowed ? null : 60 };
    },
  };
}
