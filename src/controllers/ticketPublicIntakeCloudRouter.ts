import { createHmac } from 'node:crypto';
import { Router } from 'express';
import type { TransactionalSql } from '../store/database.js';
import { PostgresTicketPublicIntakeStore } from '../store/ticketPublicIntakePostgresStore.js';
import { createTicketIntakeTurnstileGuard, isTurnstileTestKey } from '../services/ticketIntakeTurnstileGuard.js';
import { createTicketPublicIntakeRouteBoundary } from './ticketPublicIntakeRouteFactory.js';
import { route } from './asyncRoute.js';

export function createTicketPublicIntakeCloudRouter(db: TransactionalSql, config: {
  sessionSecret: string; turnstileSecret: string; turnstileSiteKey: string; originAllowed: (origin: string) => boolean;
  acknowledgmentsEnabled?: boolean;
}) {
  const router = Router();
  const store = new PostgresTicketPublicIntakeStore(db, config.acknowledgmentsEnabled === true);
  const configured = config.sessionSecret.length >= 32 && Boolean(config.turnstileSecret && config.turnstileSiteKey)
    && !isTurnstileTestKey(config.turnstileSecret) && !isTurnstileTestKey(config.turnstileSiteKey);
  router.get('/:slug/config', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const entry = await store.loadPublishedEntry(req.params.slug ?? '');
    if (!entry?.published) return res.status(404).json({ error: 'This inquiry link is unavailable.' });
    const enabled = configured && entry.mode === 'enabled';
    return res.json({ enabled, siteKey: enabled ? config.turnstileSiteKey : null });
  }));
  const key = (domain: string) => createHmac('sha256', config.sessionSecret).update(domain).digest();
  router.use(createTicketPublicIntakeRouteBoundary({
    store,
    guard: createTicketIntakeTurnstileGuard({ secret: config.turnstileSecret,
      rateKey: key('alpha-ticket-intake-rate-v1'), originAllowed: config.originAllowed }),
    security: { fingerprintKeys: configured ? [{ id: 'session-derived-v1', secret: key('alpha-ticket-intake-dedupe-v1') }] : [],
      maxProofAgeMs: 300_000 },
    resolveRemoteAddress: req => req.socket.remoteAddress ?? null,
  }));
  return router;
}
