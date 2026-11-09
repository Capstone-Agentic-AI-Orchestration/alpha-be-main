import { randomUUID } from 'node:crypto';
import type { Sql, TransactionalSql } from './database.js';
import type { LockedTicket, SavedTicketOperation, TicketOperationKey, TicketSubject, TicketTarget } from './ticketCommandStore.js';
import type { TicketProjectManagementStore, TicketProjectManagementTransaction, TicketProjectLinkAudit,
  TicketSharedPreview, TicketWorkspaceProject } from './ticketProjectManagementStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { decodeTicketWorkflow } from './ticketPostgresCodec.js';

interface ReceiptDbRow { operation_kind: string; fingerprint: string; receipt: Record<string, unknown> }

function invalid(): never { throw new TicketReadInvariantError(); }

/** PM-only, workspace-scoped project links.
 * It uses the same cloud Postgres authority as the PM ticket queue.
 */
export class PostgresTicketProjectManagementStore implements TicketProjectManagementStore {
  constructor(private readonly db: TransactionalSql) {}

  transaction<T>(work: (tx: TicketProjectManagementTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(new PostgresTicketProjectManagementTransaction(sql)));
  }
}

class PostgresTicketProjectManagementTransaction implements TicketProjectManagementTransaction {
  private readonly authorization: PostgresTicketAuthorization;
  private locked: LockedTicket | null = null;

  constructor(private readonly sql: Sql) { this.authorization = new PostgresTicketAuthorization(sql); }

  async lockAuthorizedTicket(target: TicketTarget, subject: TicketSubject): Promise<LockedTicket | null> {
    this.locked = await this.authorization.lockTicket(target, subject, 'update');
    return this.locked;
  }

  async findOperation(key: TicketOperationKey): Promise<SavedTicketOperation | null> {
    this.requireKey(key);
    const { rows } = await this.sql.query<ReceiptDbRow>(
      `select operation_kind,fingerprint,receipt from alpha_private.ticket_operation_receipts
        where workspace_id=$1 and ticket_id=$2 and actor_kind=$3 and actor_id=$4 and operation_id=$5
        for share`,
      [key.workspaceId, key.ticketId, key.actorKind, key.actorId, key.operationId],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.operation_kind !== 'command' || !/^[a-f0-9]{64}$/.test(row.fingerprint)
      || !validReceipt(row.receipt, key.ticketId, key.operationId)) {
      return { kind: 'command', key, fingerprint: row.fingerprint, receipt: row.receipt as never };
    }
    return { kind: 'command', key, fingerprint: row.fingerprint, receipt: row.receipt as never };
  }

