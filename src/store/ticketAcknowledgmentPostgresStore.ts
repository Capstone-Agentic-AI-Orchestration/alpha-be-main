import { createHash, randomUUID } from 'node:crypto';
import type { TransactionalSql } from './database.js';

// Conservative window: below Resend's 24-hour and Brevo's documented
// idempotency TTLs. Never automatically resend outside this window.
export const ACKNOWLEDGMENT_RETRY_WINDOW_MS = 10 * 60_000;
export const ACKNOWLEDGMENT_MAX_ATTEMPTS = 5;

export interface TicketAcknowledgmentClaim {
  id: string;
  workspaceId: string;
  ticketId: string;
  recipient: string;
  leaseHash: string;
  attempt: number;
  firstAttemptAt: string;
  identityMatches: boolean;
}

interface ClaimRow {
  id: string; workspace_id: string; ticket_id: string; email: string; attempt: number;
  payload: Record<string, unknown>;
}

/** Uses the existing private outbox and cloud PG connection, never SQLite. */
export class PostgresTicketAcknowledgmentStore {
  constructor(private readonly db: TransactionalSql) {}

  async claim(providerIdentity: string): Promise<TicketAcknowledgmentClaim | null> {
    return this.db.transaction(async sql => {
      const { rows } = await sql.query<ClaimRow>(
        `select o.id, o.workspace_id, o.ticket_id, o.attempt, o.payload, c.email
         from alpha_private.ticket_outbox_events o
         join public.workspaces w on w.id = o.workspace_id and w.status = 'active'
         join alpha_private.tickets t on t.workspace_id = o.workspace_id and t.id = o.ticket_id
         join alpha_private.ticket_requests r on r.workspace_id = t.workspace_id and r.ticket_id = t.id
         join alpha_private.ticket_contacts c on c.workspace_id = r.workspace_id and c.id = r.contact_id
           and c.id = t.contact_id
         join alpha_private.ticket_intake_operations op on op.workspace_id = o.workspace_id
           and op.ticket_id = o.ticket_id and op.entry_id = r.intake_entry_id
           and op.entry_id = o.payload->>'entryId' and op.operation_id = o.payload->>'operationId'
         where o.status in ('pending', 'retry', 'leased') and o.available_at <= now()
           and (o.status <> 'leased' or o.lease_until <= now())
           and o.event_type = 'ticket_created' and o.payload->>'source' = 'public_inquiry'
           and o.payload->'acknowledgmentVersion' = '1'::jsonb
           and o.dedupe_key = 'ticket-created:' || op.entry_id || ':' || op.operation_id
           and t.source = 'public_inquiry' and r.source = 'public_inquiry'
           and w.settings_json->>'ticketing_write_mode' = 'enabled'
         order by o.available_at, o.created_at, o.id
         limit 1 for update of o skip locked`,
      );
      const row = rows[0];
      if (!row) return null;
      const identity = createHash('sha256').update(`${providerIdentity}\0${row.email}`).digest('hex');
      const previous = row.payload.acknowledgmentDispatch;
      const dispatch = previous && typeof previous === 'object' ? previous as Record<string, unknown> : null;
      const { rows: timestamps } = await sql.query<{ now: string }>('select now()::text as now');
      const startedAt = dispatch ? dispatch.firstAttemptAt : timestamps[0].now;
      // An existing attempt without valid metadata is unsafe, not a fresh send.
      const identityMatches = dispatch ? dispatch.identity === identity : row.attempt === 0 && previous === undefined;
      const firstAttemptAt = typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt)) ? startedAt : '';
      const leaseHash = createHash('sha256').update(randomUUID()).digest('hex');
      await sql.query(
        `update alpha_private.ticket_outbox_events
         set status = 'leased', lease_token_hash = $4, lease_until = now() + interval '2 minutes',
             attempt = attempt + 1,
             payload = case when attempt = 0 and not (payload ? 'acknowledgmentDispatch')
               then payload || jsonb_build_object('acknowledgmentDispatch', $5::jsonb) else payload end
         where workspace_id = $1 and ticket_id = $2 and id = $3`,
        [row.workspace_id, row.ticket_id, row.id, leaseHash, JSON.stringify({ firstAttemptAt, identity })],
      );
      return { id: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id,
        recipient: row.email, leaseHash, attempt: row.attempt + 1, firstAttemptAt, identityMatches };
    });
  }

  /** Fresh scope, lease and DB time check immediately before any provider call. */
  async canDispatch(claim: TicketAcknowledgmentClaim): Promise<boolean> {
    const { rows } = await this.db.query(
      `select o.id from alpha_private.ticket_outbox_events o
       join public.workspaces w on w.id = o.workspace_id and w.status = 'active'
       where o.workspace_id = $1 and o.ticket_id = $2 and o.id = $3
         and o.status = 'leased' and o.lease_token_hash = $4 and o.lease_until > now()
         and w.settings_json->>'ticketing_write_mode' = 'enabled'
         and $5::timestamptz <= now() and $5::timestamptz + interval '10 minutes' > now()`,
      [claim.workspaceId, claim.ticketId, claim.id, claim.leaseHash, claim.firstAttemptAt],
    );
    return rows.length === 1;
  }

  async finish(claim: TicketAcknowledgmentClaim, status: 'delivered' | 'retry' | 'dead',
    failure: 'provider_failure' | 'secret_integrity_failure' | 'attempt_limit_reached' | null = null): Promise<void> {
    // CAS prevents a delayed worker overwriting a newer worker's lease/result.
    await this.db.query(
      `update alpha_private.ticket_outbox_events
       set status = $5, failure_code = $6, lease_token_hash = null, lease_until = null,
           delivered_at = case when $5 = 'delivered' then now() else delivered_at end,
           available_at = case when $5 = 'retry' then now() + $7 * interval '1 second' else available_at end
       where workspace_id = $1 and ticket_id = $2 and id = $3
         and status = 'leased' and lease_token_hash = $4 and lease_until > now()`,
      [claim.workspaceId, claim.ticketId, claim.id, claim.leaseHash, status, failure,
        Math.min(240, 30 * 2 ** Math.max(0, claim.attempt - 1))],
    );
  }
}
