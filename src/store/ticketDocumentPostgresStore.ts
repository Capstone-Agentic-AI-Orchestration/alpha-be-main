import { randomUUID } from 'node:crypto';

import type { Sql, TransactionalSql } from './database.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';
import type { PreparedTicketDocument, TicketDocument, TicketDocumentStore, TicketDocumentUpload } from './ticketDocumentStore.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { ticketSqlIso, ticketWriteMode } from './ticketPostgresCodec.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

interface DocumentDbRow {
  id: string; workspace_id: string; ticket_id: string; document_group_id: string;
  version_number: number; replaces_document_id: string | null; author_kind: string; author_id: string;
  operation_id: string; fingerprint: string; original_filename: string; content_type: string;
  byte_length: number; sha256: string; storage_path: string; change_proposed: boolean;
  status: string; created_at: Date | string; available_at: Date | string | null;
}

const columns = `id,workspace_id,ticket_id,document_group_id,version_number,replaces_document_id,
  author_kind,author_id,operation_id,fingerprint,original_filename,content_type,byte_length,sha256,
  storage_path,change_proposed,status,created_at,available_at`;

function unavailable(): never {
  throw new TicketWorkflowError(503, 'ticket_document_unavailable', 'Ticket document intake is unavailable right now.');
}

function prepared(row: DocumentDbRow): PreparedTicketDocument {
  if (!row || !['pm', 'client'].includes(row.author_kind) || !['pending', 'available'].includes(row.status)
    || !Number.isSafeInteger(row.version_number) || !Number.isSafeInteger(row.byte_length)
    || !/^[a-f0-9]{64}$/.test(row.sha256.trim()) || !/^[a-f0-9]{64}$/.test(row.fingerprint.trim())
    || (row.status === 'available') !== (row.available_at !== null)) throw new TicketReadInvariantError();
  const record: PreparedTicketDocument = {
    id: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id, groupId: row.document_group_id,
    version: row.version_number, replacesDocumentId: row.replaces_document_id,
    author: row.author_kind as TicketDocument['author'], authorId: row.author_id,
    filename: row.original_filename, contentType: row.content_type, byteLength: row.byte_length,
    changeProposed: row.change_proposed, status: row.status as TicketDocument['status'],
    createdAt: ticketSqlIso(row.created_at), availableAt: row.available_at === null ? null : ticketSqlIso(row.available_at),
    fingerprint: row.fingerprint.trim(), sha256: row.sha256.trim(), storagePath: row.storage_path,
  };
  return record;
}

function listed(record: PreparedTicketDocument): TicketDocument {
  return {
    id: record.id, groupId: record.groupId, version: record.version,
    replacesDocumentId: record.replacesDocumentId, author: record.author,
    filename: record.filename, contentType: record.contentType, byteLength: record.byteLength,
    changeProposed: record.changeProposed, status: record.status,
    createdAt: record.createdAt, availableAt: record.availableAt,
  };
}

async function lockTicket(sql: Sql, target: TicketTarget, subject: TicketSubject, write: boolean) {
  const authorization = new PostgresTicketAuthorization(sql);
  let ticket = await authorization.lockTicket(target, subject, write ? 'update' : 'share');
  if (!ticket) throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
  if (write && subject.kind === 'client') {
    const { rows } = await sql.query<{ write_mode: string | null }>(
      `select settings_json->>'ticketing_write_mode' as write_mode
         from public.workspaces where id=$1 and status='active' for share`, [target.workspaceId],
    );
    ticket = { ...ticket, mode: ticketWriteMode(rows[0]?.write_mode) };
  }
  if (write && ticket.mode !== 'enabled') {
    throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
  }
  if (write && ['closed', 'declined', 'cancelled'].includes(ticket.state.status)) {
    throw new TicketWorkflowError(409, 'ticket_is_read_only', 'This ticket is read-only.');
  }
  return ticket;
}

async function getById(sql: Sql, target: TicketTarget, id: string): Promise<DocumentDbRow | null> {
  const { rows } = await sql.query<DocumentDbRow>(
    `select ${columns} from alpha_private.ticket_documents
      where workspace_id=$1 and ticket_id=$2 and id=$3`, [target.workspaceId, target.ticketId, id],
  );
  return rows[0] ?? null;
}

/** Metadata and authorization use the same cloud Postgres authority as tickets. */
export class PostgresTicketDocumentStore implements TicketDocumentStore {
  constructor(private readonly db: TransactionalSql) {}

  list(target: TicketTarget, subject: TicketSubject): Promise<TicketDocument[]> {
    return this.db.transaction(async sql => {
      await lockTicket(sql, target, subject, false);
      const visibility = subject.kind === 'internal'
        ? "author_kind='client' and status='available'"
        : "(status='available' or (author_kind=$3 and author_id=$4))";
      const params = subject.kind === 'internal'
        ? [target.workspaceId, target.ticketId]
        : [target.workspaceId, target.ticketId, 'client', subject.userId];
      const { rows } = await sql.query<DocumentDbRow>(
        `select ${columns} from alpha_private.ticket_documents
          where workspace_id=$1 and ticket_id=$2 and ${visibility}
          order by document_group_id collate "C", version_number, created_at, id collate "C"`,
        params,
      );
      if (rows.length > 500) throw new TicketReadInvariantError();
      // Operation IDs are transport-level retry keys; never expose them in a read model.
      return rows.map(row => listed(prepared(row)));
    });
  }

