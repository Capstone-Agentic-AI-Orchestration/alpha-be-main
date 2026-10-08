import type { TicketCommandReceipt, TicketTarget, TicketWriteMode } from './ticketCommandStore.js';
import type { TicketDeliverySnapshot } from './ticketDeliveryStore.js';
import type { SavedTicketReadiness, TicketReadyManifest } from './ticketTechnicalReadinessStore.js';
import type { TicketFacts, TicketWorkflow } from '../ticketing/workflow.js';

/** Internal verified artifact/scanner receipt reference, never a browser body,
 * URL, path, bare run ID, or permission to fetch arbitrary storage objects.
 */
export interface TicketArtifactSubject { kind: 'verified_delivery_artifacts'; verificationId: string }
export interface LockedTicketArtifacts {
  state: TicketWorkflow;
  mode?: TicketWriteMode;
  source: TicketTarget & {
    userId: string; runId: string; completionId: string; issueId: string;
    issueRevisionId: string; bundleId: string; authorized: boolean;
  };
}
export interface TicketArtifactEvidence {
  facts: TicketFacts;
  /** Committed readiness outcome, not merely a display status or Boolean. */
  readiness: SavedTicketReadiness;
  manifest: TicketDeliverySnapshot['manifest'];
}
export interface TicketDeliveryRegistrationKey extends TicketTarget {
  kind: 'delivery_registration';
  actorId: string; runId: string; completionId: string; bundleId: string; operationId: string;
}
export interface TicketDeliveryRegistrationInput {
  schemaVersion: 1; operationId: string; expectedVersion: number; publicSummary: string;
}
export interface TicketDeliveryRegistrationReceipt extends TicketCommandReceipt { deliveryId: string }
export interface SavedTicketDeliveryRegistration {
  key: TicketDeliveryRegistrationKey;
  fingerprint: string;
  readyManifest: TicketReadyManifest;
  receipt: TicketDeliveryRegistrationReceipt;
}
export interface TicketDeliveryRegistrationAudit {
  key: TicketDeliveryRegistrationKey; deliveryId: string; readyManifest: TicketReadyManifest;
  workflowVersion: number; type: 'delivery_registered'; occurredAt: string;
}
export interface TicketDeliveryRegistrationTransaction {
  /** Resolve persisted server verification, trusted scanner/build provenance,
   * current execution authority, and exact owned completion/bundle binding.
   * Historical verified source may recover an old outcome; new registration
   * separately verifies the current approved work. Null is non-enumerating.
   */
  lockAuthorizedArtifacts(target: TicketTarget, subject: TicketArtifactSubject): Promise<LockedTicketArtifacts | null>;
  findOperation(key: TicketDeliveryRegistrationKey): Promise<SavedTicketDeliveryRegistration | null>;
  /** Same-transaction current revisions/reviews/claims and committed readiness;
   * only private immutable object generations previously validated/scanned by a
   * trusted provider boundary. Never load manifests from the caller or fetch URLs.
   */
  loadEvidence(ticket: LockedTicketArtifacts): Promise<TicketArtifactEvidence>;
  findRegisteredBundle(ticket: LockedTicketArtifacts): Promise<SavedTicketDeliveryRegistration | null>;
  /** Insert-only immutable snapshot and registration provenance. Recheck the
   * expected ticket version and exact bundle ownership under the shared locks.
   * False -> full rollback. Update ONLY internal metadata clocks; no workflow
   * delivery pointer, public clock, client notification, Issue or runner change.
   * Enforce workspace/ticket/bundle uniqueness; never overwrite prior results.
   */
  insertDelivery(ticket: LockedTicketArtifacts, expectedVersion: number, snapshot: TicketDeliverySnapshot, occurredAt: string): Promise<boolean>;
  appendAudit(audit: TicketDeliveryRegistrationAudit): Promise<void>;
  /** Separate internal namespace; insert-only uniqueness. */
  insertOperation(operation: SavedTicketDeliveryRegistration): Promise<void>;
}
export interface TicketDeliveryRegistrationStore {
  /** All mutations commit together; full rollback on error. No provider/file/
   * runner/network I/O here, no automatic retry of ambiguous COMMIT outcomes.
   */
  transaction<T>(work: (tx: TicketDeliveryRegistrationTransaction) => Promise<T>): Promise<T>;
}
