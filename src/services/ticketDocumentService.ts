import { createHash, randomUUID } from 'node:crypto';

import type { TicketDocument, TicketDocumentStore, TicketDocumentObjectStore } from '../store/ticketDocumentStore.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

export const MAX_TICKET_DOCUMENT_BYTES = 10 * 1024 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export interface TicketDocumentUploadInput {
  operationId: string;
  replacesDocumentId?: string | null;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export class TicketDocumentStorageError extends Error {
  constructor() { super('Ticket document storage is temporarily unavailable.'); this.name = 'TicketDocumentStorageError'; }
}

function fail(status: 400 | 404 | 409 | 503, code: string, message: string): never {
  throw new TicketWorkflowError(status, code, message);
}

function normalizeFilename(value: unknown): string {
  if (typeof value !== 'string') return fail(400, 'invalid_ticket_document', 'Choose a supported file.');
  const filename = value.normalize('NFC').trim();
  if (!filename || filename.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(filename)
    || filename === '.' || filename === '..') {
    return fail(400, 'invalid_ticket_document', 'The file name is not allowed. Rename the file and try again.');
  }
  return filename;
}

function fileType(filename: string, claimed: string, bytes: Uint8Array): string {
  const lower = filename.toLowerCase();
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) {
    if (!lower.endsWith('.pdf') || (claimed && claimed !== 'application/pdf')) return fail(400, 'unsupported_ticket_document', 'The file content and file type do not match.');
    return 'application/pdf';
  }
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    if (!lower.endsWith('.png') || (claimed && claimed !== 'image/png')) return fail(400, 'unsupported_ticket_document', 'The file content and file type do not match.');
    return 'image/png';
  }
  if (starts(0xff, 0xd8, 0xff)) {
    if (!(lower.endsWith('.jpg') || lower.endsWith('.jpeg')) || (claimed && claimed !== 'image/jpeg')) return fail(400, 'unsupported_ticket_document', 'The file content and file type do not match.');
    return 'image/jpeg';
  }
  if (!/\.(txt|csv)$/i.test(filename) || (claimed && !['text/plain', 'text/csv', 'application/vnd.ms-excel'].includes(claimed))) {
    return fail(400, 'unsupported_ticket_document', 'Only PDF, PNG, JPEG, plain-text, and CSV attachments are supported.');
  }
  let text: string;
  try { text = textDecoder.decode(bytes); }
  catch { return fail(400, 'unsupported_ticket_document', 'The text file must use UTF-8 encoding.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return fail(400, 'unsupported_ticket_document', 'The text file contains unsupported control characters.');
  }
  return lower.endsWith('.csv') ? 'text/csv' : 'text/plain';
}

function cleanInput(input: TicketDocumentUploadInput) {
  if (!input || typeof input !== 'object' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.operationId)
    || (input.replacesDocumentId !== undefined && input.replacesDocumentId !== null
      && (typeof input.replacesDocumentId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.replacesDocumentId)))
    || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_TICKET_DOCUMENT_BYTES) {
    return fail(400, 'invalid_ticket_document', 'Choose a supported file up to 10 MB.');
  }
  const filename = normalizeFilename(input.filename);
  const contentType = fileType(filename, typeof input.contentType === 'string' ? input.contentType.split(';', 1)[0].trim().toLowerCase() : '', input.bytes);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'alpha-ticket-document-v1', input.operationId, input.replacesDocumentId ?? null,
    filename, contentType, input.bytes.byteLength, sha256,
  ])).digest('hex');
  return { operationId: input.operationId, replacesDocumentId: input.replacesDocumentId ?? null,
    filename, contentType, bytes: input.bytes, byteLength: input.bytes.byteLength, sha256, fingerprint };
}

function publicRecord(record: TicketDocument): TicketDocument {
  return {
    id: record.id, groupId: record.groupId, version: record.version,
    replacesDocumentId: record.replacesDocumentId, author: record.author,
    filename: record.filename, contentType: record.contentType, byteLength: record.byteLength,
    changeProposed: record.changeProposed, status: record.status,
    createdAt: record.createdAt, availableAt: record.availableAt,
  };
}

export function createTicketDocumentService(store: TicketDocumentStore, objects: TicketDocumentObjectStore) {
  return {
    list(target: TicketTarget, subject: TicketSubject) {
      return store.list(target, subject).then(items => items.map(publicRecord));
    },
    async upload(target: TicketTarget, subject: TicketSubject, raw: TicketDocumentUploadInput): Promise<TicketDocument> {
      if (subject.kind !== 'client') {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only the client can upload documents to this ticket.');
      }
      const input = cleanInput(raw);
      const prepared = await store.prepareUpload(target, subject, input);
      if (prepared.status === 'available') return publicRecord(prepared);
      try {
        await objects.put(prepared.storagePath, input.bytes, input.contentType);
        const downloaded = await objects.get(prepared.storagePath);
        if (downloaded.byteLength !== input.byteLength
          || createHash('sha256').update(downloaded).digest('hex') !== input.sha256) throw new TicketDocumentStorageError();
      } catch {
        throw new TicketWorkflowError(503, 'ticket_document_storage_unavailable', 'The upload could not be confirmed. Retry the same file from this ticket.');
      }
      return publicRecord(await store.markAvailable(target, subject, prepared.id, input.fingerprint));
    },
    async download(target: TicketTarget, subject: TicketSubject, documentId: string) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(documentId)) return fail(404, 'ticket_document_not_found', 'Document not found.');
      const record = await store.getDownload(target, subject, documentId);
      if (!record) return fail(404, 'ticket_document_not_found', 'Document not found.');
      let bytes: Uint8Array;
      try { bytes = await objects.get(record.storagePath); }
      catch { return fail(503, 'ticket_document_storage_unavailable', 'The document is temporarily unavailable.'); }
      if (bytes.byteLength !== record.byteLength || createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
        return fail(503, 'ticket_document_integrity_failure', 'The document could not be verified. Contact your project manager.');
      }
      return { document: publicRecord(record), bytes };
    },
  };
}

export function newTicketDocumentOperationId(): string { return randomUUID(); }
