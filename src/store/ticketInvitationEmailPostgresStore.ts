import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { TransactionalSql } from './database.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

export type TicketInvitationEmailStatus = 'queued' | 'accepted' | 'failed';
export interface TicketInvitationEmailReceipt {
  ticketId: string;
  deliveryId: string;
  status: TicketInvitationEmailStatus;
  alreadyRequested: boolean;
}

export interface TicketInvitationEmailClaim {
  eventId: string;
  workspaceId: string;
  ticketId: string;
  leaseHash: string;
  attempt: number;
  firstAttemptAt: string;
  identityMatches: boolean;
  providerIdentity: string;
  recipientHash: string;
  /** Private contact value resolved at send time; never persisted in the outbox or logged. */
  recipient: string;
}

export type TicketInvitationEmailFailureCode = 'provider_failure' | 'attempt_limit_reached';

interface InvitationContactRow {
  source: string;
  request_source: string;
  client_user_id: string | null;
  contact_id: string | null;
  request_contact_id: string | null;
  email: string | null;
}

interface InvitationOutboxRow {
  id: string;
  workspace_id: string;
  ticket_id: string;
  status: string;
  attempt: number;
  payload: Record<string, unknown>;
  ticket_status: string;
  ticket_source: string;
  client_user_id: string | null;
  ticket_contact_id: string | null;
  request_source: string | null;
  request_contact_id: string | null;
  email: string | null;
  workspace_status: string;
  write_mode: string | null;
}

const emailSchema = z.string().trim().email().max(254);
const versionedNotice = (payload: unknown): payload is Record<string, unknown> => Boolean(
  payload && typeof payload === 'object' && !Array.isArray(payload)
    && (payload as Record<string, unknown>).noticeVersion === 1,
);

function unavailable(): never {
  throw new TicketWorkflowError(503, 'ticket_invitation_email_unavailable', 'Invitation email is unavailable right now.');
}

/**
 * Stores an email-only PM invitation in the existing private outbox. It creates
 * no client account, grant, activation token, project link or workflow change.
 * The original contact email is only read for the authorized worker at send time.
 */
export class PostgresTicketInvitationEmailStore {
  constructor(private readonly db: TransactionalSql, private readonly now: () => Date = () => new Date(),
    private readonly nextId: () => string = randomUUID) {}

