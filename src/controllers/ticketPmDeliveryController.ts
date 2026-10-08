import { Router } from 'express';

import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketDeliveryContent } from '../services/ticketDeliveryService.js';
import { projectTicketDeliveryFile, projectTicketDeliveryManifest, type TicketDeliveryManifest } from '../ticketing/deliveryReadModels.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

export interface TicketPmDeliveryApplication {
  manifest(target: TicketTarget, subject: TicketSubject, deliveryId: string): Promise<TicketDeliveryManifest>;
  content(target: TicketTarget, subject: TicketSubject, deliveryId: string, fileId: string): Promise<TicketDeliveryContent>;
}

/** The existing desktop relay forwards JSON. This narrowly scoped inspection
 * envelope preserves that transport, not a second storage service or URL bypass.
 * Content is already capped and digest-verified by the common delivery service.
 * Base64 adds ~1/3 transfer overhead; large/app previews need separate handling.
 */
export function createTicketPmDeliveryRouter(application: TicketPmDeliveryApplication, namespace: 'deliveries' | 'delivery-candidates' = 'deliveries'): Router {
  const router = Router();
  const path = `/:ticketId/${namespace}/:deliveryId`;
  for (const content of [false, true]) router.get(content ? `${path}/files/:fileId/content` : path, route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (await relayPmTicketRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    const deliveryId = req.params.deliveryId ?? '';
    const fileId = req.params.fileId ?? '';
    if (!req.workspace || !opaqueTicketRequestValue(ticketId) || !opaqueTicketRequestValue(deliveryId)
      || (content && !opaqueTicketRequestValue(fileId))) return res.status(404).json({ error: 'Shared result not found.' });
    const target = { workspaceId: req.workspace.workspaceId, ticketId };
    if (!content) {
      const value = projectTicketDeliveryManifest(await application.manifest(target, subject, deliveryId));
      if (value.deliveryId !== deliveryId) throw new TicketReadInvariantError();
      return res.json(value);
    }
    const value = await application.content(target, subject, deliveryId, fileId);
    const file = projectTicketDeliveryFile(value?.file);
    if (file.id !== fileId || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== file.byteLength) throw new TicketReadInvariantError();
    return res.json({ file, bytesBase64: Buffer.from(value.bytes).toString('base64') });
  }));
  return router;
}
