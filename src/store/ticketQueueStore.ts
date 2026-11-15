import type { LockedTicket, TicketSubject, TicketWriteMode } from './ticketCommandStore.js';
import type { TicketHeaderRow } from './ticketReadStore.js';

/** Client access is a client-service grant, NOT internal workspace membership. */
export interface LockedTicketQueue {
  workspaceId: string;
  timeZone: string;
  mode?: TicketWriteMode;
  principal:
    | { kind: 'client'; userId: string; accessActive: boolean }
    | { kind: 'pm'; userId: string; membershipActive: boolean; canManageTickets: boolean };
}
export type TicketQueueFilter = 'all' | 'history' | 'open' | 'needs_client'
  | 'needs_pm' | 'in_progress' | 'waiting_client' | 'closed_month';
export interface TicketQueueClientGroup { key: string; displayName: string }
/**
 * One client account in a PM's workspace, for the Clients list. Counts use the
 * queue's own predicates, so they agree with the queue filtered to this client.
 */
export interface TicketQueueClientSummary {
  /** `client:<account>`, the key the queue's clientGroupKey filter takes. */
  key: string;
  displayName: string;
  /** Second line when two clients share a name; null when none is known. */
  company: string | null;
  /** The client's service grant in this workspace. */
  access: 'active' | 'inactive';
  tickets: {
    needsPm: number;
    waitingClient: number;
    open: number;
    closed: number;
    /** Open requests whose project is not linked and shared with the client yet. */
    unlinkedOpen: number;
    /** Requests this client can no longer open while their account is active. */
    accessRevoked: number;
  };
  /** Exactly the projects the client portal shows this client. */
  projects: Array<{ projectId: string; name: string; previewPublished: boolean }>;
  lastActivityAt: string;
}
export interface TicketQueuePageRequest {
  limit: number;
  after: string | null;
  search: string;
  filter: TicketQueueFilter;
  clientGroupKey?: string;
}
export interface TicketQueueMonth { year: number; month: number; timeZone: string }
export interface TicketQueueRow {
  ticket: LockedTicket;
  /** Fresh service/ticket grant for the designated client, including PM reads. */
  clientAccessActive: boolean;
  /** PM-only, safe delivery summary. The client queue projection omits it. */
  clientInvitation?: {
    status: 'pending' | 'expired' | 'revoked' | 'consumed';
    delivery: 'queued' | 'sending' | 'retrying' | 'accepted_by_provider' | 'failed' | 'unknown';
    expiresAt: string;
  } | null;
  /** PM-only identity grouping. Public inquiries without a verified client ID
   * use a ticket-specific key, never an email-derived key. */
  pmClientGroup?: { key: string; displayName: string };
  /** PM-only project label. Never included in a client queue projection. */
  pmProjectName?: string | null;
  /** PM-only unread client-reply indicator. */
  pmClientReplyUnread?: boolean;
  header: Pick<TicketHeaderRow, 'workspaceId' | 'ticketId' | 'reference' | 'title' | 'createdAt' | 'clientUpdatedAt' | 'internalUpdatedAt' | 'closedAt'>;
}
export interface ClientTicketCounters { kind: 'client'; open: number; needsClient: number }
export interface PmTicketCounters { kind: 'pm'; needsPm: number; inProgress: number; waitingClient: number; closedMonth: number }
export type TicketQueueCounters = ClientTicketCounters | PmTicketCounters;

/** Queries must enforce the same current scope/identity/grants in one coherent
 * snapshot. No global-list filtering, per-row auth network calls, or mock counts.
 */
export interface TicketQueueTransaction {
  /** Exact session binding/verified internal bearer + current service access.
   * Non-enumerating null for absent, archived, revoked or inaccessible service.
   * Reuse the command/read adapter's fresh credential and membership checks.
   */
  lockAuthorizedQueue(workspaceId: string, subject: TicketSubject): Promise<LockedTicketQueue | null>;
  /** Query ONLY permitted ticket rows, with joined current grants/membership.
   * Read limit+1 after filtering; sort updatedAt DESC, ticket ID DESC, binary/C.
   * Client sorting/search uses only public clocks and reference/title, never
   * private notes, internal clocks, drafts, files, descriptions or Issue text.
   * Resolve after in this SAME authorized filtered query; missing -> safe 404.
   * No stale snapshot counts/rows after concurrent revocation is committed.
   */
  loadQueue(scope: LockedTicketQueue, page: TicketQueuePageRequest, month: TicketQueueMonth): Promise<TicketQueueRow[]>;
  /** All PM-visible client identities in the authorized workspace, independent of queue pagination. */
  listClientGroups(scope: LockedTicketQueue): Promise<TicketQueueClientGroup[]>;
  /** PM only: every client account (never an unverified inquiry) with its counts, projects and access. */
  listClients(scope: LockedTicketQueue): Promise<TicketQueueClientSummary[]>;
  /** Entire authorized workspace queue, independent of page/search/filter.
   * A PM's clientGroupKey narrows it to that client, as the queue it counts is.
   * Use identical live ticket grants/predicates. COUNT DISTINCT ticket identity;
   * joined messages/Issues must not multiply counts. No cache/page-length counts.
   * Client-action counts require an active designated-client ticket grant and
   * exclude holds/withdrawal; provider failure is not waiting on the client.
   * Closed month is workspace-local year/month, not browser/UTC or last update.
   * Accepted/answered/cancelled closures qualify; a decline alone never does.
   */
  countQueue(scope: LockedTicketQueue, month: TicketQueueMonth, clientGroupKey?: string): Promise<TicketQueueCounters>;
}
export interface TicketQueueStore {
  transaction<T>(work: (tx: TicketQueueTransaction) => Promise<T>): Promise<T>;
}

