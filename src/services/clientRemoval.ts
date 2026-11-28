import type { Project } from '../models/index.js';
import type { Sql, TransactionalSql } from '../store/database.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { PostgresTicketQueueTransaction } from '../store/ticketQueuePostgresStore.js';
import type { LockedTicketQueue } from '../store/ticketQueueStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { logError, logInfo } from '../utils/logger.js';
import { reposForProject } from './githubIssueMapping.js';
import type { ProjectArchiveResult, RepoArchiveOutcome } from './projectArchiveService.js';
import { authorizeTicketQueueAccess } from './ticketAccess.js';

/**
 * A PM removing a client from the workspace.
 *
 * Removal is not deletion. The client's tickets, messages and delivery
 * evidence are the record of what was agreed and delivered, and the schema
 * keeps them on purpose. What removal does:
 *
 *  1. revokes the client's access here -- the service grant and every ticket
 *     grant -- so the portal stops showing them anything, and records it on
 *     each of their tickets;
 *  2. archives the projects linked to their tickets, which archives those
 *     repositories on GitHub. A project another active client still uses is
 *     left alone and reported;
 *  3. retires their sign-in, when they have no access in any other workspace:
 *     their sessions end and the Supabase Auth account is deleted, so the same
 *     email can send a new inquiry and be invited to a new account later.
 *     A revoked grant is never reactivated, which is why the old account has
 *     to go rather than come back.
 *
 * Step 1 is one transaction. Steps 2 and 3 talk to GitHub and Supabase Auth
 * after it commits, and report per item instead of undoing step 1.
 */

export interface ClientIdentityRetirement {
  deleteUser(userId: string): Promise<void>;
}

export interface ClientRemovalDependencies {
  projects: () => ProjectStore;
  archive: (input: { workspaceId: string; project: Project; by: string }) => Promise<ProjectArchiveResult>;
  identity?: ClientIdentityRetirement | null;
}

export interface ClientRemovalProject {
  projectId: string;
  name: string;
  key: string;
  repositories: string[];
  archived: boolean;
  /** Another client with active access is linked to it; removal leaves it as it is. */
  sharedWithOtherClients: boolean;
}

export interface ClientRemovalPreview {
  key: string;
  displayName: string;
  tickets: number;
  projects: ClientRemovalProject[];
}

export type ClientRemovalProjectOutcome = 'archived' | 'kept_shared' | 'failed';
export type ClientSignInOutcome = 'retired' | 'kept_other_access' | 'unavailable' | 'failed';

export interface ClientRemovalResult {
  key: string;
  displayName: string;
  ticketsRevoked: number;
  projects: Array<{
    projectId: string;
    name: string;
    outcome: ClientRemovalProjectOutcome;
    repositories: RepoArchiveOutcome[];
    error?: string;
  }>;
  signIn: ClientSignInOutcome;
}

interface LinkedProjectRow { id: string; name: string; key: string; shared: boolean }

const CLIENT_KEY = /^client:(\S{1,190})$/;

function clientUserId(key: string): string {
  const match = CLIENT_KEY.exec(key);
  if (!match) throw new TicketWorkflowError(400, 'invalid_ticket_client', 'This client is invalid.');
  return match[1];
}

export class ClientRemoval {
  constructor(private readonly db: TransactionalSql, private readonly deps: ClientRemovalDependencies) {}

  /** What removing the client would do, for the confirmation. */
  async preview(workspaceId: string, subject: TicketSubject, key: string): Promise<ClientRemovalPreview> {
    const userId = clientUserId(key);
    const found = await this.db.transaction(async sql => {
      const { displayName } = await this.pmClient(sql, workspaceId, subject, key);
      const tickets = await sql.query<{ count: string | number }>(
        'select count(*) as count from alpha_private.tickets where workspace_id = $1 and client_user_id = $2',
        [workspaceId, userId]
      );
      return { displayName, tickets: Number(tickets.rows[0]?.count ?? 0), linked: await linkedProjects(sql, workspaceId, userId) };
    });
    return { key, displayName: found.displayName, tickets: found.tickets, projects: await this.describe(workspaceId, found.linked) };
  }

