import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTicketDocumentService } from '../services/ticketDocumentService.js';
import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { PostgresTicketDocumentStore } from './ticketDocumentPostgresStore.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';

const workspaceId = 'ticket-communication-docs-workspace';
const pm: TicketSubject = { kind: 'internal', userId: 'ticket-communication-docs-pm',
  authentication: { kind: 'verified_github_bearer', verificationId: 'ticket-communication-docs-test-session' } };
const fixedNow = new Date('2026-10-12T08:00:00.000Z');

let pg: PGlite;
let db: TransactionalSql;
let ticketNumber = 0;
const objectBytes = new Map<string, Uint8Array>();
const putObject = vi.fn(async (path: string, bytes: Uint8Array) => { objectBytes.set(path, new Uint8Array(bytes)); });
const getObject = vi.fn(async (path: string) => {
  const bytes = objectBytes.get(path);
  if (!bytes) throw new Error('Object missing');
  return new Uint8Array(bytes);
});

function intake(ticketId: string) {
  return createTicketPublicIntakeService(new PostgresTicketPublicIntakeStore(db), {
    async admitRequest(entry) {
      return { entryId: entry.id, rateSubjectKey: 'd'.repeat(64), issuedAt: fixedNow.toISOString(),
        expiresAt: new Date(fixedNow.getTime() + 60_000).toISOString() };
    },
  }, { fingerprintKeys: [{ id: 'ticket-communication-test-key', secret: new Uint8Array(32).fill(21) }], maxRequestAgeMs: 60_000 },
  () => fixedNow, () => ticketId);
}

async function submitTicket(): Promise<TicketTarget> {
  const target = { workspaceId, ticketId: `ticket-communication-doc-ticket-${++ticketNumber}` };
  await intake(target.ticketId).submit('ticket-communication-doc-entry', {
    schemaVersion: 1, operationId: randomUUID(), fullName: 'Synthetic Client',
    email: 'ticket-communication-client@example.test', company: null, title: 'Synthetic document request',
    description: 'A synthetic request used only by the PostgreSQL regression suite.', requestedDeadline: null,
  }, { origin: 'https://tickets.example.test', remoteAddress: '192.0.2.18' });
  return target;
}

beforeAll(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(async tx => work(sqlFor(tx as unknown as PGlite))) };
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json)
    values ($1,'Synthetic ticket communication','ticket-communication-docs','active','{"ticketing_write_mode":"enabled"}')`, [workspaceId]);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role)
    values ('ticket-communication-docs-member',$1,$2,'pm')`, [workspaceId, pm.userId]);
  await db.query(`insert into alpha_private.ticket_intake_entries
    (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds)
    values ('ticket-communication-doc-entry',$1,'ticket-communication-doc-entry','Synthetic',true,'enabled','v1',100,100,60)`, [workspaceId]);
}, 60_000);

afterAll(async () => { await pg?.close(); objectBytes.clear(); });
beforeEach(() => { objectBytes.clear(); putObject.mockClear(); getObject.mockClear(); });

describe('Private ticket documents on PostgreSQL', () => {
  it('rejects PM uploads before checking file content or touching private storage', async () => {
    const target = await submitTicket();
    const documents = createTicketDocumentService(new PostgresTicketDocumentStore(db), { put: putObject, get: getObject });
    await expect(documents.upload(target, pm, {
      operationId: 'ticket-communication-pm-html-spoof', filename: 'payload.pdf', contentType: 'application/pdf',
      bytes: Buffer.from('<html>not a PDF</html>'),
    })).rejects.toMatchObject({ status: 403 });
    await expect(documents.upload(target, pm, {
      operationId: 'ticket-communication-pm-path-traversal', filename: '../private.pdf', contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7\ncontent'),
    })).rejects.toMatchObject({ status: 403 });
    await expect(documents.upload(target, pm, {
      operationId: 'ticket-communication-pm-too-large', filename: 'large.pdf', contentType: 'application/pdf',
      bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
    })).rejects.toMatchObject({ status: 403 });
    expect(putObject).not.toHaveBeenCalled();
    expect((await db.query<{ count: number }>(
      'select count(*)::int as count from alpha_private.ticket_documents where workspace_id=$1 and ticket_id=$2',
      [workspaceId, target.ticketId],
    )).rows[0].count).toBe(0);
  }, 60_000);

  it('creates only the bounded private Storage bucket required by server-proxied uploads', async () => {
    const { rows } = await db.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      "select public,file_size_limit::int as file_size_limit,allowed_mime_types from storage.buckets where id='alpha-ticket-documents'",
    );
    expect(rows).toEqual([{ public: false, file_size_limit: 10 * 1024 * 1024,
      allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv'] }]);
  });
});
