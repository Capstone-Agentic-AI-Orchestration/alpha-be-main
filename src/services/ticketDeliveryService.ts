import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketDeliveryObjectReader, TicketDeliveryReadPolicy, TicketDeliveryStore } from '../store/ticketDeliveryStore.js';
import { assertTicketDeliveryReadPolicy, verifyTicketDeliverySnapshot } from '../ticketing/deliveryReadModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { authorizeTicketAccess } from './ticketAccess.js';
import { readVerifiedTicketDeliveryContent, type TicketDeliveryContent } from './ticketDeliveryContent.js';
export type { TicketDeliveryContent } from './ticketDeliveryContent.js';

/** The metadata transaction never performs storage I/O. Object contents remain
 * private until digest validation AND a second current authorization/pin check.
 * A timeout/changed delivery/revoked grant returns no bytes and no storage error.
 */
export function createTicketDeliveryService(
  store: TicketDeliveryStore, objects: TicketDeliveryObjectReader, suppliedPolicy: TicketDeliveryReadPolicy,
) {
  assertTicketDeliveryReadPolicy(suppliedPolicy);
  const policy = { ...suppliedPolicy };
  async function inspect(target: TicketTarget, subject: TicketSubject, deliveryId: string) {
    return store.transaction(async tx => {
      const ticket = await authorizeTicketAccess(tx, target, subject);
      if (typeof deliveryId !== 'string' || !deliveryId.trim() || deliveryId.trim() !== deliveryId || deliveryId.length > 200) {
        throw new TicketWorkflowError(404, 'ticket_delivery_not_found', 'Shared result not found.');
      }
      const snapshot = await tx.loadDelivery(ticket, deliveryId);
      return verifyTicketDeliverySnapshot(ticket, deliveryId, snapshot, policy);
    });
  }
  return {
    async manifest(target: TicketTarget, subject: TicketSubject, deliveryId: string) {
      return (await inspect(target, subject, deliveryId)).manifest;
    },
    async content(target: TicketTarget, subject: TicketSubject, deliveryId: string, fileId: string): Promise<TicketDeliveryContent> {
      const initial = await inspect(target, subject, deliveryId);
      return readVerifiedTicketDeliveryContent(target, fileId, initial, () => inspect(target, subject, deliveryId), objects, policy);
    },
  };
}