  async remove(workspaceId: string, subject: TicketSubject, key: string, input: unknown): Promise<ClientRemovalResult> {
    const userId = clientUserId(key);
    const confirm = (input as { confirm?: unknown } | null)?.confirm;
    if (confirm !== key) throw new TicketWorkflowError(400, 'client_removal_unconfirmed', 'Confirm removing this client.');

    const revoked = await this.db.transaction(async sql => {
      const { displayName } = await this.pmClient(sql, workspaceId, subject, key);
      const linked = await linkedProjects(sql, workspaceId, userId);
      const tickets = await sql.query<{ ticket_id: string }>(
        `update alpha_private.ticket_client_grants
            set active = false, revoked_at = coalesce(revoked_at, now())
          where workspace_id = $1 and client_user_id = $2 and (active or revoked_at is null)
          returning ticket_id`,
        [workspaceId, userId]
      );
      await sql.query(
        `update alpha_private.ticket_service_grants
            set status = 'revoked', accepts_new_requests = false, revoked_at = coalesce(revoked_at, now())
          where workspace_id = $1 and client_user_id = $2`,
        [workspaceId, userId]
      );
      // On every ticket of theirs, so each one's history says why access ended.
      await sql.query(
        `insert into alpha_private.ticket_audit_events (id, workspace_id, ticket_id, actor_kind, actor_id, event_type, occurred_at, metadata)
         select gen_random_uuid()::text, t.workspace_id, t.id, 'pm', $3, 'client_removed', now(), '{}'::jsonb
           from alpha_private.tickets t where t.workspace_id = $1 and t.client_user_id = $2`,
        [workspaceId, userId, subject.userId]
      );
      const elsewhere = await sql.query<{ active: boolean }>(
        `select exists(select 1 from alpha_private.ticket_service_grants
          where client_user_id = $1 and workspace_id <> $2 and status = 'active' and revoked_at is null) as active`,
        [userId, workspaceId]
      );
      const otherAccess = elsewhere.rows[0]?.active === true;
      // Sessions are not per workspace: end them only when no workspace still grants access.
      if (!otherAccess) {
        await sql.query(
          'update alpha_private.ticket_client_sessions set revoked_at = now() where client_user_id = $1 and revoked_at is null',
          [userId]
        );
      }
      return { displayName, linked, ticketsRevoked: tickets.rows.length, otherAccess };
    });

    const projects: ClientRemovalResult['projects'] = [];
    for (const row of revoked.linked) {
      if (row.shared) {
        projects.push({ projectId: row.id, name: row.name, outcome: 'kept_shared', repositories: [] });
        continue;
      }
      try {
        const project = await this.deps.projects().get(workspaceId, row.id);
        if (!project) throw new Error('The project is no longer in this workspace.');
        const archived = await this.deps.archive({ workspaceId, project, by: subject.userId });
        projects.push({ projectId: row.id, name: row.name, outcome: 'archived', repositories: archived.repositories });
      } catch (err) {
        logError(`Removing client: could not archive project ${row.key}:`, (err as Error).message);
        projects.push({ projectId: row.id, name: row.name, outcome: 'failed', repositories: [], error: (err as Error).message });
      }
    }

    const signIn = await this.retireSignIn(userId, revoked.otherAccess);
    logInfo(`Removed client ${key} from ${workspaceId}: ${revoked.ticketsRevoked} ticket grant(s), ${projects.length} project(s), sign-in ${signIn}`);
    return { key, displayName: revoked.displayName, ticketsRevoked: revoked.ticketsRevoked, projects, signIn };
  }

  private async retireSignIn(userId: string, otherAccess: boolean): Promise<ClientSignInOutcome> {
    if (otherAccess) return 'kept_other_access';
    if (!this.deps.identity) return 'unavailable';
    try {
      await this.deps.identity.deleteUser(userId);
      return 'retired';
    } catch (err) {
      logError('Removing client: could not retire the sign-in account:', (err as Error).message);
      return 'failed';
    }
  }

  /** The PM's queue scope and the client as the Clients page lists them; removed clients are not listed. */
  private async pmClient(sql: Sql, workspaceId: string, subject: TicketSubject, key: string):
    Promise<{ scope: LockedTicketQueue; displayName: string }> {
    const tx = new PostgresTicketQueueTransaction(sql);
    const scope = await authorizeTicketQueueAccess(tx, workspaceId, subject);
    if (scope.principal.kind !== 'pm') {
      throw new TicketWorkflowError(403, 'ticket_clients_forbidden', 'Only project managers can remove clients.');
    }
    const client = (await tx.listClients(scope)).find(candidate => candidate.key === key);
    if (!client) throw new TicketWorkflowError(404, 'ticket_client_not_found', 'This client was not found.');
    return { scope, displayName: client.displayName };
  }

  private async describe(workspaceId: string, linked: LinkedProjectRow[]): Promise<ClientRemovalProject[]> {
    const described: ClientRemovalProject[] = [];
    for (const row of linked) {
      const project = await this.deps.projects().get(workspaceId, row.id);
      described.push({
        projectId: row.id,
        name: row.name,
        key: row.key,
        repositories: project ? reposForProject(project) : [],
        archived: Boolean(project?.archivedAt),
        sharedWithOtherClients: row.shared
      });
    }
    return described;
  }
}

/**
 * The projects linked to the client's tickets, by the ticket's project or its
 * work binding, and whether another client with active access uses each.
 */
async function linkedProjects(sql: Sql, workspaceId: string, userId: string): Promise<LinkedProjectRow[]> {
  const { rows } = await sql.query<LinkedProjectRow>(
    `with linked as (
       select t.project_id from alpha_private.tickets t
        where t.workspace_id = $1 and t.client_user_id = $2 and t.project_id is not null
       union
       select b.project_id from alpha_private.ticket_work_bindings b
         join alpha_private.tickets t on t.workspace_id = b.workspace_id and t.id = b.ticket_id
        where t.workspace_id = $1 and t.client_user_id = $2
     )
     select p.id, p.name, p.key,
            exists (
              select 1 from alpha_private.tickets other
                join alpha_private.ticket_service_grants g
                  on g.workspace_id = other.workspace_id and g.client_user_id = other.client_user_id
               where other.workspace_id = $1 and other.project_id = p.id and other.client_user_id <> $2
                 and g.status = 'active' and g.revoked_at is null
            ) as shared
       from linked l
       join public.projects p on p.workspace_id = $1 and p.id = l.project_id
      order by lower(p.name), p.id`,
    [workspaceId, userId]
  );
  return rows;
}
