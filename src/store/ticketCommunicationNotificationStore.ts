import { createHash, randomUUID } from 'node:crypto';

import type { Sql, TransactionalSql } from './database.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export type TicketCommunicationKind = 'message' | 'document' | 'action' | 'reminder';
/** What the client is being asked to do next; mirrors the portal's requested action. */
export type TicketClientAction = 'reply' | 'agree_scope' | 'review_result';
export type TicketCommunicationFailure = 'provider_failure' | 'attempt_limit_reached';

export interface TicketCommunicationNotificationClaim {
  eventId: string;
  leaseToken: string;
  attempt: number;
  kind: TicketCommunicationKind;
  /** Fresh from the ticket at claim time, so an email never names a stale request. */
  action: TicketClientAction | null;
  recipient: string;
}

export interface ActionNoticeSweepPolicy {
  now: string;
  /** A scope or result shared within this window gets an immediate "waiting on you" notice. */
  freshWithinMs: number;
  /** One reminder is queued when the client has not acted for this long... */
  reminderAfterMs: number;
  /** ...but never for requests that have been quiet for longer than this. */
  reminderWithinMs: number;
}

export interface TicketCommunicationNotificationStore {
  claimNext(input: { now: string; leaseUntil: string }): Promise<TicketCommunicationNotificationClaim | null>;
  /** Queue notices for scopes/results waiting on the client and one reminder per request. Returns rows queued. */
  enqueueDueActionNotices(policy: ActionNoticeSweepPolicy): Promise<number>;
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
  action_owner: string | null;
  next_action: string | null;
  withdrawal_requested: string | null;
  ticket_status: string;
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

const KINDS: readonly string[] = ['message', 'document', 'action', 'reminder'];

/** SQL: the ticket is still waiting on its client for one of these requests. */
function awaitingClient(ticket: string, actions: string): string {
  return `${ticket}.workflow_state->>'actionOwner'='client'
    and ${ticket}.workflow_state->>'withdrawalRequested' is distinct from 'true'
    and ${ticket}.status<>'on_hold'
    and ${ticket}.workflow_state->>'nextAction' in (${actions})`;
}

/** SQL: identifies one specific request (this scope, this result), so a notice goes out once per request. */
function requestKey(ticket: string): string {
  return `md5((${ticket}.workflow_state->>'nextAction')||':'||case ${ticket}.workflow_state->>'nextAction'
    when 'agree_scope' then coalesce(${ticket}.workflow_state->>'scopeVersionId','')
    when 'review_result' then coalesce(${ticket}.workflow_state->'delivery'->>'id','')
    else coalesce(${ticket}.workflow_state->>'version','') end)`;
}

function clientAction(row: RecipientRow, kind: TicketCommunicationKind): TicketClientAction | null {
  if (kind === 'document') return null;
  const waiting = row.action_owner === 'client' && row.withdrawal_requested !== 'true' && row.ticket_status !== 'on_hold';
  const action = waiting && (row.next_action === 'reply' || row.next_action === 'agree_scope' || row.next_action === 'review_result')
    ? row.next_action : null;
  // An ordinary PM message only counts as a request when it asked for details; a
  // scope or result has its own dedicated notice, so the message stays a plain update.
  if (kind === 'message') return action === 'reply' ? 'reply' : null;
  return action;
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
          || !KINDS.includes(event.notification_kind)
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
                   and case n.notification_kind when 'message' then exists (
                     select 1 from alpha_private.ticket_messages m
                      where m.workspace_id=n.workspace_id and m.ticket_id=n.ticket_id and m.id=n.object_id
                        and m.author_kind='pm' and m.audience='client'
                   ) when 'document' then exists (
                     select 1 from alpha_private.ticket_documents d
                      where d.workspace_id=n.workspace_id and d.ticket_id=n.ticket_id and d.id=n.object_id
                        and d.author_kind='pm' and d.status='available'
                   ) else (${awaitingClient('t', "'reply','agree_scope','review_result'")}
                     and n.object_id=${requestKey('t')}) end) as eligible,
                  t.status as ticket_status,
                  t.workflow_state->>'actionOwner' as action_owner,
                  t.workflow_state->>'nextAction' as next_action,
                  t.workflow_state->>'withdrawalRequested' as withdrawal_requested
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
          kind: event.notification_kind as TicketCommunicationKind,
          action: clientAction(recipient, event.notification_kind as TicketCommunicationKind),
          recipient: recipient.email.trim(),
        };
      }
      return null;
    });
  }

  enqueueDueActionNotices(policy: ActionNoticeSweepPolicy): Promise<number> {
    const seconds = (value: number) => Number.isFinite(value) && value >= 0 ? value / 1000 : Number.NaN;
    const fresh = seconds(policy.freshWithinMs);
    const after = seconds(policy.reminderAfterMs);
    const within = seconds(policy.reminderWithinMs);
    if (!validDate(policy.now) || [fresh, after, within].some(Number.isNaN) || within <= after) throw new TicketReadInvariantError();
    const eligibleTicket = (actions: string) => `w.status='active' and w.settings_json->>'ticketing_write_mode'='enabled'
            and t.client_user_id is not null and t.status not in ('closed','declined','cancelled')
            and ${awaitingClient('t', actions)}`;
    return this.db.transaction(async sql => {
      const { rows } = await sql.query<{ id: string }>(
        `insert into alpha_private.ticket_communication_notifications
           (id,workspace_id,ticket_id,notification_kind,object_id,dedupe_key,status,available_at,created_at)
         select gen_random_uuid()::text,d.workspace_id,d.ticket_id,d.kind,d.object_id,
                'ticket-'||d.kind||':'||d.ticket_id||':'||d.object_id,'pending',$1::timestamptz,$1::timestamptz
           from (
             select t.workspace_id,t.id as ticket_id,'action' as kind,${requestKey('t')} as object_id
               from alpha_private.tickets t join public.workspaces w on w.id=t.workspace_id
              where ${eligibleTicket("'agree_scope','review_result'")}
                and t.client_updated_at >= $1::timestamptz - ($2::double precision * interval '1 second')
             union all
             select t.workspace_id,t.id,'reminder',${requestKey('t')}
               from alpha_private.tickets t join public.workspaces w on w.id=t.workspace_id
              where ${eligibleTicket("'reply','agree_scope','review_result'")}
                and t.client_updated_at <= $1::timestamptz - ($3::double precision * interval '1 second')
                and t.client_updated_at >= $1::timestamptz - ($4::double precision * interval '1 second')
           ) d
         on conflict (workspace_id,dedupe_key) do nothing
         returning id`, [policy.now, fresh, after, within],
      );
      return rows.length;
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
