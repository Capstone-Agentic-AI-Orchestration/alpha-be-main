import { Router, type Response } from 'express';

import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { PostgresTicketQueueStore } from '../store/ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from '../store/ticketReadPostgresStore.js';
import type { TransactionalSql } from '../store/database.js';
import { createTicketQueueRouter } from './ticketQueueController.js';
import { createTicketReadRouter } from './ticketReadController.js';
import { relayPmTicketRequest } from './ticketRequestAuth.js';
import { PostgresTicketTriageStore } from '../store/ticketTriagePostgresStore.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { createTicketCommandRouter } from './ticketCommandController.js';
import { createTicketMessageRouter } from './ticketMessageController.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { createTicketInvitationEmailRouter } from './ticketInvitationEmailController.js';
import { PostgresTicketInvitationEmailStore } from '../store/ticketInvitationEmailPostgresStore.js';

/**
 * First production composition slice for the existing PM Tickets page.
 *
 * Queue/detail use the cloud's durable Postgres authority. The optional Phase 2
 * gate adds only atomic PM triage; future commands and public replies remain
 * unavailable. Desktop processes relay to cloud, never a local ticket store.
 */
export function createTicketPmReadRouteBoundary(
  db: TransactionalSql,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
  triageEnabled = false,
  invitationEmailDeliveryConfigured = false,
): Router {
  const router = Router({ caseSensitive: true, strict: true });
  const queue = createTicketQueueService(new PostgresTicketQueueStore(db));
  const reads = createTicketReadService(new PostgresTicketReadStore(db));

  router.use(createTicketQueueRouter(queue, relayRequest));
  router.use(createTicketReadRouter({ ...reads,
    async detail(target, subject) {
      const detail = await reads.detail(target, subject);
      return triageEnabled ? detail : { ...detail, writesAvailable: false };
    },
  }, relayRequest));
  if (triageEnabled) {
    const store = new PostgresTicketTriageStore(db);
    const commands = createTicketCommandService(store);
    const messages = createTicketMessageService(store);
    router.use(createTicketCommandRouter(commands, relayRequest));
    router.use(createTicketMessageRouter({ note: messages.note,
      async reply() { throw new TicketWorkflowError(503, 'ticket_action_unavailable', 'Client conversations are not enabled yet.'); },
    }, relayRequest));
    router.use(createTicketInvitationEmailRouter(
      new PostgresTicketInvitationEmailStore(db), invitationEmailDeliveryConfigured,
    ));
  }
  router.use((_req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(503).json({ error: 'Ticket changes are not enabled yet.' });
  });
  return router;
}
