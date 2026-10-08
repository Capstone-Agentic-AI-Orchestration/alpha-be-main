import { createTicketClientActivationService, type TicketClientIdentityVerifier } from '../services/ticketClientActivationService.js';
import { createTicketClientSessionService, type TicketClientSessionPolicy } from '../services/ticketClientSessionService.js';
import { createTicketClientWorkspaceService } from '../services/ticketClientWorkspaceService.js';
import { createTicketClientIntakeContextService } from '../services/ticketClientIntakeContextService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketCreationService } from '../services/ticketCreationService.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createTicketDeliveryService } from '../services/ticketDeliveryService.js';
import type { TicketDeliveryStore, TicketDeliveryObjectReader, TicketDeliveryReadPolicy } from '../store/ticketDeliveryStore.js';
import type { TicketClientActivationStore } from '../store/ticketClientActivationStore.js';
import type { TicketClientIntakeContextStore } from '../store/ticketClientIntakeContextStore.js';
import type { TicketClientSessionStore } from '../store/ticketClientSessionStore.js';
import type { TicketClientWorkspaceStore } from '../store/ticketClientWorkspaceStore.js';
import type { TicketCommandStore } from '../store/ticketCommandStore.js';
import type { TicketCreationStore } from '../store/ticketCreationStore.js';
import type { TicketMessageStore } from '../store/ticketMessageStore.js';
import type { TicketQueueStore } from '../store/ticketQueueStore.js';
import type { TicketReadStore } from '../store/ticketReadStore.js';
import { createTicketClientActivationRouter } from './ticketClientActivationController.js';
import { createTicketClientApiRouter, type TicketClientApiApplication } from './ticketClientApiController.js';
import {
  createTicketClientSessionRouter, type TicketClientSessionAdmission,
  type TicketClientSessionCookiePolicy,
} from './ticketClientSessionController.js';
import { createTicketClientRouter } from './ticketClientRouter.js';

export interface TicketClientRouteDependencies {
  /** All persistence interfaces must use the same durable operation/audit namespace. */
  sessionStore: TicketClientSessionStore;
  activationStore: TicketClientActivationStore;
  workspaceStore: TicketClientWorkspaceStore;
  intakeContextStore: TicketClientIntakeContextStore;
  queueStore: TicketQueueStore;
  readStore: TicketReadStore;
  deliveryStore: TicketDeliveryStore;
  deliveryObjects: TicketDeliveryObjectReader;
  deliveryReadPolicy: TicketDeliveryReadPolicy;
  commandStore: TicketCommandStore;
  messageStore: TicketMessageStore;
  creationStore: TicketCreationStore;
  identityVerifier: TicketClientIdentityVerifier;
  sessionPolicy: TicketClientSessionPolicy;
  cookiePolicy: TicketClientSessionCookiePolicy;
  /** Use distinct durable budgets for activation and repeat sign-in. */
  sessionAdmission: TicketClientSessionAdmission;
  activationAdmission: TicketClientSessionAdmission;
}

/**
 * Wire the provider-neutral application services into one isolated router.
 * This is intentionally only a factory: no database/provider adapter is
 * created, no process config is read, and the returned router is not mounted.
 */
export function createTicketClientRouteBoundary(dependencies: TicketClientRouteDependencies) {
  const sessions = createTicketClientSessionService(
    dependencies.sessionStore, dependencies.identityVerifier, dependencies.sessionPolicy,
  );
  const activation = createTicketClientActivationService(
    dependencies.activationStore, dependencies.identityVerifier,
  );
  const workspaces = createTicketClientWorkspaceService(dependencies.workspaceStore);
  const intakeContext = createTicketClientIntakeContextService(dependencies.intakeContextStore);
  const queue = createTicketQueueService(dependencies.queueStore);
  const reads = createTicketReadService(dependencies.readStore);
  const deliveries = createTicketDeliveryService(dependencies.deliveryStore, dependencies.deliveryObjects, dependencies.deliveryReadPolicy);
  const commands = createTicketCommandService(dependencies.commandStore);
  const messages = createTicketMessageService(dependencies.messageStore);
  const creation = createTicketCreationService(dependencies.creationStore);

  const apiApplication: TicketClientApiApplication = {
    authenticate: sessions.authenticate,
    listWorkspaces: workspaces.list,
    getIntakeContext: intakeContext.get,
    list: queue.list,
    detail: reads.detail,
    deliveryManifest: deliveries.manifest,
    deliveryContent: deliveries.content,
    conversation: reads.conversation,
    reply: messages.reply,
    execute: commands.execute,
    lookup: commands.lookup,
    create: creation.create,
    lookupCreation: creation.lookup,
  };

  return createTicketClientRouter({
    session: createTicketClientSessionRouter(sessions, dependencies.cookiePolicy, dependencies.sessionAdmission),
    activation: createTicketClientActivationRouter(activation, dependencies.cookiePolicy, dependencies.activationAdmission),
    api: createTicketClientApiRouter(apiApplication, dependencies.cookiePolicy),
  });
}
