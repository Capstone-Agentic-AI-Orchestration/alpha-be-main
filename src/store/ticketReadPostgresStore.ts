import type {
  TicketDeliveryReadRow, TicketDetailRows, TicketHeaderRow, TicketMessagePageRequest,
  TicketMessageReadRow, TicketPmScopeReadRow, TicketReadStore, TicketReadTransaction,
  TicketRequestReadRow, TicketScopeReadRow,
} from './ticketReadStore.js';
import type { LockedTicket, TicketSubject, TicketTarget } from './ticketCommandStore.js';
import { type Sql, type TransactionalSql } from './database.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { ticketSqlIso } from './ticketPostgresCodec.js';

interface TicketDetailDbRow {
  workspace_id: string;
  id: string;
  reference: string;
  title: string;
  description: string;
  client_safe_company_label: string;
  created_at: Date | string;
  client_updated_at: Date | string;
  internal_updated_at: Date | string;
  closed_at: Date | string | null;
  related_ticket_id: string | null;
  project_id: string | null;
  project_display_name: string | null;
  project_client_visible: boolean;
}
interface ScopeDbRow {
  id: string; workspace_id: string; ticket_id: string; public_summary: string;
  developer_brief?: string | null; immutable: boolean; client_visible: boolean; proposed_at: Date | string;
}
interface DeliveryDbRow {
  id: string; workspace_id: string; ticket_id: string; scope_version_id: string; pinned_asset_id: string;
  issue_revision_ids: unknown; immutable: boolean; client_visible: boolean; public_summary: string;
  shared_at: Date | string | null;
}
interface RequestDbRow {
  workspace_id: string; ticket_id: string; source: string; project_preference: string;
  preferred_project_id: string | null; requested_project_label: string | null; requested_deadline: string | null;
  full_name: string | null; email: string | null; company: string | null;
}
interface RelatedDbRow {
  workspace_id: string; ticket_id: string; reference: string; title: string;
  client_user_id: string | null; client_grant_active: boolean;
}
interface MessageDbRow {
  workspace_id: string; ticket_id: string | null; id: string | null; author_kind: string | null;
  author_id: string | null; audience: string | null; body: string | null;
  created_at: Date | string | null; cursor_found: boolean;
}

function invalid(): never { throw new TicketReadInvariantError(); }
function asBoolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }

function requestPreference(value: string, optionId: string | null): TicketRequestReadRow['projectPreference'] {
  if (value === 'not_sure') return { kind: 'not_sure' };
  if (value === 'new_project') return { kind: 'new_project' };
  if (value === 'shared_project' && optionId) return { kind: 'shared_project', optionId };
  return invalid();
}

function stringArray(value: unknown): string[] {
  const decoded = typeof value === 'string' ? (() => {
    try { return JSON.parse(value) as unknown; } catch { return null; }
  })() : value;
  if (!Array.isArray(decoded) || decoded.some(item => typeof item !== 'string')) return invalid();
  return decoded;
}

export class PostgresTicketReadStore implements TicketReadStore {
  constructor(private readonly db: TransactionalSql) {}

  transaction<T>(work: (tx: TicketReadTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(new PostgresTicketReadTransaction(sql)));
  }
}

class PostgresTicketReadTransaction implements TicketReadTransaction {
  private readonly authorization: PostgresTicketAuthorization;

  constructor(private readonly sql: Sql) {
    this.authorization = new PostgresTicketAuthorization(sql);
  }

  lockAuthorizedTicket(target: TicketTarget, subject: TicketSubject): Promise<LockedTicket | null> {
    return this.authorization.lockTicket(target, subject, 'share');
  }

