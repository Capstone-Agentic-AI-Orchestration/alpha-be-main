import type { SavedTicketOperation, TicketCommandTransaction, TicketSubject, TicketTarget, TicketWriteMode } from './ticketCommandStore.js';
import type { TicketHeaderRow } from './ticketReadStore.js';
import type { TicketCreateInput } from '../ticketing/intake.js';
import type { TicketWorkflow } from '../ticketing/workflow.js';

export interface AuthorizedTicketCreateContext {
  /** Approved intake-context handle, not an arbitrary internal workspace ID. */
  id: string;
  workspaceId: string;
  clientId: string;
  accessActive: boolean;
  acceptsNewRequests: boolean;
  mode?: TicketWriteMode;
  companyLabel: string;
}
export interface SharedTicketProjectOption {
  id: string; workspaceId: string; clientId: string; projectId: string;
  displayName: string; active: boolean; clientVisible: boolean;
}
/** No ticket exists yet. Unique within workspace/client/create namespace;
 * context is fingerprinted, not added as a separate uniqueness escape hatch.
 * Its saved result is ALSO recorded under the new ticket's shared operation key.
 */
export interface TicketCreateOperationKey { workspaceId: string; clientId: string; operationId: string }
export interface TicketCreatedRecord {
  state: TicketWorkflow;
  header: TicketHeaderRow;
  request: {
    source: 'authenticated_client';
    intakeContextId: string;
    projectPreference: TicketCreateInput['projectPreference'];
    /** Server-resolved preference only. Does not link/authorize the project. */
    preferredProjectId: string | null;
    requestedProjectLabel: string | null;
    requestedDeadline: string | null;
    contact: null;
  };
}
export interface TicketCreatedAudit {
  target: TicketTarget; clientId: string; operationId: string;
  type: 'ticket_created'; occurredAt: string;
}
export interface TicketCreatedSignal extends TicketCreatedAudit {}
export interface TicketCreationTransaction extends Pick<TicketCommandTransaction, 'lockAuthorizedTicket'> {
  /** Recheck the persisted client's exact session binding and live service grant
   * before exposing/parsing input. Internal identities cannot enter this path.
   * Retained access may remain after new-intake is disabled (lookup/history).
   */
  lockAuthorizedCreateContext(contextId: string, subject: TicketSubject): Promise<AuthorizedTicketCreateContext | null>;
  /** Serialize this key even when absent; unique inserts alone are not a lock.
   * The dedicated ticket_creation_operations row is both the unique recovery
   * key and its saved outcome; do not mirror it into ticket_operation_receipts.
   * Do not copy body, contact information or secrets into the operation record.
   */
  lockCreateOperation(key: TicketCreateOperationKey): Promise<Extract<SavedTicketOperation, { kind: 'create' }> | null>;
  loadSharedProjectOption(context: AuthorizedTicketCreateContext, optionId: string): Promise<SharedTicketProjectOption | null>;
  /** Server-owned atomic allocator and UNIQUE reference within workspace.
   * Never use list length/browser counters. Rollbacks may leave sequence gaps.
   */
  allocateReference(context: AuthorizedTicketCreateContext): Promise<string>;
  insertTicket(record: TicketCreatedRecord): Promise<void>;
  /** Only this designated verified client, only this new ticket, same workspace.
   * Never create an internal member/project assignment or widen project access.
   */
  grantCreatedTicket(context: AuthorizedTicketCreateContext, target: TicketTarget): Promise<void>;
  appendCreatedAudit(audit: TicketCreatedAudit): Promise<void>;
  /** Durable minimal signal, not an email success, board broadcast or runner job. */
  enqueueCreated(signal: TicketCreatedSignal): Promise<void>;
  /** Persist the create outcome in ticket_creation_operations. Its unique key
   * is also the pre-ticket recovery index; the row and ticket commit atomically.
   */
  insertCreateOperation(operation: Extract<SavedTicketOperation, { kind: 'create' }>): Promise<void>;
}
export interface TicketCreationStore {
  /** One connection/transaction, full rollback, no external calls or blind retry
   * on unknown COMMIT. Follow the shared order: session/client service grant and
   * intake context first, create-operation key second, related ticket IDs in
   * stable order, then new ticket/ticket grant, audit and outbox. This must be
   * compatible with revocation and ordinary ticket decision transactions.
   */
  transaction<T>(work: (tx: TicketCreationTransaction) => Promise<T>): Promise<T>;
}
