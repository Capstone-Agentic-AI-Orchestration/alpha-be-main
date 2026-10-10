import type { TransactionalSql, Sql } from './database.js';
import type { TicketSubject } from './ticketCommandStore.js';
import type { TicketClientWorkspaceRecord, TicketClientWorkspaceStore,
  TicketClientWorkspaceTransaction } from './ticketClientWorkspaceStore.js';

/** Workspace picker contains only workspaces with at least one active ticket grant. */
export class PostgresTicketClientWorkspaceStore implements TicketClientWorkspaceStore {
  constructor(private readonly db: TransactionalSql) {}

  transaction<T>(work: (tx: TicketClientWorkspaceTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(this.boundary(sql)));
  }

  private boundary(sql: Sql): TicketClientWorkspaceTransaction {
    return {
      async listAuthorizedWorkspaces(subject: Extract<TicketSubject, { kind: 'client' }>) {
        const { rows } = await sql.query<TicketClientWorkspaceRecord>(
          `select sg.workspace_id as "workspaceId",
                  coalesce(min(nullif(btrim(t.client_safe_company_label),'')), 'Client portal') as "displayName"
             from alpha_private.ticket_client_sessions s
             join alpha_private.ticket_service_grants sg
               on sg.client_user_id=s.client_user_id and sg.status='active' and sg.revoked_at is null
             join public.workspaces w on w.id=sg.workspace_id and w.status='active'
             join alpha_private.ticket_client_grants cg
               on cg.workspace_id=sg.workspace_id and cg.client_user_id=sg.client_user_id
              and cg.active and cg.revoked_at is null
             join alpha_private.tickets t
               on t.workspace_id=cg.workspace_id and t.id=cg.ticket_id and t.client_user_id=cg.client_user_id
            where s.session_id_hash=$1 and s.client_user_id=$2 and s.revoked_at is null
              and s.created_at<=now() and s.expires_at>now()
            group by sg.workspace_id order by sg.workspace_id`,
          [subject.sessionId, subject.userId],
        );
        return rows;
      },
    };
  }
}
