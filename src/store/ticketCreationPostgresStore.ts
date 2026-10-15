import { createHash, randomUUID } from 'node:crypto';

import { TicketReadInvariantError } from '../ticketing/readModels.js';
import type { Sql, TransactionalSql } from './database.js';
import type { SavedTicketOperation, TicketSubject, TicketTarget } from './ticketCommandStore.js';
import type {
  AuthorizedTicketCreateContext, SharedTicketProjectOption, TicketCreatedAudit,
  TicketCreatedRecord, TicketCreationStore, TicketCreationTransaction, TicketCreateOperationKey,
} from './ticketCreationStore.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { decodeTicketWorkflow, ticketWriteMode } from './ticketPostgresCodec.js';

interface CreateContextDbRow {
  id: string; workspace_id: string; client_user_id: string; status: string;
  accepts_new_requests: boolean; write_mode: string; display_name: string;
  workspace_write_mode: string | null;
}
interface ProjectOptionDbRow { project_id: string; display_name: string }
interface CreateOperationDbRow {
  workspace_id: string; client_id: string; operation_id: string; fingerprint: string;
  ticket_id: string; receipt: unknown;
}

function invalid(): never { throw new TicketReadInvariantError(); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}
function mergedMode(workspace: unknown, grant: unknown): 'enabled' | 'disabled' | 'maintenance' {
  const workspaceMode = ticketWriteMode(workspace);
  const grantMode = ticketWriteMode(grant);
  if (workspaceMode === 'maintenance' || grantMode === 'maintenance') return 'maintenance';
  return workspaceMode === 'enabled' && grantMode === 'enabled' ? 'enabled' : 'disabled';
}
function sameContext(a: AuthorizedTicketCreateContext | null, b: AuthorizedTicketCreateContext): boolean {
  return Boolean(a && a.id === b.id && a.workspaceId === b.workspaceId && a.clientId === b.clientId);
}
function targetKey(target: TicketTarget): string { return JSON.stringify([target.workspaceId, target.ticketId]); }
function createKey(key: TicketCreateOperationKey): string {
  return JSON.stringify([key.workspaceId, key.clientId, key.operationId]);
}

/**
 * A project-option ID is only an opaque selector, never an authorization token.
 * Every use still rechecks the current client grant and visible option row.
 */
export function ticketClientProjectOptionId(workspaceId: string, clientId: string, projectId: string): string {
  return createHash('sha256').update(JSON.stringify([workspaceId, clientId, projectId])).digest('hex');
}

function modeFor(row: CreateContextDbRow): AuthorizedTicketCreateContext['mode'] {
  return mergedMode(row.workspace_write_mode, row.write_mode);
}

function savedCreateOperation(row: CreateOperationDbRow, expected: TicketCreateOperationKey): Extract<SavedTicketOperation, { kind: 'create' }> {
  const raw = typeof row.receipt === 'string' ? (() => {
    try { return JSON.parse(row.receipt) as unknown; } catch { return null; }
  })() : row.receipt;
  if (row.workspace_id !== expected.workspaceId || row.client_id !== expected.clientId
    || row.operation_id !== expected.operationId || !text(row.ticket_id)
    || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !isRecord(raw)) return invalid();
  const keys = Object.keys(raw).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['operationId', 'reference', 'status', 'ticketId', 'version'])
    || raw.ticketId !== row.ticket_id || raw.operationId !== row.operation_id
    || !text(raw.reference) || raw.version !== 0 || raw.status !== 'received') return invalid();
  return {
    kind: 'create',
    key: {
      workspaceId: row.workspace_id, ticketId: row.ticket_id, actorKind: 'client',
      actorId: row.client_id, operationId: row.operation_id,
    },
    fingerprint: row.fingerprint,
    reference: raw.reference,
    receipt: { ticketId: row.ticket_id, operationId: row.operation_id, version: 0, status: 'received' },
  };
}

/**
 * SQL adapter for signed-in client ticket creation. It is constructed only by
 * the cloud composition; tests run it against the checked-in schema in PGlite.
 * Every query remains explicitly scoped because the cloud DB connection owns
 * these tables and bypasses RLS.
 */
export class PostgresTicketCreationStore implements TicketCreationStore {
  constructor(private readonly db: TransactionalSql) {}

  transaction<T>(work: (tx: TicketCreationTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(new PostgresTicketCreationTransaction(sql)));
  }
}

class PostgresTicketCreationTransaction implements TicketCreationTransaction {
  private readonly authorization: PostgresTicketAuthorization;
  private context: AuthorizedTicketCreateContext | null = null;
  private selectedOption: SharedTicketProjectOption | null = null;
  private createdTarget: TicketTarget | null = null;
  private createdReference: string | null = null;

