import type { TicketQueueStore, TicketQueueTransaction, LockedTicketQueue, TicketQueuePageRequest, TicketQueueMonth, TicketQueueCounters, TicketQueueRow } from './ticketQueueStore.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { type TransactionalSql, type Sql } from './database.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError, type TicketWorkflow } from '../ticketing/workflow.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { decodeTicketWorkflow, ticketSqlIso } from './ticketPostgresCodec.js';

interface QueueDbRow {
  workspace_id: string;
  ticket_id: string | null;
  reference: string | null;
  title: string | null;
  status: string | null;
  version: string | number | null;
  workflow_state: unknown;
  created_at: Date | string | null;
  client_updated_at: Date | string | null;
  internal_updated_at: Date | string | null;
  closed_at: Date | string | null;
  project_id: string | null;
  project_display_name: string | null;
  client_access_active: boolean | null;
  client_accepts_new_requests: boolean | null;
  client_service_active: boolean | null;
  client_group_key: string | null;
  client_group_name: string | null;
  invitation_status: string | null;
  invitation_expires_at: Date | string | null;
  invitation_delivery_status: string | null;
  cursor_found: boolean;
}

interface CountDbRow { open_count?: string | number; needs_client_count?: string | number; needs_pm_count?: string | number; in_progress_count?: string | number; waiting_client_count?: string | number; closed_month_count?: string | number }

function invariant(): never { throw new TicketReadInvariantError(); }

function queueFilterSql(filter: TicketQueuePageRequest['filter']): string {
  switch (filter) {
    case 'all': return 'true';
    case 'history': return `b.status = ANY(ARRAY['closed','declined','cancelled']::text[])`;
    case 'open': return `b.status <> ALL(ARRAY['closed','declined','cancelled']::text[])`;
    case 'needs_pm': return `b.status <> ALL(ARRAY['closed','declined','cancelled']::text[]) AND b.workflow_state->>'actionOwner' = 'pm' AND nullif(b.workflow_state->>'nextAction','') IS NOT NULL`;
    case 'in_progress': return `b.status = 'in_progress'`;
    case 'needs_client':
    case 'waiting_client':
      return `b.status <> ALL(ARRAY['closed','declined','cancelled']::text[])
        AND b.status <> 'on_hold'
        AND b.workflow_state->>'withdrawalRequested' IS DISTINCT FROM 'true'
        AND b.workflow_state->>'actionOwner' = 'client'
        AND b.workflow_state->>'nextAction' IN ('reply','agree_scope','review_result')
        AND b.client_access_active`;
    case 'closed_month':
      return `b.status IN ('closed','cancelled')
        AND b.workflow_state->>'closureReason' IN ('accepted','answered','cancelled')
        AND b.closed_at >= make_timestamptz($5, $6, 1, 0, 0, 0, $7)
        AND b.closed_at < make_timestamptz($5, $6, 1, 0, 0, 0, $7) + interval '1 month'`;
  }
}

/**
 * Ticket queue SQL uses the cloud's owner connection, which bypasses RLS.
 * Every read is therefore workspace-scoped here and rechecks the exact active
 * PM session/membership or client session/service grant before querying rows.
 * Desktop processes never construct this store; their internal API relays to
 * the cloud boundary.
 */
export class PostgresTicketQueueStore implements TicketQueueStore {
  constructor(private readonly db: TransactionalSql) {}

  transaction<T>(work: (tx: TicketQueueTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(new PostgresTicketQueueTransaction(sql)));
  }
}

class PostgresTicketQueueTransaction implements TicketQueueTransaction {
  private readonly authorization: PostgresTicketAuthorization;

  constructor(private readonly sql: Sql) {
    this.authorization = new PostgresTicketAuthorization(sql);
  }

  async lockAuthorizedQueue(workspaceId: string, subject: TicketSubject): Promise<LockedTicketQueue | null> {
    return this.authorization.lockQueueScope(workspaceId, subject);
  }

