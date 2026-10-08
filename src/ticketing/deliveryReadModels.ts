import { z } from 'zod';

import type { LockedTicket } from '../store/ticketCommandStore.js';
import type { TicketDeliveryMediaType, TicketDeliveryReadPolicy, TicketDeliverySnapshot } from '../store/ticketDeliveryStore.js';
import { TicketReadInvariantError } from './readModels.js';
import { assertTicketActor, TicketWorkflowError } from './workflow.js';
import type { TicketReadyManifest } from '../store/ticketTechnicalReadinessStore.js';

export interface TicketDeliveryFile {
  id: string; filename: string; mediaType: TicketDeliveryMediaType; byteLength: number; sha256: string;
}
export interface TicketDeliveryManifest {
  deliveryId: string; scopeVersionId: string; files: TicketDeliveryFile[];
}
const id = z.string().min(1).max(200).refine(value => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const filename = z.string().min(1).max(160).refine(value => value.trim() === value
  && value !== '.' && value !== '..' && !/[\u0000-\u001f\u007f/\\<>:"|?*\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value));
const fileSchema = z.object({
  workspaceId: id, ticketId: id, id, pinnedAssetId: id, filename,
  mediaType: z.enum(['text/plain', 'application/pdf', 'image/png', 'image/jpeg']),
  byteLength: z.number().int().positive().safe(), sha256: digest,
  immutable: z.literal(true), clientVisible: z.literal(true),
  scan: z.object({ verdict: z.literal('clean'), sha256: digest, policyVersion: id,
    completedAt: z.string().datetime({ offset: true }) }),
  object: z.object({ key: z.string().min(1).max(1024), version: id }),
});
const manifestSchema = z.object({
  workspaceId: id, ticketId: id, id, scopeVersionId: id,
  issueRevisionIds: z.array(id).min(1), immutable: z.literal(true), files: z.array(fileSchema).min(1),
});
const publicFileSchema = z.object({ id, filename,
    mediaType: z.enum(['text/plain', 'application/pdf', 'image/png', 'image/jpeg']),
    byteLength: z.number().int().positive().max(32 * 1024 * 1024), sha256: digest,
});
const publicManifestSchema = z.object({
  deliveryId: id, scopeVersionId: id, files: z.array(publicFileSchema).min(1).max(100),
});
export function projectTicketDeliveryFile(value: unknown): TicketDeliveryFile {
  const parsed = publicFileSchema.safeParse(value);
  invariant(parsed.success);
  return parsed.data;
}
/** Transport defense-in-depth: project rather than serialize service objects. */
export function projectTicketDeliveryManifest(value: unknown): TicketDeliveryManifest {
  const parsed = publicManifestSchema.safeParse(value);
  invariant(parsed.success && new Set(parsed.data.files.map(file => file.id)).size === parsed.data.files.length);
  return parsed.data;
}

function invariant(value: unknown): asserts value { if (!value) throw new TicketReadInvariantError(); }
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && new Set(a).size === a.length
    && new Set(b).size === b.length && a.every(value => b.includes(value));
}
export function assertTicketDeliveryReadPolicy(policy: TicketDeliveryReadPolicy): void {
  invariant(policy && Number.isSafeInteger(policy.maxFiles) && policy.maxFiles >= 1 && policy.maxFiles <= 100
    && Number.isSafeInteger(policy.maxFileBytes) && policy.maxFileBytes >= 1 && policy.maxFileBytes <= 32 * 1024 * 1024
    && Number.isSafeInteger(policy.maxTotalBytes) && policy.maxTotalBytes >= policy.maxFileBytes
    && policy.maxTotalBytes <= 128 * 1024 * 1024
    && Number.isSafeInteger(policy.objectReadTimeoutMs) && policy.objectReadTimeoutMs >= 1 && policy.objectReadTimeoutMs <= 60000);
}

/** Validate a server-assembled, scanned bundle before registration. This does
 * not assess, publish or authorize a client read of it. No synthetic PM actor
 * or workflow delivery pointer is used to pretend an assessment happened.
 */
export function verifyTicketDeliveryRegistration(
  snapshot: TicketDeliverySnapshot, work: TicketReadyManifest, policy: TicketDeliveryReadPolicy,
): TicketDeliverySnapshot {
  const row = snapshot?.delivery;
  invariant(row && id.safeParse(row.id).success && row.workspaceId === work.workspaceId && row.ticketId === work.ticketId
    && row.scopeVersionId === work.scopeVersionId && id.safeParse(row.pinnedAssetId).success
    && row.immutable === true && row.clientVisible === true && row.sharedAt === null
    && typeof row.publicSummary === 'string' && row.publicSummary.trim().length > 0
    && row.publicSummary.length <= 4000
    && sameSet(row.issueRevisionIds, work.issueRevisions.map(issue => issue.revisionId)));
  return verifyPrivateBundle(snapshot, policy);
}

/** Own and allowlist the same bundle for registration and existing protected
 * reads. Storage keys/scanner fields are private validation evidence only.
 */
function verifyPrivateBundle(snapshot: TicketDeliverySnapshot, policy: TicketDeliveryReadPolicy): TicketDeliverySnapshot {
  const row = snapshot.delivery;
  const parsed = manifestSchema.safeParse(snapshot.manifest);
  invariant(parsed.success);
  const asset = parsed.data;
  invariant(asset.workspaceId === row.workspaceId && asset.ticketId === row.ticketId
    && asset.id === row.pinnedAssetId && asset.scopeVersionId === row.scopeVersionId
    && sameSet(asset.issueRevisionIds, row.issueRevisionIds) && asset.files.length <= policy.maxFiles);
  const ids = new Set<string>();
  const objects = new Set<string>();
  let totalBytes = 0;
  for (const file of asset.files) {
    const objectIdentity = JSON.stringify([file.object.key, file.object.version]);
    invariant(file.workspaceId === asset.workspaceId && file.ticketId === asset.ticketId && file.pinnedAssetId === asset.id
      && file.scan.sha256 === file.sha256 && file.byteLength <= policy.maxFileBytes
      && !ids.has(file.id) && !objects.has(objectIdentity));
    ids.add(file.id); objects.add(objectIdentity); totalBytes += file.byteLength;
  }
  invariant(Number.isSafeInteger(totalBytes) && totalBytes <= policy.maxTotalBytes);
  return {
    delivery: { workspaceId: row.workspaceId, ticketId: row.ticketId, id: row.id, scopeVersionId: row.scopeVersionId,
      pinnedAssetId: row.pinnedAssetId, issueRevisionIds: [...row.issueRevisionIds], immutable: true, clientVisible: true,
      publicSummary: row.publicSummary, sharedAt: row.sharedAt },
    manifest: asset,
  };
}

/** No object keys, URLs, scanner detail, repository, PM or internal Issue IDs. */
export function verifyTicketDeliverySnapshot(
  ticket: LockedTicket, deliveryId: string, snapshot: TicketDeliverySnapshot | null, policy: TicketDeliveryReadPolicy,
): { manifest: TicketDeliveryManifest; snapshot: TicketDeliverySnapshot } {
  assertTicketActor(ticket.state, ticket.actor);
  const current = ticket.state.delivery;
  if (!current || current.id !== deliveryId || (ticket.actor.kind === 'client' && !current.shared) || !snapshot) {
    throw new TicketWorkflowError(404, 'ticket_delivery_not_found', 'Shared result not found.');
  }
  const row = snapshot.delivery;
  invariant(row && row.workspaceId === ticket.state.workspaceId && row.ticketId === ticket.state.id
    && row.id === current.id && row.scopeVersionId === current.scopeVersionId
    && row.pinnedAssetId === current.pinnedAssetId && row.immutable === true && row.clientVisible === true
    && id.safeParse(current.assessedByPmId).success
    && current.scopeVersionId === ticket.state.scopeVersionId
    && current.scopeVersionId === ticket.state.agreedScopeVersionId
    && current.scopeVersionId === ticket.state.authorizedScopeVersionId
    && sameSet(row.issueRevisionIds, current.issueRevisionIds)
    && (!current.shared || (typeof row.sharedAt === 'string' && Number.isFinite(Date.parse(row.sharedAt)))));
  const verified = verifyPrivateBundle(snapshot, policy);
  return {
    snapshot: verified,
    manifest: { deliveryId: row.id, scopeVersionId: row.scopeVersionId,
      files: verified.manifest.files.map(file => ({ id: file.id, filename: file.filename, mediaType: file.mediaType,
        byteLength: file.byteLength, sha256: file.sha256 })) },
  };
}
