import { createHash } from 'node:crypto';

import type { TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketDeliveryObjectReader, TicketDeliveryReadPolicy, TicketDeliverySnapshot } from '../store/ticketDeliveryStore.js';
import type { TicketDeliveryFile, TicketDeliveryManifest } from '../ticketing/deliveryReadModels.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

export interface TicketDeliveryContent { file: TicketDeliveryFile; bytes: Uint8Array }
export interface VerifiedTicketDelivery { manifest: TicketDeliveryManifest; snapshot: TicketDeliverySnapshot }

/** Shared by published-result and PM-only candidate inspection. The caller's
 * inspect function owns authorization/stage checks before AND after storage I/O.
 */
export async function readVerifiedTicketDeliveryContent(
  target: TicketTarget, fileId: string, initial: VerifiedTicketDelivery,
  inspectFresh: () => Promise<VerifiedTicketDelivery>, objects: TicketDeliveryObjectReader, policy: TicketDeliveryReadPolicy,
): Promise<TicketDeliveryContent> {
  const file = initial.snapshot.manifest.files.find(candidate => candidate.id === fileId);
  if (!file) throw new TicketWorkflowError(404, 'ticket_delivery_not_found', 'Shared result not found.');
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let bytes: Uint8Array;
  try {
    const unavailable = () => new TicketWorkflowError(503, 'ticket_delivery_unavailable', 'The shared result is unavailable. Try again later.');
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(unavailable()); }, policy.objectReadTimeoutMs);
    });
    const body = await Promise.race([objects.read({ ...target, pinnedAssetId: initial.snapshot.manifest.id,
      fileId: file.id, key: file.object.key, version: file.object.version, maxBytes: file.byteLength, signal: controller.signal }), deadline]);
    if (!(body instanceof Uint8Array) || body.byteLength !== file.byteLength) throw unavailable();
    bytes = Buffer.from(body);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw unavailable();
  } catch {
    controller.abort();
    throw new TicketWorkflowError(503, 'ticket_delivery_unavailable', 'The shared result is unavailable. Try again later.');
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
  const fresh = await inspectFresh();
  if (JSON.stringify(fresh.snapshot) !== JSON.stringify(initial.snapshot)) throw new TicketReadInvariantError();
  return { file: fresh.manifest.files.find(candidate => candidate.id === fileId)!, bytes };
}
