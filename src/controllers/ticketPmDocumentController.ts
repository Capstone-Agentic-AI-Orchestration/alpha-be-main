import { Router } from 'express';
import type { Request, Response } from 'express';

import type { TicketDocumentsApplication } from './ticketDocumentController.js';
import { parseTicketDocumentMetadata, safeTicketDocuments, secureTicketDocumentResponse, sendTicketDocument } from './ticketDocumentController.js';
import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

/** PM document routes retain the existing workspace/session and desktop-to-cloud relay boundary. */
export function createTicketPmDocumentRouter(
  application: TicketDocumentsApplication,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
): Router {
  const router = Router();

  function target(req: Request, res: Response) {
    const workspaceId = req.workspace?.workspaceId;
    const ticketId = req.params.ticketId ?? '';
    if (!workspaceId || !opaqueTicketRequestValue(ticketId)) {
      res.status(404).json({ error: 'Ticket not found.' });
      return null;
    }
    return { workspaceId, ticketId };
  }

  router.get('/:ticketId/documents', route(async (req, res) => {
    secureTicketDocumentResponse(res);
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketTarget = target(req, res);
    if (!ticketTarget) return;
    return res.json({ items: safeTicketDocuments(await application.list(ticketTarget, subject)) });
  }));

  router.post('/:ticketId/documents', route(async (req, res) => {
    secureTicketDocumentResponse(res);
    if (await relayRequest(req, res, {
      ...(Buffer.isBuffer(req.body) ? { rawBody: req.body } : {}),
      ...(req.get('X-Alpha-Ticket-Document')
        ? { headers: { 'X-Alpha-Ticket-Document': req.get('X-Alpha-Ticket-Document')! } } : {}),
    })) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketTarget = target(req, res);
    if (!ticketTarget) return;
    const metadata = parseTicketDocumentMetadata(req);
    if (!metadata || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Choose a supported document.' });
    const document = await application.upload(ticketTarget, subject, { ...metadata, bytes: req.body });
    return res.json(safeTicketDocuments([document])[0]);
  }));

  router.get('/:ticketId/documents/:documentId/content', route(async (req, res) => {
    secureTicketDocumentResponse(res);
    if (await relayRequest(req, res, { responseType: 'bytes' })) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketTarget = target(req, res);
    const documentId = req.params.documentId ?? '';
    if (!ticketTarget || !opaqueTicketRequestValue(documentId)) return res.status(404).json({ error: 'Document not found.' });
    sendTicketDocument(res, await application.download(ticketTarget, subject, documentId));
  }));

  return router;
}