  async loadQueue(scope: LockedTicketQueue, page: TicketQueuePageRequest, month: TicketQueueMonth): Promise<TicketQueueRow[]> {
    const predicate = queueFilterSql(page.filter);
    const { rows } = await this.sql.query<QueueDbRow>(
      `with queue_month_parameters as (
         -- The year/month/zone binds are only referenced by the closed_month
         -- predicate. PostgreSQL still needs their types when another filter
         -- is selected because later positional binds are used for cursor/limit.
         select $5::int as year, $6::int as month, $7::text as time_zone
       ), base as (
         select t.workspace_id, t.id as ticket_id, t.reference, t.title, t.status, t.version,
                t.workflow_state, t.created_at, t.client_updated_at, t.internal_updated_at,
                t.closed_at, t.project_id,
                case when $2='pm' then t.project_display_name else null end as project_display_name,
                coalesce(sg.status = 'active' and sg.revoked_at is null and cg.active and cg.revoked_at is null, false) as client_access_active,
                case when $2='pm' and t.client_user_id is not null
                  then coalesce(sg.status='active' and sg.revoked_at is null and sg.accepts_new_requests,false) else false end as client_accepts_new_requests,
                case when $2='pm' and t.client_user_id is not null
                  then coalesce(sg.status='active' and sg.revoked_at is null,false) else false end as client_service_active,
                case when $2='pm' and t.client_user_id is not null then 'client:' || t.client_user_id
                     when $2='pm' then 'ticket:' || t.id else null end as client_group_key,
                case when $2<>'pm' then null
                  when t.client_user_id is null then coalesce(nullif(btrim(unverified_contact.full_name),''),'Unverified inquiry')
                  else coalesce(nullif(btrim(verified_contact.full_name),''), nullif(btrim(verified_contact.company),''),
                    nullif(nullif(btrim(sg.display_name),''),'Client portal'), 'Client account') end as client_group_name,
                invitation.status as invitation_status,
                invitation.expires_at as invitation_expires_at,
                invitation.delivery_status as invitation_delivery_status,
                case when $2 = 'pm' then t.internal_updated_at else t.client_updated_at end as sort_at
         from alpha_private.tickets t
         left join lateral (
           select grant_row.status, grant_row.revoked_at, grant_row.accepts_new_requests, grant_row.display_name
           from alpha_private.ticket_service_grants grant_row
        where grant_row.workspace_id = t.workspace_id and grant_row.client_user_id = t.client_user_id
           for share
         ) sg on true
         left join lateral (
           select grant_row.active, grant_row.revoked_at
           from alpha_private.ticket_client_grants grant_row
           where grant_row.workspace_id = t.workspace_id and grant_row.ticket_id = t.id
             and grant_row.client_user_id = t.client_user_id
           for share
         ) cg on true
         left join lateral (
           select contact.full_name
           from alpha_private.ticket_contacts contact
           where $2='pm' and t.client_user_id is null
             and contact.workspace_id=t.workspace_id and contact.id=t.contact_id
           limit 1
         ) unverified_contact on true
         left join lateral (
           select contact.full_name, contact.company
           from alpha_private.tickets linked_ticket
           join alpha_private.ticket_contacts contact
             on contact.workspace_id=linked_ticket.workspace_id and contact.id=linked_ticket.contact_id
           where $2='pm' and t.client_user_id is not null
             and linked_ticket.workspace_id=t.workspace_id and linked_ticket.client_user_id=t.client_user_id
             and contact.email_verified
           order by linked_ticket.created_at, linked_ticket.id collate "C"
           limit 1
         ) verified_contact on true
         left join lateral (
           select i.status, i.expires_at, o.status as delivery_status
           from alpha_private.ticket_invitations i
           left join alpha_private.ticket_outbox_events o
             on o.workspace_id=i.workspace_id and o.ticket_id=i.ticket_id
            and o.event_type='ticket_invitation_requested'
            and o.payload->>'activationVersion'='1' and o.payload->>'invitationId'=i.id
           where i.workspace_id=t.workspace_id and i.ticket_id=t.id and t.source='public_inquiry' and $2='pm'
           order by i.created_at desc, i.id desc
           limit 1
         ) invitation on true
         where t.workspace_id = $1
           and ($2 = 'pm' or (t.client_user_id = $3 and coalesce(
             sg.status = 'active' and sg.revoked_at is null and cg.active and cg.revoked_at is null, false)))
       ), filtered as (
         select b.* from base b
         where ($4 = '' or position(lower($4) in lower(b.reference || ' ' || b.title || ' ' || coalesce(b.client_group_name,''))) > 0)
           and (${predicate})
       ), cursor_row as (
         select sort_at, ticket_id from filtered where ticket_id = $8
       ), page_rows as (
         select f.* from filtered f
         where $8::text is null
            or (f.sort_at, f.ticket_id collate "C") <
               (select c.sort_at, c.ticket_id collate "C" from cursor_row c)
         order by f.sort_at desc, f.ticket_id collate "C" desc
         limit $9
       )
       select p.*, ($8::text is null or exists (select 1 from cursor_row)) as cursor_found
       from (select 1) seed
       left join page_rows p on true`,
      [scope.workspaceId, scope.principal.kind, scope.principal.userId, page.search,
        month.year, month.month, month.timeZone, page.after, page.limit + 1],
    );

    if (rows.some(row => row.cursor_found !== true)) {
      throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
    }
    return rows.filter((row): row is QueueDbRow & { ticket_id: string } => row.ticket_id !== null)
      .map(row => this.queueRow(row, scope));
  }

