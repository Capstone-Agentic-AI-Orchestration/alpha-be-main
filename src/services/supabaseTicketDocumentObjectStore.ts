import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { TicketDocumentObjectStore } from '../store/ticketDocumentStore.js';
import { MAX_TICKET_DOCUMENT_BYTES, TicketDocumentStorageError } from './ticketDocumentService.js';

export const TICKET_DOCUMENT_BUCKET = 'alpha-ticket-documents';

/** Server-only adapter. The bucket is private and callers receive bytes, never Storage URLs. */
export class SupabaseTicketDocumentObjectStore implements TicketDocumentObjectStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    if (!/^https:\/\//.test(url) || !serviceRoleKey.trim()) throw new Error('Private ticket document storage is not configured.');
    this.client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!safePath(path) || bytes.byteLength < 1 || bytes.byteLength > MAX_TICKET_DOCUMENT_BYTES) throw new TicketDocumentStorageError();
    const { error } = await this.client.storage.from(TICKET_DOCUMENT_BUCKET).upload(path, Buffer.from(bytes), {
      contentType, cacheControl: '0', upsert: true,
    });
    if (error) throw new TicketDocumentStorageError();
  }

  async get(path: string): Promise<Uint8Array> {
    if (!safePath(path)) throw new TicketDocumentStorageError();
    const { data, error } = await this.client.storage.from(TICKET_DOCUMENT_BUCKET).download(path);
    if (error || !data) throw new TicketDocumentStorageError();
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_TICKET_DOCUMENT_BYTES) throw new TicketDocumentStorageError();
    return bytes;
  }
}

function safePath(path: string): boolean {
  return typeof path === 'string' && path.length <= 620
    && path.split('/').length === 3
    && path.split('/').every(segment => /^[A-Za-z0-9_-]{1,200}$/.test(segment));
}
