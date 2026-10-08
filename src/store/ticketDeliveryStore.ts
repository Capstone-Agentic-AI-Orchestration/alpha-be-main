import type { LockedTicket, TicketTarget, TicketCommandTransaction } from './ticketCommandStore.js';
import type { TicketDeliveryReadRow } from './ticketReadStore.js';

export type TicketDeliveryMediaType = 'text/plain' | 'application/pdf' | 'image/png' | 'image/jpeg';

/** Private, immutable manifest. A clean verdict covers the EXACT bytes/digest,
 * never merely a filename, earlier object version or successful upload.
 * Registration/scanning and PM assessment remain separate write boundaries.
 */
export interface TicketDeliveryFileRow extends TicketTarget {
  id: string;
  pinnedAssetId: string;
  filename: string;
  mediaType: TicketDeliveryMediaType;
  byteLength: number;
  sha256: string;
  immutable: true;
  clientVisible: true;
  scan: { verdict: 'clean'; sha256: string; policyVersion: string; completedAt: string };
  object: { key: string; version: string };
}
export interface TicketDeliverySnapshot {
  delivery: TicketDeliveryReadRow;
  manifest: TicketTarget & {
    id: string;
    scopeVersionId: string;
    issueRevisionIds: string[];
    immutable: true;
    files: TicketDeliveryFileRow[];
  };
}
export interface TicketDeliveryTransaction extends Pick<TicketCommandTransaction, 'lockAuthorizedTicket'> {
  /** Query only this authorized ticket and exact delivery. Clients must never
   * load an unshared result, internal build artifact or generic repository file.
   * Lock grants, current delivery and immutable manifest with the standard lock
   * order; revocation/resharing/scanner invalidation must serialize consistently.
   */
  loadDelivery(ticket: LockedTicket, deliveryId: string): Promise<TicketDeliverySnapshot | null>;
}
export interface TicketDeliveryStore {
  transaction<T>(work: (tx: TicketDeliveryTransaction) => Promise<T>): Promise<T>;
}
export interface TicketDeliveryObjectReader {
  /** Private, version-addressed storage ONLY. No URLs or caller-selected paths.
   * Enforce scope/key ownership, stream byte cap, cancellation and timeout while
   * reading, BEFORE allocating the entire body. No redirects, public/signed URL
   * fallback or network work inside the metadata transaction. Return owned bytes.
   */
  read(input: TicketTarget & {
    pinnedAssetId: string; fileId: string; key: string; version: string;
    maxBytes: number; signal: AbortSignal;
  }): Promise<Uint8Array>;
}
export interface TicketDeliveryReadPolicy {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  objectReadTimeoutMs: number;
}