  async loadDetail(ticket: LockedTicket): Promise<TicketDetailRows> {
    const { state, actor } = ticket;
    const { rows: ticketRows } = await this.sql.query<TicketDetailDbRow>(
      `select workspace_id, id, reference, title, description, client_safe_company_label,
              created_at, client_updated_at, internal_updated_at, closed_at, related_ticket_id,
              project_id, project_display_name, project_client_visible
       from alpha_private.tickets
       where workspace_id = $1 and id = $2
       for share`,
      [state.workspaceId, state.id],
    );
    const row = ticketRows[0];
    if (!row) throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
    if (row.workspace_id !== state.workspaceId || row.id !== state.id || row.project_id !== state.projectId
      || (row.closed_at !== null && !['closed', 'declined', 'cancelled'].includes(state.status))) return invalid();

    const header: TicketHeaderRow = {
      workspaceId: row.workspace_id,
      ticketId: row.id,
      reference: row.reference,
      title: row.title,
      description: row.description,
      clientSafeCompanyLabel: row.client_safe_company_label,
      createdAt: ticketSqlIso(row.created_at),
      clientUpdatedAt: ticketSqlIso(row.client_updated_at),
      internalUpdatedAt: ticketSqlIso(row.internal_updated_at),
      closedAt: row.closed_at === null ? null : ticketSqlIso(row.closed_at),
      relatedTicketId: row.related_ticket_id,
      sharedProject: row.project_id === null ? null : {
        projectId: row.project_id,
        displayName: row.project_display_name ?? '',
        clientVisible: asBoolean(row.project_client_visible),
      },
    };

    let currentScope: TicketScopeReadRow | null = null;
    let currentPmScope: TicketPmScopeReadRow | undefined;
    if (state.scopeVersionId) {
      const pmColumns = actor.kind === 'pm' ? ', developer_brief' : '';
      const { rows } = await this.sql.query<ScopeDbRow>(
        `select id, workspace_id, ticket_id, public_summary${pmColumns}, immutable, client_visible, proposed_at
         from alpha_private.ticket_scopes
         where workspace_id = $1 and ticket_id = $2 and id = $3
         for share`,
        [state.workspaceId, state.id, state.scopeVersionId],
      );
      const scope = rows[0];
      if (!scope) return invalid();
      currentScope = {
        workspaceId: scope.workspace_id, ticketId: scope.ticket_id, id: scope.id,
        publicSummary: scope.public_summary, immutable: asBoolean(scope.immutable),
        clientVisible: asBoolean(scope.client_visible), proposedAt: ticketSqlIso(scope.proposed_at),
      };
      if (actor.kind === 'pm') {
        if (typeof scope.developer_brief !== 'string') return invalid();
        currentPmScope = {
          workspaceId: scope.workspace_id, ticketId: scope.ticket_id,
          id: scope.id, developerBrief: scope.developer_brief,
        };
      }
    }

    let currentDelivery: TicketDeliveryReadRow | null = null;
    if (state.delivery) {
      const { rows } = await this.sql.query<DeliveryDbRow>(
        `select id, workspace_id, ticket_id, scope_version_id, pinned_asset_id, issue_revision_ids,
                immutable, client_visible, public_summary, shared_at
         from alpha_private.ticket_deliveries
         where workspace_id = $1 and ticket_id = $2 and id = $3
         for share`,
        [state.workspaceId, state.id, state.delivery.id],
      );
      const delivery = rows[0];
      if (!delivery) return invalid();
      currentDelivery = {
        workspaceId: delivery.workspace_id, ticketId: delivery.ticket_id, id: delivery.id,
        scopeVersionId: delivery.scope_version_id, pinnedAssetId: delivery.pinned_asset_id,
        issueRevisionIds: stringArray(delivery.issue_revision_ids),
        immutable: asBoolean(delivery.immutable), clientVisible: asBoolean(delivery.client_visible),
        publicSummary: delivery.public_summary,
        sharedAt: delivery.shared_at === null ? null : ticketSqlIso(delivery.shared_at),
      };
    }

    const contactColumns = actor.kind === 'pm'
      ? 'c.full_name, c.email, c.company'
      : 'null::text as full_name, null::text as email, null::text as company';
    const { rows: requestRows } = await this.sql.query<RequestDbRow>(
      `select r.workspace_id, r.ticket_id, r.source, r.project_preference, r.preferred_project_id,
              r.requested_project_label, r.requested_deadline, ${contactColumns}
       from alpha_private.ticket_requests r
       left join alpha_private.ticket_contacts c
         on c.workspace_id = r.workspace_id and c.id = r.contact_id
       where r.workspace_id = $1 and r.ticket_id = $2
       for share of r`,
      [state.workspaceId, state.id],
    );
    const requestRow = requestRows[0];
    const request: TicketRequestReadRow | null = requestRow ? {
      workspaceId: requestRow.workspace_id,
      ticketId: requestRow.ticket_id,
      source: requestRow.source === 'authenticated_client' || requestRow.source === 'public_inquiry'
        ? requestRow.source : invalid(),
      projectPreference: requestPreference(requestRow.project_preference, requestRow.preferred_project_id),
      preferredProjectId: requestRow.preferred_project_id,
      requestedProjectLabel: requestRow.requested_project_label,
      requestedDeadline: requestRow.requested_deadline,
      contact: actor.kind === 'pm' && requestRow.full_name !== null && requestRow.email !== null
        ? { fullName: requestRow.full_name, email: requestRow.email, company: requestRow.company }
        : null,
    } : null;

    let related: TicketDetailRows['related'] = null;
    if (row.related_ticket_id) {
      const { rows } = await this.sql.query<RelatedDbRow>(
        `select related.workspace_id, related.id as ticket_id, related.reference, related.title,
                related.client_user_id,
                true as client_grant_active
         from alpha_private.tickets related
         join lateral (
           select service_grant.status
           from alpha_private.ticket_service_grants service_grant
           where service_grant.workspace_id = related.workspace_id
             and service_grant.client_user_id = related.client_user_id and service_grant.status = 'active'
           for share
         ) sg on true
         join lateral (
           select ticket_grant.active
           from alpha_private.ticket_client_grants ticket_grant
           where ticket_grant.workspace_id = related.workspace_id and ticket_grant.ticket_id = related.id
             and ticket_grant.client_user_id = related.client_user_id and ticket_grant.active
           for share
         ) cg on true
         where related.workspace_id = $1 and related.id = $2
           and related.client_user_id = $3 and sg.status = 'active' and cg.active
         for share of related`,
        [state.workspaceId, row.related_ticket_id, state.clientId],
      );
      const relatedRow = rows[0];
      if (relatedRow) {
        related = {
          workspaceId: relatedRow.workspace_id, ticketId: relatedRow.ticket_id,
          reference: relatedRow.reference, title: relatedRow.title,
          clientId: relatedRow.client_user_id, clientGrantActive: relatedRow.client_grant_active === true,
        };
      }
    }

    return {
      header, currentScope, ...(actor.kind === 'pm' ? { currentPmScope: currentPmScope ?? null } : {}),
      currentDelivery, related, request,
    };
  }

