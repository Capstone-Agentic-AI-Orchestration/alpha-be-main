import { randomUUID } from 'node:crypto';

import type { TicketInvitationRecord, TicketInvitationStore, TicketInvitationTransaction,
  TicketInvitationAudit, TicketInvitationSignal, TicketInvitationOutboxStatus } from './ticketInvitationStore.js';
import type { TransactionalSql, Sql } from './database.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TicketReadInvariantError();
  return parsed.toISOString();
}

/** Durable invitation rows and outbox writes share the existing ticket DB transaction. */
export class PostgresTicketInvitationStore implements TicketInvitationStore {
  constructor(private readonly db: TransactionalSql) {}

  transaction<T>(work: (tx: TicketInvitationTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(this.boundary(sql)));
  }

  private boundary(sql: Sql): TicketInvitationTransaction {
    return {
      async lockAuthorizedTicket(target: TicketTarget, subject: TicketSubject) {
        return new PostgresTicketAuthorization(sql).lockTicket(target, subject, 'update');
      },
      async loadInvitationContact(ticket) {
        const { rows } = await sql.query<{
          source: string; contact_id: string | null; request_contact_id: string | null;
          email: string | null; email_verified: boolean;
        }>(
          `select r.source, t.contact_id, r.contact_id as request_contact_id, c.email, c.email_verified
             from alpha_private.tickets t
             join alpha_private.ticket_requests r
               on r.workspace_id=t.workspace_id and r.ticket_id=t.id
             join alpha_private.ticket_contacts c
               on c.workspace_id=t.workspace_id and c.id=t.contact_id and c.id=r.contact_id
            where t.workspace_id=$1 and t.id=$2
            for share of r, c`,
          [ticket.state.workspaceId, ticket.state.id],
        );
        const row = rows[0];
        if (!row || !row.contact_id || row.contact_id !== row.request_contact_id) return null;
        return {
          bindingId: row.contact_id,
          source: row.source === 'public_inquiry' ? 'public_inquiry' as const : 'authenticated_request' as const,
          email: row.email,
          emailVerified: row.email_verified,
        };
      },
      async lockLatestInvitation(target) {
        const { rows } = await sql.query<{
          id: string; workspace_id: string; ticket_id: string; contact_binding_id: string;
          secret_hash: string; status: string; created_at: Date | string; expires_at: Date | string;
        }>(
          `select id,workspace_id,ticket_id,contact_binding_id,secret_hash,status,created_at,expires_at
             from alpha_private.ticket_invitations
            where workspace_id=$1 and ticket_id=$2
            order by created_at desc,id desc limit 1 for update`,
          [target.workspaceId, target.ticketId],
        );
        const row = rows[0];
        if (!row) return null;
        if (!['pending','expired','revoked','consumed'].includes(row.status)) throw new TicketReadInvariantError();
        return {
          id: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id,
          contactBindingId: row.contact_binding_id, secretHash: row.secret_hash,
          status: row.status as TicketInvitationRecord['status'],
          createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
        };
      },
      async loadInvitationOutboxStatus(target, invitationId) {
        const { rows } = await sql.query<{ status: string }>(
          `select status
             from alpha_private.ticket_outbox_events
            where workspace_id=$1 and ticket_id=$2 and event_type='ticket_invitation_requested'
              and payload->>'activationVersion'='1' and payload->>'invitationId'=$3
            order by created_at desc,id desc limit 1`,
          [target.workspaceId, target.ticketId, invitationId],
        );
        const status = rows[0]?.status;
        if (status === undefined) return null;
        if (!['pending', 'retry', 'leased', 'delivered', 'dead', 'discarded'].includes(status)) {
          throw new TicketReadInvariantError();
        }
        return status as TicketInvitationOutboxStatus;
      },
      async expireInvitation(target, invitationId, _occurredAt) {
        const { rows } = await sql.query<{ id: string }>(
          `update alpha_private.ticket_invitations set status='expired'
            where workspace_id=$1 and ticket_id=$2 and id=$3 and status='pending'
            returning id`,
          [target.workspaceId, target.ticketId, invitationId],
        );
        return rows.length === 1;
      },
      async insertInvitation(record) {
        await sql.query(
          `insert into alpha_private.ticket_invitations
             (id,workspace_id,ticket_id,contact_binding_id,secret_hash,status,created_at,expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [record.id, record.workspaceId, record.ticketId, record.contactBindingId,
            record.secretHash, record.status, record.createdAt, record.expiresAt],
        );
      },
      async appendInvitationAudit(audit: TicketInvitationAudit) {
        await sql.query(
          `insert into alpha_private.ticket_audit_events
             (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
           values ($1,$2,$3,'pm',$4,$5,$6,$7::jsonb)`,
          [randomUUID(), audit.target.workspaceId, audit.target.ticketId, audit.actorId,
            audit.type === 'invitation_issued' ? 'client_invitation_issued' : 'client_invitation_expired',
            audit.occurredAt, JSON.stringify({ invitationId: audit.invitationId })],
        );
      },
      async enqueueInvitationSignal(signal: TicketInvitationSignal) {
        await sql.query(
          `insert into alpha_private.ticket_outbox_events
             (id,workspace_id,ticket_id,event_type,dedupe_key,payload,status,available_at,created_at)
           values ($1,$2,$3,'ticket_invitation_requested',$4,$5::jsonb,'pending',$6,$6)`,
          [randomUUID(), signal.target.workspaceId, signal.target.ticketId,
            `client-activation:${signal.invitationId}`,
            JSON.stringify({ activationVersion: 1, invitationId: signal.invitationId, protectedToken: signal.protectedToken }),
            signal.occurredAt],
        );
      },
    };
  }
}
