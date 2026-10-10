import { createHash, randomUUID } from 'node:crypto';

import type { TransactionalSql, Sql } from './database.js';
import type { TicketInvitationRecord } from './ticketInvitationStore.js';
import type { TicketStatus } from '../ticketing/workflow.js';
import { decodeTicketWorkflow } from './ticketPostgresCodec.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export type ProviderEmailLinkType = 'invite' | 'magiclink';
export type ClientInvitationFailureCode = 'provider_failure' | 'secret_unavailable'
  | 'secret_integrity_failure' | 'attempt_limit_reached';
export type ClientInvitationSkipReason = 'expired' | 'invitation_inactive' | 'ticket_ineligible' | 'contact_changed';

export interface TicketClientInvitationClaim {
  eventId: string;
  leaseToken: string;
  attempt: number;
  signal: { workspaceId: string; ticketId: string; invitationId: string; protectedToken: string };
  invitation: TicketInvitationRecord & { providerLinkEnvelope: string | null; providerLinkType: ProviderEmailLinkType | null };
  ticket: { status: TicketStatus; source: string; clientId: string | null; scopeVersionId: string | null;
    agreedScopeVersionId: string | null; authorizedScopeVersionId: string | null; projectId: string | null; requiredIssueIds: string[] };
  contact: { bindingId: string; source: string; email: string | null; emailVerified: boolean };
}

export interface TicketClientInvitationDeliveryStore {
  claimNext(input: { now: string; leaseUntil: string }): Promise<TicketClientInvitationClaim | null>;
  cacheProviderLink(claim: TicketClientInvitationClaim, envelope: string, type: ProviderEmailLinkType): Promise<{ envelope: string; type: ProviderEmailLinkType } | null>;
  markDelivered(claim: TicketClientInvitationClaim, deliveredAt: string): Promise<boolean>;
  scheduleRetry(claim: TicketClientInvitationClaim, retryAt: string, code: ClientInvitationFailureCode): Promise<boolean>;
  deadLetter(claim: TicketClientInvitationClaim, occurredAt: string, code: ClientInvitationFailureCode): Promise<boolean>;
  discard(claim: TicketClientInvitationClaim, occurredAt: string, reason: ClientInvitationSkipReason): Promise<boolean>;
}

interface OutboxRow {
  event_id: string; workspace_id: string; ticket_id: string; payload: unknown; attempt: number;
  invitation_id: string; contact_binding_id: string; invitation_hash: string; invitation_status: string;
  invitation_created_at: Date | string; invitation_expires_at: Date | string;
  provider_link_envelope: string | null; provider_link_type: ProviderEmailLinkType | null;
  ticket_source: string; ticket_status: string; ticket_version: string | number;
  ticket_client_user_id: string | null; workflow_state: unknown; project_id: string | null;
  request_source: string; request_contact_id: string | null; contact_email: string | null;
  contact_email_verified: boolean; workspace_status: string; write_mode: string | null;
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TicketReadInvariantError();
  return parsed.toISOString();
}
function payloadRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return null; }
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
}

/** Claims only activation-version events; the existing Phase 3 notice worker is unaffected. */
export class PostgresTicketClientInvitationDeliveryStore implements TicketClientInvitationDeliveryStore {
  constructor(private readonly db: TransactionalSql) {}

