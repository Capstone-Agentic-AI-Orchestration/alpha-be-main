import { createHash, randomUUID } from 'node:crypto';

import type { Sql, TransactionalSql } from './database.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export type TicketCommunicationKind = 'message' | 'document';
export type TicketCommunicationFailure = 'provider_failure' | 'attempt_limit_reached';

export interface TicketCommunicationNotificationClaim {
  eventId: string;
  leaseToken: string;
  attempt: number;
  kind: TicketCommunicationKind;
  recipient: string;
}

export interface TicketCommunicationNotificationStore {
  claimNext(input: { now: string; leaseUntil: string }): Promise<TicketCommunicationNotificationClaim | null>;
  markDelivered(claim: TicketCommunicationNotificationClaim, deliveredAt: string): Promise<boolean>;
  scheduleRetry(claim: TicketCommunicationNotificationClaim, retryAt: string): Promise<boolean>;
  deadLetter(claim: TicketCommunicationNotificationClaim, occurredAt: string, code: TicketCommunicationFailure): Promise<boolean>;
  discard(claim: TicketCommunicationNotificationClaim, occurredAt: string): Promise<boolean>;
}

interface NotificationRow {
  id: string;
  workspace_id: string;
  ticket_id: string;
  notification_kind: string;
  object_id: string;
  attempt: number;
}

