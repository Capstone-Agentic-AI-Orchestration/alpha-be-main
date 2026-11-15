import type { TicketQueueStore, TicketQueueTransaction, LockedTicketQueue, TicketQueuePageRequest, TicketQueueMonth, TicketQueueCounters, TicketQueueRow, TicketQueueClientGroup, TicketQueueClientSummary } from './ticketQueueStore.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { type TransactionalSql, type Sql } from './database.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError, type TicketWorkflow } from '../ticketing/workflow.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { decodeTicketWorkflow, ticketSqlIso } from './ticketPostgresCodec.js';
import { CLIENT_GROUP_KEY_SQL, CLIENT_TICKET_ACCESS_JOINS_SQL, CLIENT_VISIBLE_PROJECT_SQL, clientContactJoinsSql, clientGroupNameSql } from './ticketClientSql.js';

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
  client_service_active: boolean | null;
  client_group_key: string | null;
  client_group_name: string | null;
  invitation_status: string | null;
  invitation_expires_at: Date | string | null;
  invitation_delivery_status: string | null;
  client_reply_unread: boolean | null;
  cursor_found: boolean;
}

interface CountDbRow { open_count?: string | number; needs_client_count?: string | number; needs_pm_count?: string | number; in_progress_count?: string | number; waiting_client_count?: string | number; closed_month_count?: string | number }
interface ClientGroupDbRow { client_group_key: string | null; client_group_name: string | null }
interface ClientSummaryDbRow {
  client_group_key: string | null; display_name: string | null; company: string | null; service_active: boolean | null;
  needs_pm_count: string | number; waiting_client_count: string | number; open_count: string | number;
  closed_count: string | number; unlinked_open_count: string | number; access_revoked_count: string | number;
  last_activity_at: Date | string | null; projects: unknown;
}

/*
 * Count predicates over a CTE with the ticket's status, workflow_state and
 * client_access_active. countQueue and listClients both use these, so a
 * client's numbers on the Clients list match the queue filtered to that client.
 */
const COUNT_OPEN_SQL = `status <> all(array['closed','declined','cancelled']::text[])`;
const COUNT_NEEDS_PM_SQL = `${COUNT_OPEN_SQL}
           and workflow_state->>'actionOwner' = 'pm'
           and nullif(workflow_state->>'nextAction','') is not null`;
