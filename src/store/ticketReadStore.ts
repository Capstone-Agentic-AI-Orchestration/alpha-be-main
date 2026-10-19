import type { LockedTicket, TicketCommandTransaction } from './ticketCommandStore.js';
import type { TicketCreateInput } from '../ticketing/intake.js';

export interface TicketReadScope { workspaceId: string; ticketId: string }
/** Server-authored metadata, separate public/private update clocks. */
export interface TicketHeaderRow extends TicketReadScope {
  reference: string;
  title: string;
  description: string;
  clientSafeCompanyLabel: string;
  createdAt: string;
  clientUpdatedAt: string;
  internalUpdatedAt: string;
  closedAt: string | null;
  relatedTicketId: string | null;
  sharedProject: { projectId: string; displayName: string; clientVisible: boolean; preview?: { repository: string; branch: 'main' | 'uat'; url: string } | null } | null;
}

export interface TicketScopeReadRow extends TicketReadScope {
  id: string;
  publicSummary: string;
  immutable: boolean;
  clientVisible: boolean;
  proposedAt: string;
}
/** Private PM-only field set; never load for client reads. */
export interface TicketPmScopeReadRow extends TicketReadScope {
  id: string;
  developerBrief: string;
}
export interface TicketDeliveryReadRow extends TicketReadScope {
  id: string;
  scopeVersionId: string;
  pinnedAssetId: string;
  issueRevisionIds: string[];
  immutable: boolean;
  clientVisible: boolean;
  publicSummary: string;
  sharedAt: string | null;
}
/** Fresh access facts for a linked request, not a naked ID relationship. */
export interface RelatedTicketReadRow extends TicketReadScope {
  reference: string;
  title: string;
  clientId: string | null;
  clientGrantActive: boolean;
}

/** Immutable submitted preferences; not an approved project/deadline or scope. */
export interface TicketRequestReadRow extends TicketReadScope {
  source: 'authenticated_client' | 'public_inquiry';
  projectPreference: TicketCreateInput['projectPreference'];
  preferredProjectId: string | null;
  requestedProjectLabel: string | null;
  requestedDeadline: string | null;
  /** Original public contact and its persisted verification fact are private,
   * not an auth identity or an access grant.
   * Client queries MUST omit it and return null; PM queries load it explicitly.
   */
  contact: { fullName: string; email: string; company: string | null; emailVerified: boolean } | null;
}
export interface TicketDetailRows {
  header: TicketHeaderRow;
  currentScope: TicketScopeReadRow | null;
  /** Omit for client actors. Missing may indicate a legacy scope without this field. */
  currentPmScope?: TicketPmScopeReadRow | null;
  currentDelivery: TicketDeliveryReadRow | null;
  related: RelatedTicketReadRow | null;
  /** Missing only for earlier foundation/legacy records, never invented data. */
  request?: TicketRequestReadRow | null;
}

export interface TicketMessageReadRow extends TicketReadScope {
  id: string;
  authorKind: 'pm' | 'client';
  authorId: string;
  audience: 'client' | 'internal';
  body: string;
  createdAt: string;
}
export interface TicketMessagePageRequest { limit: number; after: string | null }

/** Same fresh identity checks as writes. One coherent, authorized transaction;
 * do not page/filter a global list in application code. Future SQL must query
 * only the requested audience and authorized ticket with bound parameters.
 * Lock/check authorization and metadata in consistent order. A production
 * adapter must prove revocation/read consistency separately from local tests.
 */
export interface TicketReadTransaction extends Pick<TicketCommandTransaction, 'lockAuthorizedTicket'> {
  /** For client reads, do not load currentPmScope, private notes, internal
   * document contents, credentials or raw internal project records. Current
   * scope/delivery content must be explicitly published, not inferred from a URL.
   */
  loadDetail(ticket: LockedTicket): Promise<TicketDetailRows>;
  /** Read limit+1 rows, ordered createdAt ascending then ID ascending (binary/C
   * ordering, matching the service's opaque-ID tie break). If after
   * is provided, resolve it in this SAME ticket/audience; absent/private/foreign
   * cursor -> non-enumerating 404, never a global message lookup.
   */
  loadMessages(ticket: LockedTicket, audience: 'client' | 'internal', page: TicketMessagePageRequest): Promise<TicketMessageReadRow[]>;
  /** Record only a client-authored public message actually returned to this PM. */
  markClientMessagesRead?(ticket: LockedTicket, throughMessageId: string): Promise<void>;
}
export interface TicketReadStore {
  transaction<T>(work: (tx: TicketReadTransaction) => Promise<T>): Promise<T>;
}