  async countQueue(scope: LockedTicketQueue, month: TicketQueueMonth): Promise<TicketQueueCounters> {
    const { rows } = await this.sql.query<CountDbRow>(
      `with base as (
         select t.status, t.closed_at, t.workflow_state,
                coalesce(sg.status = 'active' and cg.active, false) as client_access_active
         from alpha_private.tickets t
         left join lateral (
           select grant_row.status
           from alpha_private.ticket_service_grants grant_row
           where grant_row.workspace_id = t.workspace_id and grant_row.client_user_id = t.client_user_id
           for share
         ) sg on true
         left join lateral (
           select grant_row.active
           from alpha_private.ticket_client_grants grant_row
           where grant_row.workspace_id = t.workspace_id and grant_row.ticket_id = t.id
             and grant_row.client_user_id = t.client_user_id
           for share
         ) cg on true
         where t.workspace_id = $1
           and ($2 = 'pm' or (t.client_user_id = $3 and coalesce(sg.status = 'active' and cg.active, false)))
       )
       select
         count(*) filter (where status <> all(array['closed','declined','cancelled']::text[])) as open_count,
         count(*) filter (where status <> all(array['closed','declined','cancelled']::text[])
           and status <> 'on_hold'
           and workflow_state->>'withdrawalRequested' is distinct from 'true'
           and workflow_state->>'actionOwner' = 'client'
           and workflow_state->>'nextAction' in ('reply','agree_scope','review_result')
           and client_access_active) as needs_client_count,
         count(*) filter (where status <> all(array['closed','declined','cancelled']::text[])
           and workflow_state->>'actionOwner' = 'pm'
           and nullif(workflow_state->>'nextAction','') is not null) as needs_pm_count,
         count(*) filter (where status = 'in_progress') as in_progress_count,
         count(*) filter (where status <> all(array['closed','declined','cancelled']::text[])
           and status <> 'on_hold'
           and workflow_state->>'withdrawalRequested' is distinct from 'true'
           and workflow_state->>'actionOwner' = 'client'
           and workflow_state->>'nextAction' in ('reply','agree_scope','review_result')
           and client_access_active) as waiting_client_count,
         count(*) filter (where status in ('closed','cancelled')
           and workflow_state->>'closureReason' in ('accepted','answered','cancelled')
           and closed_at >= make_timestamptz($4, $5, 1, 0, 0, 0, $6)
           and closed_at < make_timestamptz($4, $5, 1, 0, 0, 0, $6) + interval '1 month') as closed_month_count
       from base`,
      [scope.workspaceId, scope.principal.kind, scope.principal.userId, month.year, month.month, month.timeZone],
    );
    const row = rows[0];
    if (!row) return invariant();
    if (scope.principal.kind === 'client') {
      return {
        kind: 'client',
        open: this.count(row.open_count),
        needsClient: this.count(row.needs_client_count),
      };
    }
    return {
      kind: 'pm',
      needsPm: this.count(row.needs_pm_count),
      inProgress: this.count(row.in_progress_count),
      waitingClient: this.count(row.waiting_client_count),
      closedMonth: this.count(row.closed_month_count),
    };
  }