const COUNT_WAITING_CLIENT_SQL = `${COUNT_OPEN_SQL}
           and status <> 'on_hold'
           and workflow_state->>'withdrawalRequested' is distinct from 'true'
           and workflow_state->>'actionOwner' = 'client'
           and workflow_state->>'nextAction' in ('reply','agree_scope','review_result')
           and client_access_active`;

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
                  then coalesce(sg.status='active' and sg.revoked_at is null,false) else false end as client_service_active,
                case when $2='pm' then ${CLIENT_GROUP_KEY_SQL} else null end as client_group_key,
                case when $2<>'pm' then null else ${clientGroupNameSql('sg.display_name')} end as client_group_name,
                invitation.status as invitation_status,
                invitation.expires_at as invitation_expires_at,
                invitation.delivery_status as invitation_delivery_status,
                case when $2='pm' then exists (
                  select 1 from alpha_private.ticket_messages client_message
                  left join alpha_private.ticket_pm_read_cursors read_cursor
                    on read_cursor.workspace_id=t.workspace_id and read_cursor.ticket_id=t.id and read_cursor.pm_user_id=$3
                  where client_message.workspace_id=t.workspace_id and client_message.ticket_id=t.id
                    and client_message.audience='client' and client_message.author_kind='client'
                    and client_message.created_at > coalesce(read_cursor.last_read_at, '-infinity'::timestamptz)
                ) else false end as client_reply_unread,
                case when $2 = 'pm' then t.internal_updated_at else t.client_updated_at end as sort_at
         from alpha_private.tickets t
         left join lateral (
           select grant_row.status, grant_row.revoked_at, grant_row.display_name
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
         ${clientContactJoinsSql("$2='pm'")}
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
           and ($10::text is null or b.client_group_key = $10)
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
        month.year, month.month, month.timeZone, page.after, page.limit + 1, page.clientGroupKey ?? null],
    );

    if (rows.some(row => row.cursor_found !== true)) {
      throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
    }
    return rows.filter((row): row is QueueDbRow & { ticket_id: string } => row.ticket_id !== null)
      .map(row => this.queueRow(row, scope));
  }

  async listClientGroups(scope: LockedTicketQueue): Promise<TicketQueueClientGroup[]> {
    const { rows } = await this.sql.query<ClientGroupDbRow>(
      `with group_rows as (
         select ${CLIENT_GROUP_KEY_SQL} as client_group_key,
                ${clientGroupNameSql('sg.display_name')} as client_group_name
         from alpha_private.tickets t
         left join lateral (
           select grant_row.display_name
           from alpha_private.ticket_service_grants grant_row
           where grant_row.workspace_id = t.workspace_id and grant_row.client_user_id = t.client_user_id
           limit 1
         ) sg on true
         ${clientContactJoinsSql()}
         where t.workspace_id = $1
       ), distinct_groups as (
         select distinct on (client_group_key) client_group_key, client_group_name
         from group_rows
         order by client_group_key, client_group_name
       )
       select client_group_key, client_group_name
       from distinct_groups
       order by lower(client_group_name), client_group_key`,
      [scope.workspaceId],
    );
    return rows.map(row => {
      if (typeof row.client_group_key !== 'string' || !row.client_group_key.trim()
        || typeof row.client_group_name !== 'string' || !row.client_group_name.trim()) return invariant();
      return { key: row.client_group_key, displayName: row.client_group_name };
    });
  }

  async listClients(scope: LockedTicketQueue): Promise<TicketQueueClientSummary[]> {
    if (scope.principal.kind !== 'pm') return invariant();
    const { rows } = await this.sql.query<ClientSummaryDbRow>(
      `with base as (
         select t.status, t.workflow_state, t.internal_updated_at,
                ${CLIENT_GROUP_KEY_SQL} as client_group_key,
                ${clientGroupNameSql('sg.display_name')} as client_group_name,
                nullif(btrim(verified_contact.company), '') as company,
                -- The same access test countQueue uses, so the counts agree.
                coalesce(sg.status = 'active' and cg.active, false) as client_access_active,
                coalesce(sg.status = 'active' and sg.revoked_at is null, false) as service_active,
                coalesce(cg.active and cg.revoked_at is null, false) as ticket_grant_active,
                coalesce(${CLIENT_VISIBLE_PROJECT_SQL}, false) as project_visible
         from alpha_private.tickets t
         left join lateral (
           select grant_row.status, grant_row.revoked_at, grant_row.display_name
           from alpha_private.ticket_service_grants grant_row
           where grant_row.workspace_id = t.workspace_id and grant_row.client_user_id = t.client_user_id
         ) sg on true
         left join lateral (
           select grant_row.active, grant_row.revoked_at
           from alpha_private.ticket_client_grants grant_row
           where grant_row.workspace_id = t.workspace_id and grant_row.ticket_id = t.id
             and grant_row.client_user_id = t.client_user_id
         ) cg on true
         ${clientContactJoinsSql()}
         where t.workspace_id = $1 and t.client_user_id is not null
       ), clients as (
         select client_group_key,
                min(client_group_name) as display_name,
                min(company) as company,
                bool_or(service_active) as service_active,
                count(*) filter (where ${COUNT_NEEDS_PM_SQL}) as needs_pm_count,
                count(*) filter (where ${COUNT_WAITING_CLIENT_SQL}) as waiting_client_count,
                count(*) filter (where ${COUNT_OPEN_SQL}) as open_count,
                count(*) filter (where not (${COUNT_OPEN_SQL})) as closed_count,
                count(*) filter (where ${COUNT_OPEN_SQL} and not project_visible) as unlinked_open_count,
                count(*) filter (where service_active and not ticket_grant_active) as access_revoked_count,
                max(internal_updated_at) as last_activity_at
         from base
         group by client_group_key
       ), client_projects as (
         -- Exactly what the client portal lists for this client.
         select distinct ${CLIENT_GROUP_KEY_SQL} as client_group_key, t.project_id, p.name,
                exists (
                  select 1 from alpha_private.client_uat_rounds r
                  where r.workspace_id = t.workspace_id and r.project_id = t.project_id
                    and r.client_user_id = t.client_user_id
                    and r.status in ('published','submitted') and r.published_at is not null
                ) as preview_published
         from alpha_private.tickets t
         ${CLIENT_TICKET_ACCESS_JOINS_SQL}
         join public.projects p on p.id = t.project_id and p.workspace_id = t.workspace_id
         where t.workspace_id = $1 and t.client_user_id is not null and ${CLIENT_VISIBLE_PROJECT_SQL}
       )
       select c.*,
              coalesce((
                select json_agg(json_build_object('projectId', cp.project_id, 'name', cp.name,
                  'previewPublished', cp.preview_published) order by lower(cp.name), cp.project_id collate "C")
                from client_projects cp where cp.client_group_key = c.client_group_key
              ), '[]'::json) as projects
       from clients c
       order by c.needs_pm_count desc, c.last_activity_at desc, c.client_group_key collate "C"`,
      [scope.workspaceId],
    );
    return rows.map(row => this.clientSummary(row));
  }

  private clientSummary(row: ClientSummaryDbRow): TicketQueueClientSummary {
    if (typeof row.client_group_key !== 'string' || !row.client_group_key.startsWith('client:')
      || typeof row.display_name !== 'string' || !row.display_name.trim()
      || (row.company !== null && (typeof row.company !== 'string' || !row.company.trim()))
      || typeof row.service_active !== 'boolean' || row.last_activity_at === null) return invariant();
    const raw = typeof row.projects === 'string' ? JSON.parse(row.projects) as unknown : row.projects;
    if (!Array.isArray(raw)) return invariant();
    const projects = raw.map(item => {
      const project = item as Record<string, unknown> | null;
      if (!project || typeof project.projectId !== 'string' || !project.projectId
        || typeof project.name !== 'string' || !project.name.trim()
        || typeof project.previewPublished !== 'boolean') return invariant();
      return { projectId: project.projectId, name: project.name, previewPublished: project.previewPublished };
    });
    return {
      key: row.client_group_key,
      displayName: row.display_name,
      company: row.company,
      access: row.service_active ? 'active' : 'inactive',
      tickets: {
        needsPm: this.count(row.needs_pm_count),
        waitingClient: this.count(row.waiting_client_count),
        open: this.count(row.open_count),
        closed: this.count(row.closed_count),
        unlinkedOpen: this.count(row.unlinked_open_count),
        accessRevoked: this.count(row.access_revoked_count),
      },
      projects,
      lastActivityAt: ticketSqlIso(row.last_activity_at),
    };
  }

  async countQueue(scope: LockedTicketQueue, month: TicketQueueMonth, clientGroupKey?: string): Promise<TicketQueueCounters> {
    // A client filter is a PM view; the service rejects it for a client before this point.
    if (clientGroupKey !== undefined && scope.principal.kind !== 'pm') return invariant();
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
           and ($7::text is null or (${CLIENT_GROUP_KEY_SQL}) = $7)
       )
       select
         count(*) filter (where ${COUNT_OPEN_SQL}) as open_count,
         count(*) filter (where ${COUNT_WAITING_CLIENT_SQL}) as needs_client_count,
         count(*) filter (where ${COUNT_NEEDS_PM_SQL}) as needs_pm_count,
         count(*) filter (where status = 'in_progress') as in_progress_count,
         count(*) filter (where ${COUNT_WAITING_CLIENT_SQL}) as waiting_client_count,
         count(*) filter (where status in ('closed','cancelled')
           and workflow_state->>'closureReason' in ('accepted','answered','cancelled')
           and closed_at >= make_timestamptz($4, $5, 1, 0, 0, 0, $6)
           and closed_at < make_timestamptz($4, $5, 1, 0, 0, 0, $6) + interval '1 month') as closed_month_count
       from base`,
      [scope.workspaceId, scope.principal.kind, scope.principal.userId, month.year, month.month, month.timeZone, clientGroupKey ?? null],
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
        || typeof row.client_group_name !== 'string' || !row.client_group_name.trim()) return invariant();
      if ((row.project_id === null) !== (row.project_display_name === null)
        || (row.project_display_name !== null && (!row.project_display_name.trim() || row.project_display_name.length > 200))) return invariant();
      return {
        key: row.client_group_key,
        displayName: row.client_group_name,
      };
    })() : undefined;

    return {
      ticket: { state: projectedState, actor, mode: scope.mode },
      clientAccessActive: row.client_access_active === true,
      clientInvitation,
      ...(pmClientGroup ? { pmClientGroup } : {}),
      ...(scope.principal.kind === 'pm' ? { pmProjectName: row.project_display_name } : {}),
      ...(scope.principal.kind === 'pm' ? { pmClientReplyUnread: row.client_reply_unread === true } : {}),
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
