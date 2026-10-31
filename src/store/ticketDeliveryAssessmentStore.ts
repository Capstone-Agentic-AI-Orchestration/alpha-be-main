import type { LockedTicket, TicketCommandTransaction } from './ticketCommandStore.js';
import type { TicketDeliverySnapshot } from './ticketDeliveryStore.js';
import type { SavedTicketReadiness } from './ticketTechnicalReadinessStore.js';
import type { TicketFacts } from '../ticketing/workflow.js';

export interface TicketDeliveryAssessmentCandidate {
  /** Persisted immutable registration, never an arbitrary build artifact. */
  snapshot: TicketDeliverySnapshot;
  facts: TicketFacts;
  readiness: SavedTicketReadiness;
}
export interface TicketDeliveryCandidatePage { limit: number; after: string | null }
export interface TicketDeliveryAssessmentTransaction extends Pick<TicketCommandTransaction, 'lockAuthorizedTicket'> {
  /** PM-only query. Current exact ready manifest, registration provenance and
   * fresh run/review facts must be joined under the shared authorization locks.
   * Never load client contact/messages/notes or global repository artifacts.
   */
  loadCandidate(ticket: LockedTicket, deliveryId: string): Promise<TicketDeliveryAssessmentCandidate | null>;
  /** Read limit+1 eligible registrations, ordered delivery ID ascending using
   * binary/C collation. Resolve cursor in this same authorized current manifest;
   * absent/foreign cursor -> non-enumerating 404. Filter in SQL, not a global list.
   */
  loadCandidates(ticket: LockedTicket, page: TicketDeliveryCandidatePage): Promise<TicketDeliveryAssessmentCandidate[]>;
}
export interface TicketDeliveryAssessmentStore {
  transaction<T>(work: (tx: TicketDeliveryAssessmentTransaction) => Promise<T>): Promise<T>;
}