  constructor(private readonly sql: Sql) {
    this.authorization = new PostgresTicketAuthorization(sql);
  }

  async lockAuthorizedCreateContext(contextId: string, subject: TicketSubject): Promise<AuthorizedTicketCreateContext | null> {
    if (subject.kind !== 'client' || !text(subject.userId) || !/^[a-f0-9]{64}$/.test(subject.sessionId)
      || !text(contextId)) return null;
    const { rows } = await this.sql.query<CreateContextDbRow>(
      `select sg.id, sg.workspace_id, sg.client_user_id, sg.status, sg.accepts_new_requests,
              sg.write_mode, sg.display_name, w.settings_json->>'ticketing_write_mode' as workspace_write_mode
       from public.workspaces w
       join alpha_private.ticket_client_sessions s
         on s.session_id_hash = $2 and s.client_user_id = $3
        and s.revoked_at is null and s.created_at <= now() and s.expires_at > now()
       join alpha_private.ticket_service_grants sg
         on sg.id = $1 and sg.workspace_id = w.id and sg.client_user_id = s.client_user_id
        and sg.status = 'active' and sg.revoked_at is null
       where w.status = 'active'
       for share of w, s, sg`,
      [contextId, subject.sessionId, subject.userId],
    );
    const row = rows[0];
    if (!row || row.id !== contextId || row.client_user_id !== subject.userId || row.status !== 'active'
      || typeof row.accepts_new_requests !== 'boolean' || typeof row.display_name !== 'string'
      || !row.display_name.trim()) return null;
    this.context = {
      id: row.id, workspaceId: row.workspace_id, clientId: row.client_user_id,
      accessActive: true, acceptsNewRequests: row.accepts_new_requests,
      mode: modeFor(row), companyLabel: row.display_name,
    };
    return { ...this.context };
  }

  async lockAuthorizedTicket(target: TicketTarget, subject: TicketSubject) {
    return this.authorization.lockTicket(target, subject, 'share');
  }

