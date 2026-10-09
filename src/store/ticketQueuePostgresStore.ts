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
  client_access_active: boolean | null;
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
                coalesce(sg.status = 'active' and cg.active, false) as client_access_active,
                case when $2 = 'pm' then t.internal_updated_at else t.client_updated_at end as sort_at
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
       ), filtered as (
         select b.* from base b
         where ($4 = '' or position(lower($4) in lower(b.reference || ' ' || b.title)) > 0)
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

    return {
      ticket: { state: projectedState, actor, mode: scope.mode },
      clientAccessActive: row.client_access_active === true,
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
