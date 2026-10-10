import { randomUUID } from 'node:crypto';

import type { TicketClientActivationAudit, TicketClientActivationSignal,
  TicketClientActivationStore, TicketClientActivationTransaction } from './ticketClientActivationStore.js';
import type { TransactionalSql, Sql } from './database.js';
import type { TicketTarget } from './ticketCommandStore.js';
import type { InquiryTicketForActivation, PendingTicketInvitation,
  TicketInvitationContactForActivation } from '../ticketing/clientActivation.js';
import { decodeTicketWorkflow } from './ticketPostgresCodec.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TicketReadInvariantError();
  return parsed.toISOString();
}

/** Invitation redemption binds one verified identity to one public inquiry only. */
export class PostgresTicketClientActivationStore implements TicketClientActivationStore {
  constructor(private readonly db: TransactionalSql) {}

  async resolveTargetBySecretHash(secretHash: string): Promise<TicketTarget | null> {
    const { rows } = await this.db.query<{ workspace_id: string; ticket_id: string }>(
      `select workspace_id,ticket_id from alpha_private.ticket_invitations
        where secret_hash=$1 and status='pending' and expires_at>now()`,
      [secretHash],
    );
    const row = rows[0];
    return row ? { workspaceId: row.workspace_id, ticketId: row.ticket_id } : null;
  }

  transaction<T>(work: (tx: TicketClientActivationTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(this.boundary(sql)));
  }