  async findWorkspaceProject(workspaceId: string, projectId: string): Promise<TicketWorkspaceProject | null> {
    const { rows } = await this.sql.query<{ id: string; name: string }>(
      `select id,name from public.projects where workspace_id=$1 and id=$2 for share`, [workspaceId, projectId],
    );
    const row = rows[0];
    if (!row) return null;
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.trim() !== row.name || row.name.length > 200) return invalid();
    return { id: row.id, name: row.name };
  }

  async loadCurrentProjectLink(target: TicketTarget) {
    if (!this.locked || this.locked.actor.kind !== 'pm' || target.workspaceId !== this.locked.state.workspaceId
      || target.ticketId !== this.locked.state.id) return invalid();
    const { rows } = await this.sql.query<{ project_id: string | null; project_display_name: string | null; project_client_visible: boolean;
      preview_repository: string | null; preview_branch: string | null; preview_url: string | null }>(
      `select t.project_id,t.project_display_name,t.project_client_visible,
              p.repository as preview_repository,p.branch as preview_branch,p.url as preview_url
         from alpha_private.tickets t
         left join alpha_private.ticket_project_client_previews p
           on p.workspace_id=t.workspace_id and p.ticket_id=t.id and p.project_id=t.project_id
        where t.workspace_id=$1 and t.id=$2 for share of t`, [target.workspaceId, target.ticketId],
    );
    const row = rows[0];
    if (!row || row.project_id !== this.locked.state.projectId || typeof row.project_client_visible !== 'boolean'
      || (row.project_id === null && (row.project_display_name !== null || row.project_client_visible))
      || (row.project_id !== null && (typeof row.project_display_name !== 'string' || !row.project_display_name.trim()))) return invalid();
    const previewColumns = [row.preview_repository, row.preview_branch, row.preview_url];
    const noPreview = previewColumns.every(value => value === null);
    const projectPreview: TicketSharedPreview | null = noPreview ? null : row.preview_repository && (row.preview_branch === 'main' || row.preview_branch === 'uat')
      && row.preview_url ? { repository: row.preview_repository, branch: row.preview_branch, url: row.preview_url } : invalid();
    return { projectId: row.project_id, projectName: row.project_display_name,
      clientVisible: row.project_client_visible, projectPreview };
  }

  async saveProjectLink(
    target: TicketTarget,
    expectedVersion: number,
    state: LockedTicket['state'],
    projectName: string | null,
    clientVisible: boolean,
    projectPreview: TicketSharedPreview | null,
    occurredAt: string,
  ): Promise<boolean> {
    if (!this.locked || this.locked.actor.kind !== 'pm' || target.workspaceId !== this.locked.state.workspaceId
      || target.ticketId !== this.locked.state.id || state.id !== target.ticketId || state.workspaceId !== target.workspaceId
      || state.version !== expectedVersion + 1 || (state.projectId === null && (projectName !== null || clientVisible))
      || (state.projectId !== null && (typeof projectName !== 'string' || !projectName.trim()
        || projectName.trim() !== projectName || projectName.length > 200))
      || (projectPreview !== null && (state.projectId === null || !clientVisible))
      || typeof clientVisible !== 'boolean' || state.status !== this.locked.state.status) return invalid();
    const { rows } = await this.sql.query<{ id: string }>(
      `update alpha_private.tickets
          set project_id=$4, project_display_name=$5, project_client_visible=$6,
              workflow_state=$7::jsonb, status=$8, version=$9,
              internal_updated_at=greatest(internal_updated_at,$10::timestamptz),
              client_updated_at=case when $6 or project_client_visible then greatest(client_updated_at,$10::timestamptz) else client_updated_at end
        where workspace_id=$1 and id=$2 and version=$3 and status not in ('closed','declined','cancelled')
        returning id`,
      [target.workspaceId, target.ticketId, expectedVersion, state.projectId, projectName, clientVisible,
        JSON.stringify(state), state.status, state.version, occurredAt],
    );
    if (rows.length !== 1) return false;
    if (projectPreview === null) {
      await this.sql.query('delete from alpha_private.ticket_project_client_previews where workspace_id=$1 and ticket_id=$2',
        [target.workspaceId, target.ticketId]);
    } else {
      await this.sql.query(
        `insert into alpha_private.ticket_project_client_previews
           (workspace_id,project_id,ticket_id,repository,branch,url,updated_by,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (workspace_id,ticket_id) do update set
           project_id=excluded.project_id,repository=excluded.repository,branch=excluded.branch,
           url=excluded.url,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
        [target.workspaceId, state.projectId, target.ticketId, projectPreview.repository, projectPreview.branch,
          projectPreview.url, this.locked.actor.userId, occurredAt]);
    }
    return true;
  }

  async appendProjectLinkAudit(audit: TicketProjectLinkAudit): Promise<void> {
    this.requireKey(audit.key);
    await this.sql.query(
      `insert into alpha_private.ticket_audit_events
         (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
       values ($1,$2,$3,'pm',$4,'ticket_project_link_changed',$5,$6::jsonb)`,
      [randomUUID(), audit.key.workspaceId, audit.key.ticketId, audit.key.actorId, audit.occurredAt,
        JSON.stringify({ operationId: audit.key.operationId, previousProjectId: audit.previousProjectId,
          projectId: audit.projectId, previousClientVisible: audit.previousClientVisible,
          clientVisible: audit.clientVisible, projectName: audit.projectName,
          previousProjectPreview: audit.previousProjectPreview, projectPreview: audit.projectPreview })],
    );
  }

  async enqueueChange(signal: { key: TicketOperationKey; version: number; occurredAt: string }): Promise<void> {
    this.requireKey(signal.key);
    await this.sql.query(
      `insert into alpha_private.ticket_outbox_events
         (id,workspace_id,ticket_id,event_type,dedupe_key,payload,status,available_at,created_at)
       values ($1,$2,$3,'ticket_changed',$4,$5::jsonb,'pending',$6,$6)`,
      [randomUUID(), signal.key.workspaceId, signal.key.ticketId,
        `ticket-project-link:${signal.key.ticketId}:${signal.key.actorId}:${signal.key.operationId}`,
        JSON.stringify({ version: signal.version, operationId: signal.key.operationId }), signal.occurredAt],
    );
  }

  async insertOperation(operation: Extract<SavedTicketOperation, { kind: 'command' }>): Promise<void> {
    this.requireKey(operation.key);
    if (operation.kind !== 'command' || !/^[a-f0-9]{64}$/.test(operation.fingerprint)
      || !validReceipt(operation.receipt, operation.key.ticketId, operation.key.operationId)) return invalid();
    const key = operation.key;
    await this.sql.query(
      `insert into alpha_private.ticket_operation_receipts
         (workspace_id,ticket_id,actor_kind,actor_id,operation_id,operation_kind,fingerprint,receipt)
       values ($1,$2,$3,$4,$5,'command',$6,$7::jsonb)`,
      [key.workspaceId, key.ticketId, key.actorKind, key.actorId, key.operationId,
        operation.fingerprint, JSON.stringify(operation.receipt)],
    );
  }

  private requireKey(key: TicketOperationKey): void {
    if (!this.locked || key.workspaceId !== this.locked.state.workspaceId || key.ticketId !== this.locked.state.id
      || key.actorId !== this.locked.actor.userId || this.locked.actor.kind !== 'pm' || key.actorKind !== 'pm') return invalid();
  }
}

function validReceipt(value: unknown, ticketId: string, operationId: string): value is { ticketId: string; operationId: string; version: number; status: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.ticketId === ticketId && row.operationId === operationId && Number.isSafeInteger(row.version)
    && Number(row.version) >= 0 && typeof row.status === 'string';
}