  async lockCreateOperation(key: TicketCreateOperationKey): Promise<Extract<SavedTicketOperation, { kind: 'create' }> | null> {
    const context = this.requireContext(key.workspaceId);
    if (key.clientId !== context.clientId || !text(key.operationId)) return invalid();
    // PostgreSQL advisory transaction locks serialize an absent key too. The
    // JSON array encoding is unambiguous; a hash collision only serializes more.
    await this.sql.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [createKey(key)]);
    const { rows } = await this.sql.query<CreateOperationDbRow>(
      `select workspace_id, client_id, operation_id, fingerprint, ticket_id, receipt
       from alpha_private.ticket_creation_operations
       where workspace_id = $1 and client_id = $2 and operation_id = $3
       for update`,
      [key.workspaceId, key.clientId, key.operationId],
    );
    return rows[0] ? savedCreateOperation(rows[0], key) : null;
  }

  async loadSharedProjectOption(context: AuthorizedTicketCreateContext, optionId: string): Promise<SharedTicketProjectOption | null> {
    this.requireExactContext(context);
    if (!/^[a-f0-9]{64}$/.test(optionId)) return null;
    const { rows } = await this.sql.query<ProjectOptionDbRow>(
      `select distinct on (ticket.project_id collate "C") ticket.project_id,
              coalesce(nullif(btrim(ticket.project_display_name),''), project.name) as display_name
       from alpha_private.tickets ticket
       join alpha_private.ticket_client_grants grant_row
         on grant_row.workspace_id=ticket.workspace_id and grant_row.ticket_id=ticket.id
        and grant_row.client_user_id=ticket.client_user_id and grant_row.active and grant_row.revoked_at is null
       join public.projects project
         on project.workspace_id=ticket.workspace_id and project.id=ticket.project_id
       where ticket.workspace_id=$1 and ticket.client_user_id=$2
         and ticket.project_id is not null and ticket.project_client_visible
       order by ticket.project_id collate "C", ticket.client_updated_at desc, ticket.id collate "C" desc
       limit 1001
      `,
      [context.workspaceId, context.clientId],
    );
    if (rows.length > 1000) return invalid();
    const candidate = rows.find(row => ticketClientProjectOptionId(context.workspaceId, context.clientId, row.project_id) === optionId);
    if (!candidate || !text(candidate.project_id)) return null;
    // Recheck and lock the exact currently visible project option before it is
    // used to create a ticket. The discovery query above is not authority.
    const { rows: currentRows } = await this.sql.query<ProjectOptionDbRow>(
      `select ticket.project_id,
              coalesce(nullif(btrim(ticket.project_display_name),''), project.name) as display_name
         from alpha_private.tickets ticket
         join alpha_private.ticket_client_grants grant_row
           on grant_row.workspace_id=ticket.workspace_id and grant_row.ticket_id=ticket.id
          and grant_row.client_user_id=ticket.client_user_id and grant_row.active and grant_row.revoked_at is null
         join public.projects project
           on project.workspace_id=ticket.workspace_id and project.id=ticket.project_id
        where ticket.workspace_id=$1 and ticket.client_user_id=$2 and ticket.project_id=$3
          and ticket.project_client_visible
        order by ticket.client_updated_at desc, ticket.id collate "C" desc
        limit 1
        for share of ticket, grant_row, project`,
      [context.workspaceId, context.clientId, candidate.project_id],
    );
    const match = currentRows[0];
    if (!match || !text(match.project_id) || !text(match.display_name)) return null;
    const option: SharedTicketProjectOption = {
      id: optionId, workspaceId: context.workspaceId, clientId: context.clientId,
      projectId: match.project_id, displayName: match.display_name, active: true, clientVisible: true,
    };
    this.selectedOption = option;
    return option;
  }

  async allocateReference(context: AuthorizedTicketCreateContext): Promise<string> {
    this.requireExactContext(context);
    // The database's workspace-scoped UNIQUE constraint is the final authority.
    return `TKT-${randomUUID().replaceAll('-', '').toUpperCase()}`;
  }

  async insertTicket(record: TicketCreatedRecord): Promise<void> {
    const context = this.requireContext(record.state.workspaceId);
    const { state, header, request } = record;
    const decoded = decodeTicketWorkflow(state);
    if (this.createdTarget || state.id !== header.ticketId || state.workspaceId !== header.workspaceId
      || state.version !== 0 || state.status !== 'received' || state.clientId !== context.clientId
      || state.scopeVersionId !== null || state.agreedScopeVersionId !== null || state.authorizedScopeVersionId !== null
      || state.projectId !== null || state.requiredIssueIds.length !== 0 || state.delivery !== null
      || state.withdrawalRequested || state.hold !== null || state.closureReason !== null
      || state.actionOwner !== 'pm' || state.nextAction !== 'review_ticket'
      || header.clientSafeCompanyLabel !== context.companyLabel || header.closedAt !== null
      || header.sharedProject !== null || request.source !== 'authenticated_client'
      || request.intakeContextId !== context.id || request.contact !== null
      || decoded.status !== state.status || decoded.version !== state.version) return invalid();

    let preference: string;
    let preferredProjectId: string | null = null;
    let requestedProjectLabel: string | null = null;
    if (request.projectPreference.kind === 'not_sure' || request.projectPreference.kind === 'new_project') {
      if (request.preferredProjectId !== null || request.requestedProjectLabel !== null) return invalid();
      preference = request.projectPreference.kind;
    } else {
      const option = this.selectedOption;
      if (!option || option.id !== request.projectPreference.optionId || !option.active || !option.clientVisible
        || option.workspaceId !== context.workspaceId || option.clientId !== context.clientId
        || request.preferredProjectId !== option.projectId || request.requestedProjectLabel !== option.displayName) return invalid();
      preference = 'shared_project';
      preferredProjectId = option.projectId;
      requestedProjectLabel = option.displayName;
    }
    if ((request.requestedDeadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(request.requestedDeadline))) return invalid();

    await this.sql.query(
      `insert into alpha_private.tickets
         (id, workspace_id, reference, title, description, client_safe_company_label, source, status, version,
          workflow_state, client_user_id, contact_id, project_id, project_display_name, project_client_visible,
          related_ticket_id, created_at, client_updated_at, internal_updated_at, closed_at)
       values ($1, $2, $3, $4, $5, $6, 'authenticated_client', $7, $8, $9::jsonb, $10, null,
               null, null, false, $11, $12, $13, $14, null)`,
      [state.id, state.workspaceId, header.reference, header.title, header.description,
        header.clientSafeCompanyLabel, state.status, state.version, JSON.stringify(decoded), context.clientId,
        header.relatedTicketId, header.createdAt, header.clientUpdatedAt, header.internalUpdatedAt],
    );
    await this.sql.query(
      `insert into alpha_private.ticket_requests
         (workspace_id, ticket_id, source, intake_context_id, intake_entry_id, project_preference,
          preferred_project_id, requested_project_label, requested_deadline, contact_id, submitted_at)
       values ($1, $2, 'authenticated_client', $3, null, $4, $5, $6, $7, null, $8)`,
      [state.workspaceId, state.id, context.id, preference, preferredProjectId,
        requestedProjectLabel, request.requestedDeadline, header.createdAt],
    );
    this.createdTarget = { workspaceId: state.workspaceId, ticketId: state.id };
    this.createdReference = header.reference;
  }

  async grantCreatedTicket(context: AuthorizedTicketCreateContext, target: TicketTarget): Promise<void> {
    this.requireExactContext(context);
    this.requireCreatedTarget(target);
    const { rows } = await this.sql.query<{ ticket_id: string }>(
      `insert into alpha_private.ticket_client_grants
         (workspace_id, ticket_id, client_user_id, active, created_at, revoked_at)
       select ticket.workspace_id, ticket.id, ticket.client_user_id, true, now(), null
       from alpha_private.tickets ticket
       join alpha_private.ticket_service_grants service_grant
         on service_grant.workspace_id = ticket.workspace_id
        and service_grant.client_user_id = ticket.client_user_id and service_grant.status = 'active'
       where ticket.workspace_id = $1 and ticket.id = $2 and ticket.client_user_id = $3
       returning ticket_id`,
      [target.workspaceId, target.ticketId, context.clientId],
    );
    if (rows.length !== 1 || rows[0].ticket_id !== target.ticketId) return invalid();
  }

  async appendCreatedAudit(audit: TicketCreatedAudit): Promise<void> {
    this.requireCreatedTarget(audit.target);
    const context = this.requireContext(audit.target.workspaceId);
    if (audit.clientId !== context.clientId || audit.type !== 'ticket_created' || !text(audit.operationId)) return invalid();
    await this.sql.query(
      `insert into alpha_private.ticket_audit_events
         (id, workspace_id, ticket_id, actor_kind, actor_id, event_type, occurred_at, metadata)
       values ($1, $2, $3, 'client', $4, 'ticket_created', $5, $6::jsonb)`,
      [randomUUID(), audit.target.workspaceId, audit.target.ticketId, audit.clientId, audit.occurredAt,
        JSON.stringify({ operationId: audit.operationId })],
    );
  }

  async enqueueCreated(signal: TicketCreatedAudit): Promise<void> {
    this.requireCreatedTarget(signal.target);
    const context = this.requireContext(signal.target.workspaceId);
    if (signal.clientId !== context.clientId || signal.type !== 'ticket_created' || !text(signal.operationId)) return invalid();
    await this.sql.query(
      `insert into alpha_private.ticket_outbox_events
         (id, workspace_id, ticket_id, event_type, dedupe_key, payload, status, available_at, created_at)
       values ($1, $2, $3, 'ticket_created', $4, $5::jsonb, 'pending', $6, $6)`,
      [randomUUID(), signal.target.workspaceId, signal.target.ticketId,
        `ticket-created:client:${signal.target.ticketId}:${signal.operationId}`,
        JSON.stringify({ source: 'authenticated_client', operationId: signal.operationId }), signal.occurredAt],
    );
  }

  async insertCreateOperation(operation: Extract<SavedTicketOperation, { kind: 'create' }>): Promise<void> {
    const context = this.requireContext(operation.key.workspaceId);
    const target = { workspaceId: operation.key.workspaceId, ticketId: operation.key.ticketId };
    this.requireCreatedTarget(target);
    if (operation.key.actorKind !== 'client' || operation.key.actorId !== context.clientId
      || !text(operation.key.operationId) || !/^[a-f0-9]{64}$/.test(operation.fingerprint)
      || !text(operation.reference) || operation.reference !== this.createdReference
      || operation.receipt.ticketId !== target.ticketId || operation.receipt.operationId !== operation.key.operationId
      || operation.receipt.version !== 0 || operation.receipt.status !== 'received') return invalid();
    await this.sql.query(
      `insert into alpha_private.ticket_creation_operations
         (workspace_id, client_id, operation_id, fingerprint, ticket_id, receipt, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, now())`,
      [target.workspaceId, context.clientId, operation.key.operationId, operation.fingerprint,
        target.ticketId, JSON.stringify({ ...operation.receipt, reference: operation.reference })],
    );
  }

  private requireContext(workspaceId: string): AuthorizedTicketCreateContext {
    if (!this.context || this.context.workspaceId !== workspaceId) return invalid();
    return this.context;
  }

  private requireExactContext(context: AuthorizedTicketCreateContext): AuthorizedTicketCreateContext {
    const current = this.requireContext(context.workspaceId);
    if (!sameContext(current, context)) return invalid();
    return current;
  }

  private requireCreatedTarget(target: TicketTarget): void {
    if (!this.createdTarget || targetKey(this.createdTarget) !== targetKey(target)) return invalid();
  }
}