  private boundary(sql: Sql): TicketClientActivationTransaction {
    return {
      async ensureClientServiceGrant(workspaceId, clientUserId, occurredAt) {
        const { rows: workspaces } = await sql.query<{ id: string }>(
          `select id from public.workspaces where id=$1 and status='active' for share`, [workspaceId],
        );
        if (workspaces.length !== 1) return false;
        await sql.query(
          `insert into alpha_private.ticket_service_grants
             (id,workspace_id,client_user_id,status,display_name,accepts_new_requests,write_mode,time_zone,created_at)
           values ($1,$2,$3,'active','Client portal',false,'disabled','UTC',$4)
           on conflict (workspace_id,client_user_id) do nothing`,
          [randomUUID(), workspaceId, clientUserId, occurredAt],
        );
        const { rows } = await sql.query<{ status: string; revoked_at: Date | string | null }>(
          `select status,revoked_at from alpha_private.ticket_service_grants
            where workspace_id=$1 and client_user_id=$2 for update`,
          [workspaceId, clientUserId],
        );
        return rows[0]?.status === 'active' && rows[0].revoked_at === null;
      },
      async lockInquiryTicket(target) {
        const { rows } = await sql.query<{
          id: string; workspace_id: string; version: string | number; status: string;
          client_user_id: string | null; source: string; workflow_state: unknown;
        }>(
          `select t.id,t.workspace_id,t.version,t.status,t.client_user_id,t.source,t.workflow_state
             from alpha_private.tickets t
            where t.workspace_id=$1 and t.id=$2 for update`,
          [target.workspaceId, target.ticketId],
        );
        const row = rows[0];
        if (!row) return null;
        const workflow = decodeTicketWorkflow(row.workflow_state);
        if (workflow.id !== row.id || workflow.workspaceId !== row.workspace_id
          || workflow.version !== Number(row.version) || workflow.status !== row.status
          || workflow.clientId !== row.client_user_id) throw new TicketReadInvariantError();
        return {
          id: row.id, workspaceId: row.workspace_id, version: Number(row.version),
          status: workflow.status, clientId: row.client_user_id,
          source: row.source === 'public_inquiry' ? 'public_inquiry' as const : 'authenticated_request' as const,
        };
      },
      async lockInvitationBySecretHash(target, secretHash) {
        const { rows } = await sql.query<{
          id: string; ticket_id: string; workspace_id: string; contact_binding_id: string;
          status: string; expires_at: Date | string;
        }>(
          `select id,ticket_id,workspace_id,contact_binding_id,status,expires_at
             from alpha_private.ticket_invitations
            where workspace_id=$1 and ticket_id=$2 and secret_hash=$3
            for update`,
          [target.workspaceId, target.ticketId, secretHash],
        );
        const row = rows[0];
        if (!row) return null;
        if (!['pending','expired','revoked','consumed'].includes(row.status)) throw new TicketReadInvariantError();
        return {
          id: row.id, ticketId: row.ticket_id, workspaceId: row.workspace_id,
          contactBindingId: row.contact_binding_id,
          status: row.status as PendingTicketInvitation['status'], expiresAt: iso(row.expires_at),
        };
      },
      async loadOriginalContact(target, contactBindingId) {
        const { rows } = await sql.query<{ id: string; email: string | null }>(
          `select c.id,c.email from alpha_private.ticket_contacts c
            join alpha_private.tickets t on t.workspace_id=c.workspace_id and t.contact_id=c.id
            join alpha_private.ticket_requests r on r.workspace_id=t.workspace_id and r.ticket_id=t.id and r.contact_id=c.id
           where t.workspace_id=$1 and t.id=$2 and c.id=$3 and t.source='public_inquiry' and r.source='public_inquiry'
           for share of c,r`,
          [target.workspaceId, target.ticketId, contactBindingId],
        );
        const row = rows[0];
        return row ? { bindingId: row.id, email: row.email } satisfies TicketInvitationContactForActivation : null;
      },
      async consumeInvitation(target, invitationId, occurredAt) {
        const { rows } = await sql.query<{ id: string }>(
          `update alpha_private.ticket_invitations set status='consumed',consumed_at=$4
            where workspace_id=$1 and ticket_id=$2 and id=$3 and status='pending' and expires_at>$4
            returning id`,
          [target.workspaceId, target.ticketId, invitationId, occurredAt],
        );
        return rows.length === 1;
      },
      async bindTicketClient(target, expectedVersion, clientUserId) {
        const { rows } = await sql.query<{ id: string }>(
          `update alpha_private.tickets
              set client_user_id=$4,
                  version=version+1,
                  workflow_state=jsonb_set(
                    jsonb_set(workflow_state,'{clientId}',to_jsonb($4::text),true),
                    '{version}',to_jsonb(version+1),true),
                  client_updated_at=now(),internal_updated_at=now()
            where workspace_id=$1 and id=$2 and version=$3 and status='under_review'
              and client_user_id is null and source='public_inquiry'
            returning id`,
          [target.workspaceId, target.ticketId, expectedVersion, clientUserId],
        );
        return rows.length === 1;
      },
      async insertTicketGrant(binding, occurredAt) {
        await sql.query(
          `insert into alpha_private.ticket_client_grants
             (workspace_id,ticket_id,client_user_id,active,created_at)
           values ($1,$2,$3,true,$4)`,
          [binding.workspaceId, binding.ticketId, binding.clientUserId, occurredAt],
        );
      },
      async appendActivationAudit(audit: TicketClientActivationAudit) {
        await sql.query(
          `insert into alpha_private.ticket_audit_events
             (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
           values ($1,$2,$3,'client',$4,'client_invitation_activated',$5,$6::jsonb)`,
          [randomUUID(), audit.binding.workspaceId, audit.binding.ticketId, audit.binding.clientUserId,
            audit.occurredAt, JSON.stringify({ invitationId: audit.binding.invitationId })],
        );
      },
      async enqueueActivationSignal(signal: TicketClientActivationSignal) {
        await sql.query(
          `insert into alpha_private.ticket_outbox_events
             (id,workspace_id,ticket_id,event_type,dedupe_key,payload,status,available_at,created_at)
           values ($1,$2,$3,'ticket_client_activated',$4,'{}'::jsonb,'pending',$5,$5)
           on conflict (workspace_id,dedupe_key) do nothing`,
          [randomUUID(), signal.target.workspaceId, signal.target.ticketId,
            `ticket-client-activated:${signal.target.ticketId}`, signal.occurredAt],
        );
      },
    };
  }
}