  async loadMessages(ticket: LockedTicket, audience: 'client' | 'internal', page: TicketMessagePageRequest): Promise<TicketMessageReadRow[]> {
    if (audience === 'internal' && ticket.actor.kind !== 'pm') {
      throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot read internal ticket notes.');
    }
    const { rows } = await this.sql.query<MessageDbRow>(
      `with scoped as (
         select workspace_id, ticket_id, id, author_kind, author_id, audience, body, created_at
         from alpha_private.ticket_messages
         where workspace_id = $1 and ticket_id = $2 and audience = $3
       ), cursor_row as (
         select created_at, id from scoped where id = $4
       ), page_rows as (
         select m.* from scoped m
         where $4::text is null
            or (m.created_at, m.id collate "C") >
               (select c.created_at, c.id collate "C" from cursor_row c)
         order by m.created_at asc, m.id collate "C" asc
         limit $5
       )
       select p.*, ($4::text is null or exists (select 1 from cursor_row)) as cursor_found
       from (select 1) seed
       left join page_rows p on true`,
      [ticket.state.workspaceId, ticket.state.id, audience, page.after, page.limit + 1],
    );
    if (rows.some(row => row.cursor_found !== true)) {
      throw new TicketWorkflowError(404, 'ticket_message_not_found', 'Message not found.');
    }
    return rows.filter((row): row is MessageDbRow & { id: string; ticket_id: string; author_kind: string; author_id: string; audience: string; body: string; created_at: Date | string } => row.id !== null)
      .map(row => {
        if (row.author_kind !== 'pm' && row.author_kind !== 'client') return invalid();
        if (row.audience !== 'client' && row.audience !== 'internal') return invalid();
        if (row.author_id === null || row.body === null || row.created_at === null) return invalid();
        return {
          workspaceId: row.workspace_id, ticketId: row.ticket_id, id: row.id,
          authorKind: row.author_kind, authorId: row.author_id, audience: row.audience,
          body: row.body, createdAt: ticketSqlIso(row.created_at),
        };
      });
  }
}