  async request(target: TicketTarget, subject: TicketSubject): Promise<TicketInvitationEmailReceipt> {
    return this.db.transaction(async sql => {
      const ticket = await new PostgresTicketAuthorization(sql).lockTicket(target, subject, 'update');
      if (!ticket) throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
      if (ticket.actor.kind !== 'pm') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot invite a client to this ticket.');
      if (ticket.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
      if (ticket.state.status !== 'under_review' || ticket.state.clientId !== null) {
        throw new TicketWorkflowError(409, 'ticket_not_eligible_for_invitation', 'Review this inquiry before sending an invitation email.');
      }

      const { rows: contacts } = await sql.query<InvitationContactRow>(
        `select t.source, r.source as request_source, t.client_user_id, t.contact_id,
                r.contact_id as request_contact_id, c.email
         from alpha_private.tickets t
         join alpha_private.ticket_requests r
           on r.workspace_id=t.workspace_id and r.ticket_id=t.id
         join alpha_private.ticket_contacts c
           on c.workspace_id=t.workspace_id and c.id=t.contact_id and c.id=r.contact_id
         where t.workspace_id=$1 and t.id=$2
         for share of r, c`,
        [target.workspaceId, target.ticketId],
      );
      const contact = contacts[0];
      const recipient = contact?.email?.trim().toLowerCase() ?? '';
      if (!contact || contact.source !== 'public_inquiry' || contact.request_source !== 'public_inquiry'
        || contact.client_user_id !== null || !contact.contact_id || contact.contact_id !== contact.request_contact_id
        || !emailSchema.safeParse(recipient).success) {
        throw new TicketWorkflowError(409, 'ticket_client_email_unavailable', 'This public inquiry has no usable client email address.');
      }

      const { rows: existingRows } = await sql.query<{ id: string; status: string }>(
        `select id, status from alpha_private.ticket_outbox_events
         where workspace_id=$1 and ticket_id=$2 and event_type='ticket_invitation_requested'
           and payload->>'noticeVersion'='1'
         order by created_at desc, id desc limit 1 for update`,
        [target.workspaceId, target.ticketId],
      );
      const existing = existingRows[0];
      if (existing && ['pending', 'leased', 'retry', 'delivered', 'dead'].includes(existing.status)) {
        return { ticketId: target.ticketId, deliveryId: existing.id,
          status: existing.status === 'delivered' ? 'accepted' : existing.status === 'dead' ? 'failed' : 'queued',
          alreadyRequested: true };
      }

      const deliveryId = this.nextId();
      if (!z.string().uuid().safeParse(deliveryId).success) unavailable();
      const requestedAt = this.now();
      if (!Number.isFinite(requestedAt.getTime())) unavailable();
      const occurredAt = requestedAt.toISOString();
      await sql.query(
        `insert into alpha_private.ticket_outbox_events
           (id,workspace_id,ticket_id,event_type,dedupe_key,payload,status,available_at,created_at)
         values ($1,$2,$3,'ticket_invitation_requested',$4,$5::jsonb,'pending',$6,$6)`,
        [deliveryId, target.workspaceId, target.ticketId,
          `client-invitation-email:${target.ticketId}:${deliveryId}`,
          JSON.stringify({ noticeVersion: 1 }), occurredAt],
      );
      await sql.query(
        `insert into alpha_private.ticket_audit_events
           (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
         values ($1,$2,$3,'pm',$4,'client_invitation_email_requested',$5,$6::jsonb)`,
        [this.nextId(), target.workspaceId, target.ticketId, ticket.actor.userId, occurredAt,
          JSON.stringify({ deliveryId, noticeVersion: 1 })],
      );
      return { ticketId: target.ticketId, deliveryId, status: 'queued', alreadyRequested: false };
    });
  }

  async claimNext(providerIdentity: string): Promise<TicketInvitationEmailClaim | null> {
    if (!/^[a-f0-9]{64}$/.test(providerIdentity)) return null;
    return this.db.transaction(async sql => {
      const { rows } = await sql.query<InvitationOutboxRow>(
        `select o.id, o.workspace_id, o.ticket_id, o.status, o.attempt, o.payload,
                t.status as ticket_status, t.source as ticket_source, t.client_user_id,
                t.contact_id as ticket_contact_id, r.source as request_source,
                r.contact_id as request_contact_id, c.email, w.status as workspace_status,
                w.settings_json->>'ticketing_write_mode' as write_mode
         from alpha_private.ticket_outbox_events o
         join public.workspaces w on w.id=o.workspace_id
         join alpha_private.tickets t on t.workspace_id=o.workspace_id and t.id=o.ticket_id
         left join alpha_private.ticket_requests r on r.workspace_id=t.workspace_id and r.ticket_id=t.id
         left join alpha_private.ticket_contacts c on c.workspace_id=t.workspace_id and c.id=t.contact_id
         where o.event_type='ticket_invitation_requested' and o.payload->>'noticeVersion'='1'
           and o.status in ('pending','retry','leased') and o.available_at <= now()
           and (o.status <> 'leased' or o.lease_until <= now())
         order by o.available_at,o.created_at,o.id limit 1 for update of o skip locked`,
      );
      const row = rows[0];
      if (!row) return null;
      if (row.workspace_status !== 'active' || row.ticket_status !== 'under_review'
        || row.ticket_source !== 'public_inquiry' || row.request_source !== 'public_inquiry'
        || row.client_user_id !== null || !row.ticket_contact_id || row.ticket_contact_id !== row.request_contact_id) {
        await sql.query(
          `update alpha_private.ticket_outbox_events set status='discarded', lease_token_hash=null,
             lease_until=null, failure_code=null where workspace_id=$1 and ticket_id=$2 and id=$3`,
          [row.workspace_id, row.ticket_id, row.id],
        );
        return null;
      }
      if (row.write_mode !== 'enabled') return null;
      const recipient = row.email?.trim().toLowerCase() ?? '';
      if (!emailSchema.safeParse(recipient).success) {
        await sql.query(
          `update alpha_private.ticket_outbox_events set status='dead', failure_code='provider_failure',
             lease_token_hash=null, lease_until=null where workspace_id=$1 and ticket_id=$2 and id=$3`,
          [row.workspace_id, row.ticket_id, row.id],
        );
        return null;
      }

      const { rows: times } = await sql.query<{ now: string }>('select now()::text as now');
      const now = times[0]?.now;
      const payload = versionedNotice(row.payload) ? row.payload : null;
      if (!now || !payload) {
        await sql.query(
          `update alpha_private.ticket_outbox_events set status='dead', failure_code='provider_failure',
             lease_token_hash=null, lease_until=null where workspace_id=$1 and ticket_id=$2 and id=$3`,
          [row.workspace_id, row.ticket_id, row.id],
        );
        return null;
      }
      const recipientHash = createHash('sha256').update(recipient).digest('hex');
      const previous = payload.invitationEmailDispatch;
      const dispatch = previous && typeof previous === 'object' && !Array.isArray(previous)
        ? previous as Record<string, unknown> : null;
      const firstAttemptAt = typeof dispatch?.firstAttemptAt === 'string' ? dispatch.firstAttemptAt : now;
      const identityMatches = dispatch
        ? dispatch.providerIdentity === providerIdentity && dispatch.recipientHash === recipientHash
          && typeof dispatch.firstAttemptAt === 'string' && Number.isFinite(Date.parse(dispatch.firstAttemptAt))
        : row.attempt === 0 && previous === undefined;
      const leaseHash = createHash('sha256').update(randomUUID()).digest('hex');
      await sql.query(
        `update alpha_private.ticket_outbox_events
         set status='leased', lease_token_hash=$4, lease_until=now()+interval '2 minutes', attempt=attempt+1,
             payload=case when not (payload ? 'invitationEmailDispatch')
               then payload || jsonb_build_object('invitationEmailDispatch',$5::jsonb) else payload end
         where workspace_id=$1 and ticket_id=$2 and id=$3`,
        [row.workspace_id, row.ticket_id, row.id, leaseHash,
          JSON.stringify({ providerIdentity, recipientHash, firstAttemptAt })],
      );
      return { eventId: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id,
        leaseHash, attempt: row.attempt + 1, firstAttemptAt, identityMatches, providerIdentity,
        recipientHash, recipient };
    });
  }

  async canDispatch(claim: TicketInvitationEmailClaim): Promise<boolean> {
    const { rows } = await this.db.query<{
      email: string | null; payload: Record<string, unknown>;
    }>(
      `select c.email,o.payload from alpha_private.ticket_outbox_events o
       join public.workspaces w on w.id=o.workspace_id and w.status='active'
       join alpha_private.tickets t on t.workspace_id=o.workspace_id and t.id=o.ticket_id
         and t.status='under_review' and t.source='public_inquiry' and t.client_user_id is null
       join alpha_private.ticket_requests r on r.workspace_id=t.workspace_id and r.ticket_id=t.id
         and r.source='public_inquiry' and r.contact_id=t.contact_id
       join alpha_private.ticket_contacts c on c.workspace_id=t.workspace_id and c.id=t.contact_id
       where o.workspace_id=$1 and o.ticket_id=$2 and o.id=$3
         and o.event_type='ticket_invitation_requested' and o.payload->>'noticeVersion'='1'
         and o.status='leased' and o.lease_token_hash=$4 and o.lease_until>now()
         and w.settings_json->>'ticketing_write_mode'='enabled'
         and $5::timestamptz <= now() and $5::timestamptz + interval '10 minutes' > now()`,
      [claim.workspaceId, claim.ticketId, claim.eventId, claim.leaseHash, claim.firstAttemptAt],
    );
    const row = rows[0];
    const value = row?.payload?.invitationEmailDispatch;
    if (!row?.email || !emailSchema.safeParse(row.email).success
      || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const dispatch = value as Record<string, unknown>;
    return createHash('sha256').update(row.email.trim().toLowerCase()).digest('hex') === claim.recipientHash
      && dispatch.providerIdentity === claim.providerIdentity && dispatch.recipientHash === claim.recipientHash;
  }

  async markDelivered(claim: TicketInvitationEmailClaim): Promise<boolean> {
    const { rows } = await this.db.query(
      `update alpha_private.ticket_outbox_events
       set status='delivered',failure_code=null,lease_token_hash=null,lease_until=null,delivered_at=now()
       where workspace_id=$1 and ticket_id=$2 and id=$3 and status='leased'
         and lease_token_hash=$4 and lease_until>now() returning id`,
      [claim.workspaceId, claim.ticketId, claim.eventId, claim.leaseHash],
    );
    return rows.length === 1;
  }

  async scheduleRetry(claim: TicketInvitationEmailClaim, delaySeconds: number): Promise<boolean> {
    const delay = Math.max(1, Math.min(300, Math.floor(delaySeconds)));
    const { rows } = await this.db.query(
      `update alpha_private.ticket_outbox_events
       set status='retry',failure_code='provider_failure',lease_token_hash=null,lease_until=null,
           available_at=now()+$5*interval '1 second'
       where workspace_id=$1 and ticket_id=$2 and id=$3 and status='leased'
         and lease_token_hash=$4 and lease_until>now() returning id`,
      [claim.workspaceId, claim.ticketId, claim.eventId, claim.leaseHash, delay],
    );
    return rows.length === 1;
  }

  async deadLetter(claim: TicketInvitationEmailClaim, failure: TicketInvitationEmailFailureCode): Promise<boolean> {
    const { rows } = await this.db.query(
      `update alpha_private.ticket_outbox_events
       set status='dead',failure_code=$5,lease_token_hash=null,lease_until=null
       where workspace_id=$1 and ticket_id=$2 and id=$3 and status='leased'
         and lease_token_hash=$4 and lease_until>now() returning id`,
      [claim.workspaceId, claim.ticketId, claim.eventId, claim.leaseHash, failure],
    );
    return rows.length === 1;
  }

  async discard(claim: TicketInvitationEmailClaim): Promise<boolean> {
    const { rows } = await this.db.query(
      `update alpha_private.ticket_outbox_events
       set status='discarded',failure_code=null,lease_token_hash=null,lease_until=null
       where workspace_id=$1 and ticket_id=$2 and id=$3 and status='leased'
         and lease_token_hash=$4 and lease_until>now() returning id`,
      [claim.workspaceId, claim.ticketId, claim.eventId, claim.leaseHash],
    );
    return rows.length === 1;
  }
}