  prepareUpload(target: TicketTarget, subject: TicketSubject, input: TicketDocumentUpload): Promise<PreparedTicketDocument> {
    return this.db.transaction(async sql => {
      await lockTicket(sql, target, subject, true);
      if (subject.kind !== 'client') {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only the client can upload documents to this ticket.');
      }
      const authorKind = 'client' as const;
      const { rows: priorOperations } = await sql.query<DocumentDbRow>(
        `select ${columns} from alpha_private.ticket_documents
          where workspace_id=$1 and ticket_id=$2 and author_kind=$3 and author_id=$4 and operation_id=$5
          for update`,
        [target.workspaceId, target.ticketId, authorKind, subject.userId, input.operationId],
      );
      const prior = priorOperations[0];
      if (prior) {
        const record = prepared(prior);
        if (record.fingerprint !== input.fingerprint) {
          throw new TicketWorkflowError(409, 'ticket_operation_conflict', 'This upload request ID was already used for a different file.');
        }
        return record;
      }

      let groupId: string = randomUUID();
      let version = 1;
      let replacesDocumentId: string | null = null;
      if (input.replacesDocumentId) {
        const { rows: previousRows } = await sql.query<{ id: string; document_group_id: string; version_number: number }>(
          `select d.id,d.document_group_id,d.version_number from alpha_private.ticket_documents d
            where d.workspace_id=$1 and d.ticket_id=$2 and d.id=$3 and d.status='available'
              and not exists (
                select 1 from alpha_private.ticket_documents later
                 where later.workspace_id=d.workspace_id and later.ticket_id=d.ticket_id
                   and later.document_group_id=d.document_group_id and later.version_number>d.version_number
              )
            for update of d`,
          [target.workspaceId, target.ticketId, input.replacesDocumentId],
        );
        const previous = previousRows[0];
        if (!previous) throw new TicketWorkflowError(404, 'ticket_document_not_found', 'The document to replace is unavailable.');
        groupId = previous.document_group_id;
        version = previous.version_number + 1;
        replacesDocumentId = previous.id;
      }
      const id = randomUUID();
      const path = `${target.workspaceId}/${target.ticketId}/${id}`;
      const { rows } = await sql.query<DocumentDbRow>(
        `insert into alpha_private.ticket_documents
          (id,workspace_id,ticket_id,document_group_id,version_number,replaces_document_id,author_kind,author_id,
           operation_id,fingerprint,original_filename,content_type,byte_length,sha256,storage_path,change_proposed,
           status,created_at,available_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17,null)
         returning ${columns}`,
        [id, target.workspaceId, target.ticketId, groupId, version, replacesDocumentId, authorKind,
          subject.userId, input.operationId, input.fingerprint, input.filename, input.contentType,
          input.byteLength, input.sha256, path, version > 1, new Date().toISOString()],
      );
      if (!rows[0]) throw new Error('Could not reserve ticket document metadata.');
      return prepared(rows[0]);
    });
  }

  markAvailable(target: TicketTarget, subject: TicketSubject, documentId: string, fingerprint: string): Promise<PreparedTicketDocument> {
    return this.db.transaction(async sql => {
      const ticket = await lockTicket(sql, target, subject, true);
      if (subject.kind !== 'client') {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only the client can upload documents to this ticket.');
      }
      const actorKind = 'client' as const;
      const row = await getById(sql, target, documentId);
      if (!row || row.author_kind !== actorKind || row.author_id !== subject.userId || row.fingerprint.trim() !== fingerprint) {
        throw new TicketWorkflowError(404, 'ticket_document_not_found', 'Document not found.');
      }
      if (row.status === 'available') return prepared(row);
      const now = new Date().toISOString();
      const { rows } = await sql.query<DocumentDbRow>(
        `update alpha_private.ticket_documents set status='available',available_at=$5
          where workspace_id=$1 and ticket_id=$2 and id=$3 and fingerprint=$4 and status='pending'
          returning ${columns}`,
        [target.workspaceId, target.ticketId, documentId, fingerprint, now],
      );
      const saved = rows[0];
      if (!saved) throw new TicketWorkflowError(409, 'ticket_document_changed', 'The upload state changed. Refresh this ticket.');
      await sql.query(
        `update alpha_private.tickets
            set client_updated_at=greatest(client_updated_at,$4::timestamptz),
                internal_updated_at=greatest(internal_updated_at,$4::timestamptz)
          where workspace_id=$1 and id=$2 and version=$3`,
        [target.workspaceId, target.ticketId, ticket.state.version, now],
      );
      await sql.query(
        `insert into alpha_private.ticket_audit_events
          (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
         values ($1,$2,$3,$4,$5,'ticket_document_uploaded',$6,$7::jsonb)`,
        [randomUUID(), target.workspaceId, target.ticketId, actorKind, subject.userId, now,
          JSON.stringify({ documentId, groupId: saved.document_group_id, version: saved.version_number,
            changeProposed: saved.change_proposed })],
      );
      return prepared(saved);
    });
  }

  getDownload(target: TicketTarget, subject: TicketSubject, documentId: string): Promise<PreparedTicketDocument | null> {
    return this.db.transaction(async sql => {
      await lockTicket(sql, target, subject, false);
      const authorRestriction = subject.kind === 'internal' ? "and author_kind='client'" : '';
      const { rows } = await sql.query<DocumentDbRow>(
        `select ${columns} from alpha_private.ticket_documents
          where workspace_id=$1 and ticket_id=$2 and id=$3 and status='available' ${authorRestriction}`,
        [target.workspaceId, target.ticketId, documentId],
      );
      return rows[0] ? prepared(rows[0]) : null;
    });
  }
}
