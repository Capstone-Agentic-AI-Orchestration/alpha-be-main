import type { TransactionalSql, Sql } from './database.js';
import type { TicketSubject } from './ticketCommandStore.js';
import type { AuthorizedTicketCreateContext, SharedTicketProjectOption } from './ticketCreationStore.js';
import type { TicketClientIntakeContextStore, TicketClientIntakeContextTransaction } from './ticketClientIntakeContextStore.js';
import { ticketClientProjectOptionId } from './ticketCreationPostgresStore.js';

interface ContextDbRow {
  id: string;
  workspace_id: string;
  client_user_id: string;
  status: string;
  write_mode: string;
  display_name: string;
  workspace_write_mode: string | null;
}
interface ProjectOptionDbRow { project_id: string; display_name: string }

function modeFor(row: ContextDbRow): 'enabled' | 'disabled' | 'maintenance' {
  if (row.write_mode === 'maintenance' || row.workspace_write_mode === 'maintenance') return 'maintenance';
  return row.write_mode === 'enabled' && row.workspace_write_mode === 'enabled' ? 'enabled' : 'disabled';
}

/** Cloud-only signed-in client intake context. Project choices are derived only
 * from projects the PM explicitly exposed on an already-authorized ticket.
 */
export class PostgresTicketClientIntakeContextStore implements TicketClientIntakeContextStore {
  constructor(private readonly db: TransactionalSql) {}

  transaction<T>(work: (tx: TicketClientIntakeContextTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(new PostgresTicketClientIntakeContextTransaction(sql)));
  }
}

class PostgresTicketClientIntakeContextTransaction implements TicketClientIntakeContextTransaction {
  private resolved: AuthorizedTicketCreateContext | null = null;

  constructor(private readonly sql: Sql) {}

  async resolveAuthorizedContext(
    workspaceId: string,
    subject: Extract<TicketSubject, { kind: 'client' }>,
  ): Promise<AuthorizedTicketCreateContext | null> {
    if (subject.kind !== 'client' || !text(workspaceId) || !text(subject.userId)
      || !/^[a-f0-9]{64}$/.test(subject.sessionId)) return null;
    const { rows } = await this.sql.query<ContextDbRow>(
      `select sg.id, sg.workspace_id, sg.client_user_id, sg.status,
              sg.write_mode, sg.display_name, w.settings_json->>'ticketing_write_mode' as workspace_write_mode
         from public.workspaces w
         join alpha_private.ticket_client_sessions s
           on s.session_id_hash=$2 and s.client_user_id=$3
          and s.revoked_at is null and s.created_at<=now() and s.expires_at>now()
         join alpha_private.ticket_service_grants sg
           on sg.workspace_id=w.id and sg.client_user_id=s.client_user_id
          and sg.status='active' and sg.revoked_at is null
        where w.id=$1 and w.status='active'
        for share of w,s,sg`,
      [workspaceId, subject.sessionId, subject.userId],
    );
    const row = rows[0];
    if (!row || row.client_user_id !== subject.userId || row.status !== 'active'
      || !text(row.display_name)) return null;
    this.resolved = {
      id: row.id, workspaceId: row.workspace_id, clientId: row.client_user_id,
      accessActive: true,
      mode: modeFor(row), companyLabel: row.display_name,
    };
    return { ...this.resolved };
  }

  async listSharedProjectOptions(context: AuthorizedTicketCreateContext): Promise<SharedTicketProjectOption[]> {
    if (!this.resolved || !sameContext(this.resolved, context)) return [];
    const { rows } = await this.sql.query<ProjectOptionDbRow>(
      `select distinct on (t.project_id collate "C") t.project_id,
              coalesce(nullif(btrim(t.project_display_name),''), p.name) as display_name
         from alpha_private.tickets t
         join alpha_private.ticket_client_grants cg
           on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
          and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
         join public.projects p on p.workspace_id=t.workspace_id and p.id=t.project_id
        where t.workspace_id=$1 and t.client_user_id=$2
          and t.project_id is not null and t.project_client_visible
        order by t.project_id collate "C", t.client_updated_at desc, t.id collate "C" desc
        limit 1001
      `,
      [context.workspaceId, context.clientId],
    );
    if (rows.length > 1000) throw new Error('Too many shared project options.');
    const projects = new Map<string, SharedTicketProjectOption>();
    for (const row of rows) {
      if (!text(row.project_id) || !text(row.display_name)) throw new Error('Invalid shared project option.');
      if (!projects.has(row.project_id)) {
        projects.set(row.project_id, {
          id: ticketClientProjectOptionId(context.workspaceId, context.clientId, row.project_id),
          workspaceId: context.workspaceId, clientId: context.clientId, projectId: row.project_id,
          displayName: row.display_name, active: true, clientVisible: true,
        });
      }
    }
    return [...projects.values()];
  }
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}
function sameContext(left: AuthorizedTicketCreateContext, right: AuthorizedTicketCreateContext): boolean {
  return left.id === right.id && left.workspaceId === right.workspaceId && left.clientId === right.clientId
    && left.accessActive === right.accessActive
    && left.mode === right.mode && left.companyLabel === right.companyLabel;
}
