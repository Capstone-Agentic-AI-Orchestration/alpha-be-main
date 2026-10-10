import type { TicketActor, TicketWorkflow } from '../ticketing/workflow.js';
import type { LockedTicket, TicketSubject, TicketTarget } from './ticketCommandStore.js';
import type { LockedTicketQueue } from './ticketQueueStore.js';
import type { Sql } from './database.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { decodeTicketWorkflow, ticketWriteMode } from './ticketPostgresCodec.js';

interface WorkspaceAccessRow {
  time_zone: string;
  write_mode: string | null;
  client_write_mode?: string;
}

interface TicketStateRow {
  id: string;
  workspace_id: string;
  status: string;
  version: string | number;
  client_user_id: string | null;
  project_id: string | null;
  workflow_state: unknown;
}

function invalid(): never { throw new TicketReadInvariantError(); }

/**
 * Fresh, transaction-local authorization for ticket queries using the cloud
 * database owner connection. RLS is not an authorization substitute here.
 * Lock order is principal/session and service grant, then ticket, then the
 * exact per-ticket grant. Writers can request the ticket's stronger UPDATE lock.
 */
export class PostgresTicketAuthorization {
  constructor(private readonly sql: Sql) {}

  async lockQueueScope(workspaceId: string, subject: TicketSubject): Promise<LockedTicketQueue | null> {
    if (subject.kind === 'internal') {
      const sessionJoin = subject.authentication.kind === 'session'
        ? `join alpha_private.sessions s
             on s.id = $3 and lower(s.login) = lower(m.user_id) and s.expires_at > now()`
        : '';
      const lockAliases = subject.authentication.kind === 'session' ? 'w, m, s' : 'w, m';
      const values = subject.authentication.kind === 'session'
        ? [workspaceId, subject.userId, subject.authentication.sessionId]
        : [workspaceId, subject.userId];
      const { rows } = await this.sql.query<WorkspaceAccessRow>(
        `select coalesce(nullif(btrim(w.settings_json->>'time_zone'), ''), 'UTC') as time_zone,
                w.settings_json->>'ticketing_write_mode' as write_mode
         from public.workspaces w
         join public.workspace_members m on m.workspace_id = w.id
         ${sessionJoin}
         where w.id = $1 and w.status = 'active'
           and m.user_id = $2 and m.status = 'active' and m.role = 'pm'
         for share of ${lockAliases}`,
        values,
      );
      const row = rows[0];
      if (!row) return null;
      return {
        workspaceId,
        timeZone: row.time_zone,
        mode: ticketWriteMode(row.write_mode),
        principal: { kind: 'pm', userId: subject.userId, membershipActive: true, canManageTickets: true },
      };
    }

    const { rows } = await this.sql.query<WorkspaceAccessRow>(
      `select sg.time_zone, sg.write_mode as client_write_mode
       from public.workspaces w
       join alpha_private.ticket_client_sessions s
         on s.session_id_hash = $2 and s.client_user_id = $3
        and s.revoked_at is null and s.created_at <= now() and s.expires_at > now()
       join alpha_private.ticket_service_grants sg
         on sg.workspace_id = w.id and sg.client_user_id = s.client_user_id
        and sg.status = 'active' and sg.revoked_at is null
       where w.id = $1 and w.status = 'active'
       for share of w, s, sg`,
      [workspaceId, subject.sessionId, subject.userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      workspaceId,
      timeZone: row.time_zone,
      mode: ticketWriteMode(row.client_write_mode),
      principal: { kind: 'client', userId: subject.userId, accessActive: true },
    };
  }

  async lockTicket(
    target: TicketTarget,
    subject: TicketSubject,
    lock: 'share' | 'update' = 'share',
  ): Promise<LockedTicket | null> {
    const scope = await this.lockQueueScope(target.workspaceId, subject);
    if (!scope) return null;

    const clientClause = subject.kind === 'client' ? 'and t.client_user_id = $3' : '';
    const values = subject.kind === 'client'
      ? [target.workspaceId, target.ticketId, subject.userId]
      : [target.workspaceId, target.ticketId];
    const { rows } = await this.sql.query<TicketStateRow>(
      `select t.id, t.workspace_id, t.status, t.version, t.client_user_id, t.project_id, t.workflow_state
       from alpha_private.tickets t
       where t.workspace_id = $1 and t.id = $2 ${clientClause}
       for ${lock} of t`,
      values,
    );
    const row = rows[0];
    if (!row) return null;

    let actor: TicketActor;
    if (subject.kind === 'client') {
      const grants = await this.sql.query<{ active: boolean }>(
        `select active from alpha_private.ticket_client_grants
         where workspace_id = $1 and ticket_id = $2 and client_user_id = $3 and active
         for share`,
        [target.workspaceId, target.ticketId, subject.userId],
      );
      if (!grants.rows[0]?.active) return null;
      actor = {
        kind: 'client', userId: subject.userId, workspaceId: target.workspaceId,
        ticketId: target.ticketId, grantActive: true,
      };
    } else {
      if (!scope.principal || scope.principal.kind !== 'pm') return null;
      actor = {
        kind: 'pm', userId: subject.userId, workspaceId: target.workspaceId,
        membershipActive: true, canManageTickets: true,
      };
    }

    const state: TicketWorkflow = decodeTicketWorkflow(row.workflow_state);
    if (row.id !== target.ticketId || row.workspace_id !== target.workspaceId
      || state.id !== row.id || state.workspaceId !== row.workspace_id || state.status !== row.status
      || state.version !== Number(row.version) || state.clientId !== row.client_user_id
      || state.projectId !== row.project_id) return invalid();
    return { state, actor, mode: scope.mode };
  }
}
