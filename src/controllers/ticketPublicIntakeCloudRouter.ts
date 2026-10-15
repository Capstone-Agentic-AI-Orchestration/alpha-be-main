import { createHmac } from 'node:crypto';
import { Router } from 'express';
import type { TransactionalSql } from '../store/database.js';
import { PostgresTicketPublicIntakeStore } from '../store/ticketPublicIntakePostgresStore.js';
import { createTicketIntakeOriginRateGuard } from '../services/ticketIntakeOriginRateGuard.js';
import { createTicketCentralIntakeService } from '../services/ticketCentralIntakeService.js';
import { PostgresTicketCentralIntakeStore } from '../store/ticketCentralIntakePostgresStore.js';
import { createTicketCentralIntakePublicRouter } from './ticketCentralIntakePublicController.js';
import { createTicketPublicIntakeRouteBoundary } from './ticketPublicIntakeRouteFactory.js';
import { route } from './asyncRoute.js';

export function createTicketPublicIntakeCloudRouter(db: TransactionalSql, config: {
  sessionSecret: string; organizationKey?: string; originAllowed: (origin: string) => boolean;
  acknowledgmentsEnabled?: boolean;
}) {
  const router = Router();
  const store = new PostgresTicketPublicIntakeStore(db, config.acknowledgmentsEnabled === true);
  const configured = config.sessionSecret.length >= 32;
  const key = (domain: string) => createHmac('sha256', config.sessionSecret).update(domain).digest();
  if (config.organizationKey && configured) {
    const centralGuard = createTicketIntakeOriginRateGuard({
      rateKey: key('alpha-ticket-central-intake-rate-v1'), originAllowed: config.originAllowed,
    });
    const central = createTicketCentralIntakeService({
      store: new PostgresTicketCentralIntakeStore(db), guard: centralGuard,
      organizationKey: config.organizationKey,
      fingerprintKeys: [{ id: 'central-session-derived-v1', secret: key('alpha-ticket-central-intake-dedupe-v1') }],
      maxRequestAgeMs: 300_000,
    });
    router.use(createTicketCentralIntakePublicRouter(central, req => req.socket.remoteAddress ?? null, true));
  } else {
    router.get('/config', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ enabled: false });
    });
    router.post('/', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.status(503).json({ error: 'Public ticket intake is not enabled in this Alpha environment.', code: 'ticket_intake_writes_disabled' });
    });
  }
  router.get('/:slug/config', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const entry = await store.loadPublishedEntry(req.params.slug ?? '');
    if (!entry?.published) return res.status(404).json({ error: 'This inquiry link is unavailable.' });
    const enabled = configured && entry.mode === 'enabled';
    return res.json({ enabled });
  }));
  router.use(createTicketPublicIntakeRouteBoundary({
    store,
    guard: createTicketIntakeOriginRateGuard({
      rateKey: key('alpha-ticket-intake-rate-v1'), originAllowed: config.originAllowed,
    }),
    security: { fingerprintKeys: configured ? [{ id: 'session-derived-v1', secret: key('alpha-ticket-intake-dedupe-v1') }] : [],
      maxRequestAgeMs: 300_000 },
    resolveRemoteAddress: req => req.socket.remoteAddress ?? null,
  }));
  return router;
}
