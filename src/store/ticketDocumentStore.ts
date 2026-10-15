import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';

export type TicketDocumentAuthor = 'pm' | 'client';
export type TicketDocumentStatus = 'pending' | 'available';

export interface TicketDocument {
  id: string;
  groupId: string;
  version: number;
  replacesDocumentId: string | null;
  author: TicketDocumentAuthor;
  filename: string;
  contentType: string;
  byteLength: number;
  changeProposed: boolean;
  status: TicketDocumentStatus;
  createdAt: string;
  availableAt: string | null;
}

export interface PreparedTicketDocument extends TicketDocument {
  workspaceId: string;
  ticketId: string;
  authorId: string;
  fingerprint: string;
  sha256: string;
  storagePath: string;
}

export interface TicketDocumentUpload {
  operationId: string;
  replacesDocumentId: string | null;
  filename: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  fingerprint: string;
}

export interface TicketDocumentStore {
  list(target: TicketTarget, subject: TicketSubject): Promise<TicketDocument[]>;
  prepareUpload(target: TicketTarget, subject: TicketSubject, input: TicketDocumentUpload): Promise<PreparedTicketDocument>;
  markAvailable(target: TicketTarget, subject: TicketSubject, documentId: string, fingerprint: string): Promise<PreparedTicketDocument>;
  getDownload(target: TicketTarget, subject: TicketSubject, documentId: string): Promise<PreparedTicketDocument | null>;
}

export interface TicketDocumentObjectStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}