  claimNext(input: { now: string; leaseUntil: string }): Promise<TicketClientInvitationClaim | null> {
    return this.db.transaction(async sql => {
      const { rows } = await sql.query<OutboxRow>(
        `select o.id as event_id,o.workspace_id,o.ticket_id,o.payload,o.attempt,
                i.id as invitation_id,i.contact_binding_id,i.secret_hash as invitation_hash,
                i.status as invitation_status,i.created_at as invitation_created_at,
                i.expires_at as invitation_expires_at,i.provider_link_envelope,i.provider_link_type,
                t.source as ticket_source,t.status as ticket_status,t.version as ticket_version,
                t.client_user_id as ticket_client_user_id,t.workflow_state,t.project_id,
                r.source as request_source,r.contact_id as request_contact_id,
                c.email as contact_email,c.email_verified as contact_email_verified,
                w.status as workspace_status,w.settings_json->>'ticketing_write_mode' as write_mode
           from alpha_private.ticket_outbox_events o
           join alpha_private.ticket_invitations i
             on i.workspace_id=o.workspace_id and i.ticket_id=o.ticket_id
            and i.id=o.payload->>'invitationId'
           join alpha_private.tickets t on t.workspace_id=o.workspace_id and t.id=o.ticket_id
           join alpha_private.ticket_requests r on r.workspace_id=t.workspace_id and r.ticket_id=t.id
           join alpha_private.ticket_contacts c
             on c.workspace_id=t.workspace_id and c.id=t.contact_id and c.id=r.contact_id
           join public.workspaces w on w.id=o.workspace_id
          where o.event_type='ticket_invitation_requested' and o.payload->>'activationVersion'='1'
            and o.status in ('pending','retry','leased') and o.available_at<=$1
            and (o.status<>'leased' or o.lease_until<=$1)
          order by o.available_at,o.created_at,o.id limit 1 for update of o skip locked`,
        [input.now],
      );
      const row = rows[0];
      if (!row) return null;
      const payload = payloadRecord(row.payload);
      const workflow = decodeTicketWorkflow(row.workflow_state);
      if (!payload || payload.activationVersion !== 1 || payload.invitationId !== row.invitation_id
        || typeof payload.protectedToken !== 'string' || payload.protectedToken.length > 512
        || workflow.id !== row.ticket_id || workflow.workspaceId !== row.workspace_id
        || workflow.version !== Number(row.ticket_version) || workflow.status !== row.ticket_status
        || workflow.clientId !== row.ticket_client_user_id || workflow.projectId !== row.project_id) {
        await this.discardLocked(sql, row, 'ticket_ineligible');
        return null;
      }
      const valid = row.workspace_status === 'active' && row.write_mode === 'enabled'
        && row.ticket_source === 'public_inquiry' && row.ticket_status === 'under_review'
        && row.ticket_client_user_id === null && row.project_id === null
        && workflow.scopeVersionId === null && workflow.agreedScopeVersionId === null
        && workflow.authorizedScopeVersionId === null && workflow.requiredIssueIds.length === 0
        && row.request_source === 'public_inquiry' && row.contact_email_verified === false
        && row.invitation_status === 'pending' && Date.parse(iso(row.invitation_expires_at)) > Date.parse(input.now)
        && row.invitation_created_at !== null;
      if (!valid) {
        await this.discardLocked(sql, row, Date.parse(iso(row.invitation_expires_at)) <= Date.parse(input.now)
          ? 'expired' : 'ticket_ineligible');
        return null;
      }
      if (row.contact_binding_id !== row.request_contact_id || row.contact_email === null
        || typeof row.contact_email !== 'string' || row.contact_email.trim() !== row.contact_email) {
        await this.discardLocked(sql, row, 'contact_changed');
        return null;
      }
      const token = randomUUID();
      const leaseHash = createHash('sha256').update(token).digest('hex');
      const { rows: leased } = await sql.query<{ id: string }>(
        `update alpha_private.ticket_outbox_events
            set status='leased',lease_token_hash=$3,lease_until=$4,attempt=attempt+1
          where id=$1 and workspace_id=$2
          returning id`,
        [row.event_id, row.workspace_id, leaseHash, input.leaseUntil],
      );
      if (leased.length !== 1) return null;
      return {
        eventId: row.event_id, leaseToken: token, attempt: Number(row.attempt) + 1,
        signal: { workspaceId: row.workspace_id, ticketId: row.ticket_id,
          invitationId: row.invitation_id, protectedToken: payload.protectedToken },
        invitation: {
          id: row.invitation_id, workspaceId: row.workspace_id, ticketId: row.ticket_id,
          contactBindingId: row.contact_binding_id, secretHash: row.invitation_hash,
          status: row.invitation_status as TicketInvitationRecord['status'],
          createdAt: iso(row.invitation_created_at), expiresAt: iso(row.invitation_expires_at),
          providerLinkEnvelope: row.provider_link_envelope,
          providerLinkType: row.provider_link_type,
        },
        ticket: {
          status: workflow.status, source: row.ticket_source, clientId: workflow.clientId,
          scopeVersionId: workflow.scopeVersionId, agreedScopeVersionId: workflow.agreedScopeVersionId,
          authorizedScopeVersionId: workflow.authorizedScopeVersionId, projectId: workflow.projectId,
          requiredIssueIds: workflow.requiredIssueIds,
        },
        contact: { bindingId: row.contact_binding_id, source: row.request_source,
          email: row.contact_email, emailVerified: row.contact_email_verified },
      };
    });
  }

  cacheProviderLink(claim: TicketClientInvitationClaim, envelope: string, type: ProviderEmailLinkType) {
    return this.db.transaction(async sql => {
      const leaseHash = this.leaseHash(claim);
      const { rows: leases } = await sql.query<{ id: string }>(
        `select id from alpha_private.ticket_outbox_events
          where id=$1 and workspace_id=$2 and ticket_id=$3 and status='leased' and lease_token_hash=$4
          for update`, [claim.eventId, claim.signal.workspaceId, claim.signal.ticketId, leaseHash],
      );
      if (leases.length !== 1) return null;
      const { rows } = await sql.query<{ provider_link_envelope: string | null; provider_link_type: ProviderEmailLinkType | null }>(
        `update alpha_private.ticket_invitations
            set provider_link_envelope=coalesce(provider_link_envelope,$4),
                provider_link_type=coalesce(provider_link_type,$5)
          where workspace_id=$1 and ticket_id=$2 and id=$3 and status='pending'
          returning provider_link_envelope,provider_link_type`,
        [claim.signal.workspaceId, claim.signal.ticketId, claim.signal.invitationId, envelope, type],
      );
      const row = rows[0];
      if (!row?.provider_link_envelope || !row.provider_link_type) return null;
      return { envelope: row.provider_link_envelope, type: row.provider_link_type };
    });
  }