interface RecipientRow {
  email: string | null;
  email_verified: boolean;
  eligible: boolean;
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function opaque(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function failureCode(value: string): value is TicketCommunicationFailure {
  return value === 'provider_failure' || value === 'attempt_limit_reached';
}

/** Leased queue access for generic client email notices; never reads message bodies or filenames. */
export class PostgresTicketCommunicationNotificationStore implements TicketCommunicationNotificationStore {
  constructor(private readonly db: TransactionalSql) {}

  claimNext(input: { now: string; leaseUntil: string }): Promise<TicketCommunicationNotificationClaim | null> {
    if (!validDate(input.now) || !validDate(input.leaseUntil)) throw new TicketReadInvariantError();
    return this.db.transaction(async sql => {
      // Drain a bounded number of stale/ineligible events without leaving them
      // permanently pending when ticket access is revoked or a workspace pauses writes.
      for (let skipped = 0; skipped < 25; skipped++) {
        const { rows } = await sql.query<NotificationRow>(
          `select id,workspace_id,ticket_id,notification_kind,object_id,attempt
             from alpha_private.ticket_communication_notifications
            where ((status in ('pending','retry') and available_at <= $1::timestamptz)
               or (status='leased' and lease_until <= $1::timestamptz))
            order by available_at,created_at,id collate "C"
            for update skip locked limit 1`, [input.now],
        );
        const event = rows[0];
        if (!event) return null;
        if (!opaque(event.id) || !opaque(event.workspace_id) || !opaque(event.ticket_id) || !opaque(event.object_id)
          || !['message', 'document'].includes(event.notification_kind)
          || !Number.isSafeInteger(event.attempt) || event.attempt < 0) throw new TicketReadInvariantError();

        const { rows: recipientRows } = await sql.query<RecipientRow>(
          `select c.email,c.email_verified,
                  (w.status='active'
                   and w.settings_json->>'ticketing_write_mode'='enabled'
                   and t.client_user_id is not null
                   and t.status not in ('closed','declined','cancelled')
                   and c.email_verified
                   and exists (
                     select 1 from alpha_private.ticket_service_grants sg
                      where sg.workspace_id=t.workspace_id and sg.client_user_id=t.client_user_id
                        and sg.status='active' and sg.revoked_at is null
                   )
                   and exists (
                     select 1 from alpha_private.ticket_client_grants cg
                      where cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
                        and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
                   )
                   and case when n.notification_kind='message' then exists (
                     select 1 from alpha_private.ticket_messages m
                      where m.workspace_id=n.workspace_id and m.ticket_id=n.ticket_id and m.id=n.object_id
                        and m.author_kind='pm' and m.audience='client'
                   ) else exists (
                     select 1 from alpha_private.ticket_documents d
                      where d.workspace_id=n.workspace_id and d.ticket_id=n.ticket_id and d.id=n.object_id
                        and d.author_kind='pm' and d.status='available'
                   ) end) as eligible
             from alpha_private.ticket_communication_notifications n
             join alpha_private.tickets t on t.workspace_id=n.workspace_id and t.id=n.ticket_id
             join public.workspaces w on w.id=n.workspace_id
             left join alpha_private.ticket_contacts c
               on c.workspace_id=t.workspace_id and c.id=t.contact_id and c.email_verified
            where n.id=$1`, [event.id],
        );
        const recipient = recipientRows[0];
        if (!recipient?.eligible || typeof recipient.email !== 'string' || !recipient.email.trim()) {
          await sql.query(
            `update alpha_private.ticket_communication_notifications
                set status='discarded',lease_token_hash=null,lease_until=null,delivered_at=null
              where id=$1`, [event.id],
          );
          continue;
        }

        const leaseToken = randomUUID();
        const leaseHash = createHash('sha256').update(leaseToken).digest('hex');
        const { rows: claimedRows } = await sql.query<{ id: string }>(
          `update alpha_private.ticket_communication_notifications
              set status='leased',attempt=attempt+1,lease_token_hash=$2,lease_until=$3::timestamptz
            where id=$1 returning id`, [event.id, leaseHash, input.leaseUntil],
        );
        if (claimedRows.length !== 1) return null;
        return {
          eventId: event.id, leaseToken, attempt: event.attempt + 1,
          kind: event.notification_kind as TicketCommunicationKind, recipient: recipient.email.trim(),
        };
      }
      return null;
    });
  }

  markDelivered(claim: TicketCommunicationNotificationClaim, deliveredAt: string): Promise<boolean> {
    return this.updateClaim(claim, `status='delivered',delivered_at=$3::timestamptz,
      failure_code=null,lease_token_hash=null,lease_until=null`, [deliveredAt]);
  }

  scheduleRetry(claim: TicketCommunicationNotificationClaim, retryAt: string): Promise<boolean> {
    return this.updateClaim(claim, `status='retry',available_at=$3::timestamptz,
      failure_code='provider_failure',lease_token_hash=null,lease_until=null`, [retryAt]);
  }

  deadLetter(claim: TicketCommunicationNotificationClaim, occurredAt: string, code: TicketCommunicationFailure): Promise<boolean> {
    if (!failureCode(code)) throw new TicketReadInvariantError();
    return this.updateClaim(claim, `status='dead',available_at=$3::timestamptz,
      failure_code=$4,lease_token_hash=null,lease_until=null`, [occurredAt, code]);
  }

  discard(claim: TicketCommunicationNotificationClaim, occurredAt: string): Promise<boolean> {
    return this.updateClaim(claim, `status='discarded',available_at=$3::timestamptz,
      failure_code=null,lease_token_hash=null,lease_until=null`, [occurredAt]);
  }

  private updateClaim(
    claim: TicketCommunicationNotificationClaim,
    setClause: string,
    extra: (string | null)[],
  ): Promise<boolean> {
    if (!claim || !opaque(claim.eventId) || !opaque(claim.leaseToken) || !Number.isSafeInteger(claim.attempt)
      || !validDate(extra[0] ?? '')) throw new TicketReadInvariantError();
    const leaseHash = createHash('sha256').update(claim.leaseToken).digest('hex');
    const leaseParameter = 3 + extra.length;
    return this.db.transaction(async (sql: Sql) => {
      const { rows } = await sql.query<{ id: string }>(
        `update alpha_private.ticket_communication_notifications set ${setClause}
          where id=$1 and status='leased' and attempt=$2 and lease_token_hash=$${leaseParameter} returning id`,
        [claim.eventId, claim.attempt, ...extra, leaseHash],
      );
      return rows.length === 1;
    });
  }
}
