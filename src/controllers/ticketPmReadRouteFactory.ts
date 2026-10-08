import { Router, type Response } from 'express';

import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { PostgresTicketQueueStore } from '../store/ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from '../store/ticketReadPostgresStore.js';
import type { TransactionalSql } from '../store/database.js';
import { createTicketQueueRouter } from './ticketQueueController.js';
import { createTicketReadRouter } from './ticketReadController.js';

/**
 * First production composition slice for the existing PM Tickets page.
 *
 * It deliberately exposes only authorized reads. The queue and detail stores
 * share the cloud's durable Postgres authority, while every write endpoint
 * remains explicitly unavailable until the atomic command/message stores and
 * their migration-compatible evidence are ready. Desktop processes do not
 * construct these adapters; their existing ticket boundary relays to cloud.
 */
export function createTicketPmReadRouteBoundary(db: TransactionalSql): Router {
  const router = Router({ caseSensitive: true, strict: true });
  const queue = createTicketQueueService(new PostgresTicketQueueStore(db));
  const reads = createTicketReadService(new PostgresTicketReadStore(db));

  router.use(createTicketQueueRouter(queue));
  router.use(createTicketReadRouter(reads));
  router.use((_req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(503).json({ error: 'Ticket changes are not enabled yet.' });
  });
  return router;
}
