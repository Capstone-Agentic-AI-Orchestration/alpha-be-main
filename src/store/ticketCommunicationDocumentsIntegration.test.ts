import { randomUUID } from 'node:crypto';
import { createTicketClientActivationService } from '../services/ticketClientActivationService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketClientSessionService } from '../services/ticketClientSessionService.js';
import { createTicketCommunicationNotificationService } from '../services/ticketCommunicationNotificationService.js';
import { createTicketDocumentService } from '../services/ticketDocumentService.js';
import { createTicketInvitationService } from '../services/ticketInvitationService.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createClientTicketInvitationSecretProtector } from '../ticketing/clientTicketSecrets.js';
import { PostgresTicketClientActivationStore } from './ticketClientActivationPostgresStore.js';
import { PostgresTicketClientSessionStore } from './ticketClientSessionPostgresStore.js';
import { PostgresTicketCommunicationNotificationStore } from './ticketCommunicationNotificationStore.js';
import { PostgresTicketDocumentStore } from './ticketDocumentPostgresStore.js';
import { PostgresTicketInvitationStore } from './ticketInvitationPostgresStore.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import { PostgresTicketTriageStore } from './ticketTriagePostgresStore.js';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

const workspaceId = 'ticket-communication-e2e-workspace';
const clientId = 'ticket-communication-e2e-client';
const clientEmail = 'ticket-communication-e2e@example.test';
const pm: TicketSubject = { kind: 'internal', userId: 'ticket-communication-e2e-pm',
  authentication: { kind: 'verified_github_bearer', verificationId: 'ticket-communication-e2e-verification' } };
const providerCredential = 'synthetic-ticket-communication-provider-credential';
const sessionSecret = 'ticket-communication-e2e-session-secret-with-sufficient-entropy';

let pg: PGlite;
let db: TransactionalSql;
let ticketNumber = 0;

function inquiryService(target: TicketTarget, now: Date) {
  return createTicketPublicIntakeService(new PostgresTicketPublicIntakeStore(db), {
    async admitRequest(entry) {
      return { entryId: entry.id, rateSubjectKey: 'e'.repeat(64), issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    },
  }, { fingerprintKeys: [{ id: 'ticket-communication-e2e-key', secret: new Uint8Array(32).fill(33) }], maxRequestAgeMs: 60_000 },
  () => now, () => target.ticketId);
}

async function submitInquiry(target: TicketTarget, now: Date) {
  await inquiryService(target, now).submit('ticket-communication-e2e-entry', {
    schemaVersion: 1, operationId: randomUUID(), fullName: 'Synthetic Client', email: clientEmail,
    company: null, title: `Synthetic inquiry ${target.ticketId}`,
    description: 'A synthetic end-to-end regression scenario. No production data or email is used.', requestedDeadline: null,
  }, { origin: 'https://tickets.example.test', remoteAddress: '192.0.2.35' });
}

async function currentVersion(target: TicketTarget): Promise<number> {
  const { rows } = await db.query<{ version: number }>(
    'select version::int as version from alpha_private.tickets where workspace_id=$1 and id=$2',
    [target.workspaceId, target.ticketId],
  );
  if (!rows[0]) throw new Error('Synthetic ticket missing');
  return rows[0].version;
}

beforeAll(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(async tx => work(sqlFor(tx as unknown as PGlite))) };
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json)
    values ($1,'Synthetic ticket communication E2E','ticket-communication-e2e','active','{"ticketing_write_mode":"enabled"}')`, [workspaceId]);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role)
    values ('ticket-communication-e2e-member',$1,$2,'pm')`, [workspaceId, pm.userId]);
  await db.query(`insert into alpha_private.ticket_intake_entries
    (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds)
    values ('ticket-communication-e2e-entry',$1,'ticket-communication-e2e-entry','Synthetic',true,'enabled','v1',100,100,60)`, [workspaceId]);
}, 60_000);

afterAll(async () => { await pg?.close(); });

