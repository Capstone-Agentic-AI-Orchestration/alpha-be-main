import { createTicketDeveloperContextService } from '../services/ticketDeveloperContextService.js';
import type { TicketDeveloperContextStore } from '../store/ticketDeveloperContextStore.js';
import { createTicketDeveloperContextRouter } from './ticketDeveloperContextController.js';

/** Compose the developer's assigned-work read boundary from injected stores. */
export function createTicketDeveloperContextRouteBoundary(store: TicketDeveloperContextStore) {
  return createTicketDeveloperContextRouter(createTicketDeveloperContextService(store));
}
