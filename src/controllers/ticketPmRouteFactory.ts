import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketInvitationService, type TicketInvitationPolicy } from '../services/ticketInvitationService.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createTicketScopeService } from '../services/ticketScopeService.js';
import { createTicketDeliveryService } from '../services/ticketDeliveryService.js';
import { createTicketDeliveryAssessmentService } from '../services/ticketDeliveryAssessmentService.js';
import type { TicketDeliveryAssessmentStore } from '../store/ticketDeliveryAssessmentStore.js';
import { createTicketPmDeliveryCandidatesRouter } from './ticketPmDeliveryCandidatesController.js';
import type { TicketDeliveryStore, TicketDeliveryObjectReader, TicketDeliveryReadPolicy } from '../store/ticketDeliveryStore.js';
import { createTicketPmDeliveryRouter } from './ticketPmDeliveryController.js';
import type { TicketCommandStore } from '../store/ticketCommandStore.js';
import type { TicketInvitationStore } from '../store/ticketInvitationStore.js';
import type { TicketMessageStore } from '../store/ticketMessageStore.js';
import type { TicketQueueStore } from '../store/ticketQueueStore.js';
import type { TicketReadStore } from '../store/ticketReadStore.js';
import type { TicketScopeStore } from '../store/ticketScopeStore.js';
import type { TicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';
import { createTicketCommandRouter } from './ticketCommandController.js';
import { createTicketInvitationRouter } from './ticketInvitationController.js';
import { createTicketMessageRouter } from './ticketMessageController.js';
import { createTicketQueueRouter } from './ticketQueueController.js';
import { createTicketReadRouter } from './ticketReadController.js';
import { createTicketScopeRouter } from './ticketScopeController.js';
import { createTicketPmRouter } from './ticketPmRouter.js';

export interface TicketPmRouteDependencies {
  /** All adapters must address the same durable workspace/ticket authority. */
  queueStore: TicketQueueStore;
  readStore: TicketReadStore;
  deliveryStore: TicketDeliveryStore;
  deliveryAssessmentStore: TicketDeliveryAssessmentStore;
  deliveryObjects: TicketDeliveryObjectReader;
  deliveryReadPolicy: TicketDeliveryReadPolicy;
  commandStore: TicketCommandStore;
  messageStore: TicketMessageStore;
  invitationStore: TicketInvitationStore;
  scopeStore: TicketScopeStore;
  invitationPolicy: TicketInvitationPolicy;
  invitationSecretProtector: TicketInvitationSecretProtector;
}

/**
 * Compose the one-page PM Tickets API from injected app stores and services.
 * It creates no singleton DB/provider, reads no runtime configuration and is
 * intentionally not mounted by index.ts until durable adapters are approved.
 */
export function createTicketPmRouteBoundary(dependencies: TicketPmRouteDependencies) {
  const queue = createTicketQueueService(dependencies.queueStore);
  const reads = createTicketReadService(dependencies.readStore);
  const commands = createTicketCommandService(dependencies.commandStore, undefined, undefined, dependencies.deliveryReadPolicy);
  const messages = createTicketMessageService(dependencies.messageStore);
  const invitations = createTicketInvitationService(
    dependencies.invitationStore, dependencies.invitationPolicy, dependencies.invitationSecretProtector,
  );

  return createTicketPmRouter({
    queue: createTicketQueueRouter(queue),
    read: createTicketReadRouter(reads),
    commands: createTicketCommandRouter(commands),
    messages: createTicketMessageRouter(messages),
    invitations: createTicketInvitationRouter(invitations),
    scopes: createTicketScopeRouter(createTicketScopeService(dependencies.scopeStore)),
    deliveries: createTicketPmDeliveryRouter(createTicketDeliveryService(dependencies.deliveryStore, dependencies.deliveryObjects, dependencies.deliveryReadPolicy)),
    deliveryCandidates: createTicketPmDeliveryCandidatesRouter(createTicketDeliveryAssessmentService(dependencies.deliveryAssessmentStore, dependencies.deliveryObjects, dependencies.deliveryReadPolicy)),
  });
}
