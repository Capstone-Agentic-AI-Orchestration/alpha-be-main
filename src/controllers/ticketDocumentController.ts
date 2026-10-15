import type { Request, Response } from 'express';

import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketDocument } from '../store/ticketDocumentStore.js';
import type { TicketDocumentUploadInput } from '../services/ticketDocumentService.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { opaqueTicketRequestValue } from './ticketRequestAuth.js';

export interface TicketDocumentsApplication {
  list(target: TicketTarget, subject: TicketSubject): Promise<TicketDocument[]>;
  upload(target: TicketTarget, subject: TicketSubject, input: TicketDocumentUploadInput): Promise<TicketDocument>;
  download(target: TicketTarget, subject: TicketSubject, id: string): Promise<{ document: TicketDocument; bytes: Uint8Array }>;
}

export function secureTicketDocumentResponse(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export function parseTicketDocumentMetadata(req: Request): Omit<TicketDocumentUploadInput, 'bytes'> | null {
  const raw = req.get('X-Alpha-Ticket-Document');
  if (!raw || raw.length > 2048) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(decodeURIComponent(raw)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.operationId !== 'string' || !opaqueTicketRequestValue(value.operationId)
    || typeof value.filename !== 'string' || value.filename.length > 200
    || typeof value.contentType !== 'string' || value.contentType.length > 100
    || (value.replacesDocumentId !== undefined && value.replacesDocumentId !== null
      && (typeof value.replacesDocumentId !== 'string' || !opaqueTicketRequestValue(value.replacesDocumentId)))) return null;
  return {
    operationId: value.operationId,
    filename: value.filename,
    contentType: value.contentType,
    ...(value.replacesDocumentId === undefined ? {} : { replacesDocumentId: value.replacesDocumentId as string | null }),
  };
}

export function safeTicketDocuments(items: TicketDocument[]): TicketDocument[] {
  if (!Array.isArray(items) || items.length > 500) throw new TicketReadInvariantError();
  const ids = new Set<string>();
  return items.map(item => {
    if (!item || !opaqueTicketRequestValue(item.id) || !opaqueTicketRequestValue(item.groupId)
      || !Number.isSafeInteger(item.version) || item.version < 1
      || (item.replacesDocumentId !== null && !opaqueTicketRequestValue(item.replacesDocumentId))
      || !['pm', 'client'].includes(item.author) || typeof item.filename !== 'string' || !item.filename.trim()
      || item.filename.length > 200 || !['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv'].includes(item.contentType)
      || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 10 * 1024 * 1024
      || typeof item.changeProposed !== 'boolean' || !['pending', 'available'].includes(item.status)
      || !Number.isFinite(Date.parse(item.createdAt))
      || (item.availableAt !== null && !Number.isFinite(Date.parse(item.availableAt)))
      || ids.has(item.id)) {
      throw new TicketReadInvariantError();
    }
    ids.add(item.id);
    return {
      id: item.id, groupId: item.groupId, version: item.version,
      replacesDocumentId: item.replacesDocumentId, author: item.author,
      filename: item.filename, contentType: item.contentType, byteLength: item.byteLength,
      changeProposed: item.changeProposed, status: item.status,
      createdAt: item.createdAt, availableAt: item.availableAt,
    };
  });
}

export function sendTicketDocument(res: Response, result: { document: TicketDocument; bytes: Uint8Array }): void {
  const { document, bytes } = result;
  if (!document || document.status !== 'available' || bytes.byteLength !== document.byteLength) throw new TicketReadInvariantError();
  const encoded = encodeURIComponent(document.filename).replace(/[!'()*]/g,
    value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="ticket-document"; filename*=UTF-8''${encoded}`);
  res.setHeader('Content-Length', bytes.byteLength);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.status(200).end(Buffer.from(bytes));
}