  markDelivered(claim: TicketClientInvitationClaim, deliveredAt: string): Promise<boolean> {
    return this.finishClaim(claim, async sql => {
      const { rows } = await sql.query<{ id: string }>(
        `update alpha_private.ticket_outbox_events
            set status='delivered',delivered_at=$5,lease_token_hash=null,lease_until=null,failure_code=null,
                payload=payload-'protectedToken'
          where id=$1 and workspace_id=$2 and ticket_id=$3 and status='leased' and lease_token_hash=$4
          returning id`,
        [claim.eventId, claim.signal.workspaceId, claim.signal.ticketId, this.leaseHash(claim), deliveredAt],
      );
      if (rows.length !== 1) return false;
      await sql.query(
        `update alpha_private.ticket_invitations set provider_link_envelope=null,provider_link_type=null
          where workspace_id=$1 and ticket_id=$2 and id=$3`,
        [claim.signal.workspaceId, claim.signal.ticketId, claim.signal.invitationId],
      );
      return true;
    });
  }

  scheduleRetry(claim: TicketClientInvitationClaim, retryAt: string, code: ClientInvitationFailureCode): Promise<boolean> {
    return this.finishClaim(claim, async sql => {
      const { rows } = await sql.query<{ id: string }>(
        `update alpha_private.ticket_outbox_events
            set status='retry',available_at=$5,lease_token_hash=null,lease_until=null,failure_code=$6
          where id=$1 and workspace_id=$2 and ticket_id=$3 and status='leased' and lease_token_hash=$4
          returning id`,
        [claim.eventId, claim.signal.workspaceId, claim.signal.ticketId, this.leaseHash(claim), retryAt, code],
      );
      return rows.length === 1;
    });
  }

  deadLetter(claim: TicketClientInvitationClaim, _occurredAt: string, code: ClientInvitationFailureCode): Promise<boolean> {
    return this.finishClaim(claim, async sql => {
      const { rows } = await sql.query<{ id: string }>(
        `update alpha_private.ticket_outbox_events
            set status='dead',payload=payload-'protectedToken',lease_token_hash=null,lease_until=null,failure_code=$5
          where id=$1 and workspace_id=$2 and ticket_id=$3 and status='leased' and lease_token_hash=$4
          returning id`,
        [claim.eventId, claim.signal.workspaceId, claim.signal.ticketId, this.leaseHash(claim), code],
      );
      if (rows.length !== 1) return false;
      await sql.query(
        `update alpha_private.ticket_invitations set provider_link_envelope=null,provider_link_type=null
          where workspace_id=$1 and ticket_id=$2 and id=$3`,
        [claim.signal.workspaceId, claim.signal.ticketId, claim.signal.invitationId],
      );
      return true;
    });
  }

  discard(claim: TicketClientInvitationClaim, _occurredAt: string, _reason: ClientInvitationSkipReason): Promise<boolean> {
    return this.finishClaim(claim, async sql => this.discardClaimed(sql, claim));
  }

  private async discardLocked(sql: Sql, row: OutboxRow, _reason: ClientInvitationSkipReason): Promise<void> {
    await sql.query(
      `update alpha_private.ticket_outbox_events
          set status='discarded',payload=payload-'protectedToken',lease_token_hash=null,lease_until=null,failure_code=null
        where id=$1 and workspace_id=$2`, [row.event_id, row.workspace_id],
    );
    await sql.query(
      `update alpha_private.ticket_invitations set provider_link_envelope=null,provider_link_type=null
        where workspace_id=$1 and ticket_id=$2 and id=$3`, [row.workspace_id, row.ticket_id, row.invitation_id],
    );
  }

  private async discardClaimed(sql: Sql, claim: TicketClientInvitationClaim): Promise<boolean> {
    const { rows } = await sql.query<{ id: string }>(
      `update alpha_private.ticket_outbox_events
          set status='discarded',payload=payload-'protectedToken',lease_token_hash=null,lease_until=null,failure_code=null
        where id=$1 and workspace_id=$2 and ticket_id=$3 and status='leased' and lease_token_hash=$4
        returning id`,
      [claim.eventId, claim.signal.workspaceId, claim.signal.ticketId, this.leaseHash(claim)],
    );
    if (rows.length !== 1) return false;
    await sql.query(
      `update alpha_private.ticket_invitations set provider_link_envelope=null,provider_link_type=null
        where workspace_id=$1 and ticket_id=$2 and id=$3`,
      [claim.signal.workspaceId, claim.signal.ticketId, claim.signal.invitationId],
    );
    return true;
  }

  private finishClaim(claim: TicketClientInvitationClaim, action: (sql: Sql) => Promise<boolean>): Promise<boolean> {
    return this.db.transaction(action);
  }

  private leaseHash(claim: TicketClientInvitationClaim): string {
    return createHash('sha256').update(claim.leaseToken).digest('hex');
  }
}