  private count(value: string | number | undefined): number {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) return invariant();
    return count;
  }

  private queueRow(row: QueueDbRow & { ticket_id: string }, scope: LockedTicketQueue): TicketQueueRow {
    const state = decodeTicketWorkflow(row.workflow_state);
    if (state.id !== row.ticket_id || state.workspaceId !== scope.workspaceId
      || state.status !== row.status || state.version !== Number(row.version)
      || (state.clientId !== null && state.clientId !== scope.principal.userId && scope.principal.kind === 'client')) {
      return invariant();
    }

    // The client queue needs only public action/status fields. Do not retain
    // project, Issue, scope, or delivery IDs in a client-side queue row.
    const projectedState: TicketWorkflow = scope.principal.kind === 'client'
      ? { ...state, scopeVersionId: null, agreedScopeVersionId: null, authorizedScopeVersionId: null,
          projectId: null, requiredIssueIds: [], delivery: null, correctionRequestedFor: null, hold: null }
      : state;
    const actor = scope.principal.kind === 'pm'
      ? { kind: 'pm' as const, userId: scope.principal.userId, workspaceId: scope.workspaceId, membershipActive: true, canManageTickets: true }
      : { kind: 'client' as const, userId: scope.principal.userId, workspaceId: scope.workspaceId, ticketId: row.ticket_id, grantActive: row.client_access_active === true };

    let clientInvitation: TicketQueueRow['clientInvitation'] = null;
    if (row.invitation_status !== null || row.invitation_expires_at !== null || row.invitation_delivery_status !== null) {
      if (!row.invitation_status || row.invitation_expires_at === null
        || !['pending', 'expired', 'revoked', 'consumed'].includes(row.invitation_status)) return invariant();
      const delivery = row.invitation_delivery_status === 'pending' ? 'queued'
        : row.invitation_delivery_status === 'leased' ? 'sending'
          : row.invitation_delivery_status === 'retry' ? 'retrying'
            : row.invitation_delivery_status === 'delivered' ? 'accepted_by_provider'
              : row.invitation_delivery_status === 'dead' || row.invitation_delivery_status === 'discarded' ? 'failed'
                : row.invitation_delivery_status === null ? 'unknown' : null;
      if (!delivery) return invariant();
      clientInvitation = {
        status: row.invitation_status as NonNullable<TicketQueueRow['clientInvitation']>['status'],
        delivery,
        expiresAt: ticketSqlIso(row.invitation_expires_at),
      };
    }

    const pmClientGroup = scope.principal.kind === 'pm' ? (() => {
      if (typeof row.client_group_key !== 'string' || !row.client_group_key.trim()
        || typeof row.client_group_name !== 'string' || !row.client_group_name.trim()
        || typeof row.client_accepts_new_requests !== 'boolean') return invariant();
      if ((row.project_id === null) !== (row.project_display_name === null)
        || (row.project_display_name !== null && (!row.project_display_name.trim() || row.project_display_name.length > 200))) return invariant();
      return {
        key: row.client_group_key,
        displayName: row.client_group_name,
        acceptsNewRequests: row.client_accepts_new_requests,
        accessActive: row.client_service_active === true,
      };
    })() : undefined;

    return {
      ticket: { state: projectedState, actor, mode: scope.mode },
      clientAccessActive: row.client_access_active === true,
      clientInvitation,
      ...(pmClientGroup ? { pmClientGroup } : {}),
      ...(scope.principal.kind === 'pm' ? { pmProjectName: row.project_display_name } : {}),
      header: {
        workspaceId: row.workspace_id,
        ticketId: row.ticket_id,
        reference: row.reference ?? invariant(),
        title: row.title ?? invariant(),
        createdAt: ticketSqlIso(row.created_at),
        clientUpdatedAt: ticketSqlIso(row.client_updated_at),
        internalUpdatedAt: ticketSqlIso(row.internal_updated_at),
        closedAt: row.closed_at === null ? null : ticketSqlIso(row.closed_at),
      },
    };
  }
}