describe('Client and PM message/document flow', () => {
  it('keeps conversations and files private to the activated ticket and sends generic client notices', async () => {
    // Keep incremented, deterministic message timestamps behind the real
    // notification worker clock so both durable events are immediately due.
    const now = new Date(Date.now() - 10_000);
    const target = { workspaceId, ticketId: `ticket-communication-e2e-ticket-${++ticketNumber}` };
    const unrelated = { workspaceId, ticketId: `ticket-communication-e2e-ticket-${++ticketNumber}` };
    await submitInquiry(target, now);
    await submitInquiry(unrelated, now);
    await createTicketCommandService(new PostgresTicketTriageStore(db)).execute(target, pm, {
      schemaVersion: 1, operationId: 'ticket-communication-pm-review', expectedVersion: 0, command: { type: 'review' },
    });

    const invitations = createTicketInvitationService(new PostgresTicketInvitationStore(db),
      { lifetimeMs: 60 * 60 * 1000 }, createClientTicketInvitationSecretProtector(sessionSecret).invitation, () => now);
    const secrets = createClientTicketInvitationSecretProtector(sessionSecret);
    const issued = await invitations.issue(target, pm);
    const { rows: outbox } = await db.query<{ payload: { protectedToken: string } }>(
      `select payload from alpha_private.ticket_outbox_events where workspace_id=$1 and ticket_id=$2
       and payload->>'activationVersion'='1'`, [workspaceId, target.ticketId],
    );
    const protectedToken = outbox[0]?.payload.protectedToken;
    if (!protectedToken) throw new Error('Synthetic invitation outbox event missing');
    const invitationToken = secrets.invitation.unprotect(protectedToken, {
      workspaceId, ticketId: target.ticketId, invitationId: issued.invitationId, expiresAt: issued.expiresAt,
    });
    const identity = { userId: clientId, email: clientEmail, emailVerified: true };
    const verifier = { async verifyCredential(value: string) { return value === providerCredential ? identity : null; } };
    await createTicketClientActivationService(new PostgresTicketClientActivationStore(db), verifier, () => now)
      .activate({ invitationToken, providerCredential });
    const sessions = createTicketClientSessionService(new PostgresTicketClientSessionStore(db), verifier,
      { lifetimeMs: 60 * 60 * 1000 }, () => now);
    const session = await sessions.exchange(providerCredential);
    expect(session).not.toBeNull();
    const check = await sessions.authenticate(session!.sessionCookieValue);
    expect(check.kind).toBe('authenticated');
    if (check.kind !== 'authenticated') throw new Error('Synthetic client session missing');
    const client = check.subject;

    let messageTime = new Date(now);
    const messages = createTicketMessageService(new PostgresTicketTriageStore(db, { communicationEnabled: true }), () => {
      const instant = new Date(messageTime);
      messageTime = new Date(messageTime.getTime() + 1_000);
      return instant;
    });
    const clientReply = await messages.reply(target, client, {
      schemaVersion: 1, operationId: 'ticket-communication-client-message', expectedVersion: await currentVersion(target),
      body: 'Synthetic client reply; private to this ticket.',
    });
    await expect(messages.lookup(target, client, 'ticket-communication-client-message')).resolves.toEqual(clientReply);
    await messages.reply(target, pm, {
      schemaVersion: 1, operationId: 'ticket-communication-pm-message', expectedVersion: await currentVersion(target),
      body: 'Synthetic PM update; not included in the email notification.',
    });
    await messages.note(target, pm, {
      schemaVersion: 1, operationId: 'ticket-communication-private-note', expectedVersion: await currentVersion(target),
      body: 'Synthetic PM-only note must never be visible to the client.',
    });

    const objects = new Map<string, Uint8Array>();
    const documents = createTicketDocumentService(new PostgresTicketDocumentStore(db), {
      async put(path, bytes) { objects.set(path, new Uint8Array(bytes)); },
      async get(path) { const bytes = objects.get(path); if (!bytes) throw new Error('Missing object'); return new Uint8Array(bytes); },
    });
    const clientFile = Buffer.from('client follow-up document\n');
    const uploaded = await documents.upload(target, client, {
      operationId: 'ticket-communication-client-document', filename: 'client-note.txt', contentType: 'text/plain', bytes: clientFile,
    });
    const replacementFile = Buffer.from('client follow-up document v2\n');
    const replacement = await documents.upload(target, client, {
      operationId: 'ticket-communication-client-document-v2', replacesDocumentId: uploaded.id,
      filename: 'client-note.txt', contentType: 'text/plain', bytes: replacementFile,
    });
    expect(replacement).toMatchObject({ groupId: uploaded.groupId, version: 2,
      replacesDocumentId: uploaded.id, author: 'client', changeProposed: true, status: 'available' });
    await expect(documents.upload(target, pm, {
      operationId: 'ticket-communication-pm-document', filename: 'private-brief.pdf', contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7\nPM shared document\n'),
    })).rejects.toMatchObject({ status: 403, code: 'ticket_action_forbidden' });
    expect(await documents.list(target, client)).toEqual([uploaded, replacement]);
    expect(await documents.list(target, pm)).toEqual([uploaded, replacement]);
    expect(Array.from((await documents.download(target, pm, uploaded.id)).bytes)).toEqual(Array.from(clientFile));
    expect(Array.from((await documents.download(target, pm, replacement.id)).bytes)).toEqual(Array.from(replacementFile));
    await expect(documents.list(unrelated, client)).rejects.toMatchObject({ status: 404 });
    await expect(documents.download(target, client, 'unknown-document')).rejects.toMatchObject({ status: 404 });

    const reads = createTicketReadService(new PostgresTicketReadStore(db));
    const clientConversation = await reads.conversation(target, client);
    expect(clientConversation.items.map(item => item.body)).toEqual([
      'Synthetic client reply; private to this ticket.', 'Synthetic PM update; not included in the email notification.',
    ]);
    await expect(reads.notes(target, client)).rejects.toMatchObject({ status: 403 });
    const privateNotes = await reads.notes(target, pm);
    expect(privateNotes.items.map(item => item.body)).toContain('Synthetic PM-only note must never be visible to the client.');

    const sendContent = vi.fn(async (_to: string, _subject: string, _body: string, _key: string) => undefined);
    const notifications = createTicketCommunicationNotificationService(
      new PostgresTicketCommunicationNotificationStore(db),
      { identity: 'ticket-communication-synthetic-provider', canSendTo: () => true, send: async () => undefined, sendContent },
      'https://tickets.example.test',
    );
    const queued = await db.query<{ notification_kind: string; status: string }>(
      'select notification_kind,status from alpha_private.ticket_communication_notifications where workspace_id=$1 and ticket_id=$2 order by notification_kind',
      [workspaceId, target.ticketId],
    );
    expect(queued.rows).toEqual([{ notification_kind: 'message', status: 'pending' }]);
    await expect(notifications.deliverNext()).resolves.toBe('delivered');
    const afterFirst = await db.query<{ notification_kind: string; status: string; available_at: string }>(
      'select notification_kind,status,available_at::text as available_at from alpha_private.ticket_communication_notifications where workspace_id=$1 and ticket_id=$2 order by notification_kind',
      [workspaceId, target.ticketId],
    );
    expect(afterFirst.rows.map(({ notification_kind, status }) => ({ notification_kind, status })))
      .toEqual([{ notification_kind: 'message', status: 'delivered' }]);
    expect(Date.parse(afterFirst.rows[0].available_at)).toBeLessThanOrEqual(Date.now());
    await expect(notifications.deliverNext()).resolves.toBe('idle');
    expect(sendContent).toHaveBeenCalledTimes(1);
    for (const [, subject, body] of sendContent.mock.calls) {
      expect(subject).not.toContain(target.ticketId);
      expect(body).toContain('https://tickets.example.test/#/client');
      expect(body).not.toContain('Synthetic PM update');
      expect(body).not.toContain('Synthetic PM-only note');
    }
  }, 60_000);
});
