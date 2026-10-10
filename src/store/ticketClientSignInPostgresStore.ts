import type { TransactionalSql } from './database.js';

/** Auth lookup is private and used only to avoid sending links to non-clients. */
export class PostgresTicketClientSignInStore {
  constructor(private readonly db: TransactionalSql) {}

  async findActiveClientUserId(email: string): Promise<string | null> {
    const { rows } = await this.db.query<{ client_user_id: string }>(
      `select u.id as client_user_id
         from auth.users u
         join alpha_private.ticket_service_grants sg
           on sg.client_user_id=u.id and sg.status='active' and sg.revoked_at is null
         join public.workspaces w on w.id=sg.workspace_id and w.status='active'
         join alpha_private.ticket_client_grants cg
           on cg.workspace_id=sg.workspace_id and cg.client_user_id=sg.client_user_id
          and cg.active and cg.revoked_at is null
         join alpha_private.tickets t
           on t.workspace_id=cg.workspace_id and t.id=cg.ticket_id and t.client_user_id=cg.client_user_id
        where lower(u.email)=$1 and u.email_confirmed_at is not null
        order by u.id limit 1`,
      [email],
    );
    return rows[0]?.client_user_id ?? null;
  }
}
