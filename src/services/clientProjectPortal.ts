import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql, TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { PostgresTicketAuthorization } from '../store/ticketPostgresAuthorization.js';
import { ticketClientProjectOptionId } from '../store/ticketCreationPostgresStore.js';
import { ticketSqlIso, decodeTicketWorkflow } from '../store/ticketPostgresCodec.js';
import { projectTicketQueueRow, type ClientTicketQueueItem } from '../ticketing/queueModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { validTicketProjectPreview } from './ticketProjectManagementService.js';
import type { TicketSharedPreview } from '../store/ticketProjectManagementStore.js';
import { clientProjectPreviewSql } from '../store/clientProjectPreviewSql.js';
import type { ProjectUatBuilds } from './projectUatBuilds.js';
import { CLIENT_TICKET_ACCESS_JOINS_SQL, CLIENT_VISIBLE_PROJECT_SQL } from '../store/ticketClientSql.js';
import { loadStageBadge, type StageBadge } from '../store/clientProjectStageStore.js';

const id = z.string().min(1).max(200).refine(v => v.trim() === v);
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(2048).nullable().default(null), search: z.string().trim().max(200).default(''),
  filter: z.enum(['all', 'open', 'history', 'needs_client']).default('all'),
}).strict();
const messagePageSchema = pageSchema.pick({ limit: true }).extend({ before: id.nullable().default(null) });
const messageSchema = z.object({ schemaVersion: z.literal(1), operationId: id,
  body: z.string().trim().min(1).max(4000) }).strict();
const previewSchema = z.object({ preview: z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.literal('uat'), url: z.string().url().max(2048) }).strict().nullable() }).strict();
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new TicketWorkflowError(400, 'invalid_project_portal_input', 'Check the request details.');
  return result.data;
}
function missing(): never { throw new TicketWorkflowError(404, 'client_project_unavailable', 'This project is unavailable.'); }
type Client = Extract<TicketSubject, { kind: 'client' }>;
export interface ProjectTarget { workspaceId: string; projectId: string }
interface ProjectRow { workspace_id: string; project_id: string; name: string; updated_at: string | Date;
  repository: string | null; branch: 'main' | 'uat' | null; url: string | null }
interface RequestRow {
  id: string | null; workspace_id: string; reference: string; title: string;
  workflow_state: unknown; project_id: string | null;
  created_at: string | Date; client_updated_at: string | Date; internal_updated_at: string | Date; closed_at: string | Date | null;
  visible_project_id: string | null; visible_project_name: string | null; requested_project_name: string | null;
  pending_project_requested: boolean; cursor_found: boolean;
}
export interface ClientProject { workspaceId: string; projectId: string; intakeOptionId: string; name: string;
  updatedAt: string; preview: Pick<TicketSharedPreview,'branch'|'url'> | null; stage: StageBadge }
export interface ClientProjectRequest extends ClientTicketQueueItem {
  workspaceId: string; projectId: string | null; projectName: string | null;
  requestedProjectName: string | null; projectLinkStatus: 'linked' | 'pending_review' | null;
}

// A preference is deliberately absent from this predicate. Only current ticket
// ownership plus an active exact ticket grant can expose a project or thread.
// The access and visibility rules are shared with the PM Clients list, so a PM
// sees exactly the projects this client sees (store/ticketClientSql.ts).
const eligibleTickets = `from alpha_private.tickets t
 ${CLIENT_TICKET_ACCESS_JOINS_SQL}
 join alpha_private.ticket_client_sessions s on s.client_user_id=t.client_user_id
   and s.session_id_hash=$2 and s.revoked_at is null and s.created_at<=now() and s.expires_at>now()
 where t.client_user_id=$1`;
const visibleProject = CLIENT_VISIBLE_PROJECT_SQL;
const needsAction = `status not in ('closed','declined','cancelled','on_hold')
 and workflow_state->>'withdrawalRequested' is distinct from 'true'
 and workflow_state->>'actionOwner'='client' and workflow_state->>'nextAction' in ('reply','agree_scope','review_result')`;

/** Owner-connection SQL: each transaction rechecks sessions, membership and grants.
 * The combined client conversation (clientProjectConversation.ts) reads this
 * thread together with each request's messages; workflow and project-link
 * approval remain separate. */
export class PostgresClientProjectPortal {
  /**
   * `builds`, when given, checks a shared preview against the project's verified UAT build, so
   * clients only ever see a build the hosting provider vouches for. Without it, a share is saved
   * but not verified (readers that never share a preview do not need it).
   */
  constructor(private readonly db: TransactionalSql, private readonly builds?: Pick<ProjectUatBuilds, 'resolve'>) {}

  /** Shared authority for the project QA module; always called on its transaction. */
  async authorizeProject(sql: Sql, target: ProjectTarget, subject: TicketSubject, write = false) {
    if (subject.kind === 'client') return this.lockClientProject(sql, target, this.client(subject), write);
    return this.lockProject(sql, target, subject, write);
  }

  async authorizeRecipient(sql: Sql, target: ProjectTarget, subject: TicketSubject, clientId: string, write = false) {
    await this.authorizeProject(sql, target, subject, write);
    if (subject.kind === 'client' && subject.userId !== clientId) missing();
    const { rows } = await sql.query(`select t.id from alpha_private.tickets t
      join alpha_private.ticket_client_grants cg on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
        and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
      join alpha_private.ticket_service_grants sg on sg.workspace_id=t.workspace_id and sg.client_user_id=t.client_user_id
        and sg.status='active' and sg.revoked_at is null
      where t.workspace_id=$1 and t.project_id=$2 and t.client_user_id=$3 and t.project_client_visible
      order by t.id for share of t,cg,sg`, [target.workspaceId,target.projectId,clientId]);
    if (!rows.length) missing();
  }

  async getPreview(target: ProjectTarget, subject: TicketSubject) {
    if (subject.kind !== 'internal') missing();
    return this.db.transaction(async sql => {
      await this.authorizeProject(sql,target,subject);
      const {rows} = await sql.query<{repository:string;branch:'main'|'uat';url:string}>(
        'select repository,branch,url from alpha_private.client_project_previews where workspace_id=$1 and project_id=$2', [target.workspaceId,target.projectId]);
      const preview = rows[0]?.url ? rows[0] : null;
      if (!validTicketProjectPreview(preview)) throw new TicketReadInvariantError();
      return {preview};
    });
  }

  private client(subject: TicketSubject): Client {
    if (subject.kind !== 'client' || !id.safeParse(subject.userId).success || !/^[a-f0-9]{64}$/.test(subject.sessionId)) missing();
    return subject;
  }

  private async lockSession(sql: Sql, subject: Client) {
    const { rows } = await sql.query(`select session_id_hash from alpha_private.ticket_client_sessions
      where session_id_hash=$1 and client_user_id=$2 and revoked_at is null and created_at<=now() and expires_at>now() for share`,
    [subject.sessionId, subject.userId]);
    if (!rows.length) missing();
  }

  private async lockRequestGrants(sql: Sql, subject: Client) {
    // Keep counts, visibility and projected rows coherent with revocations and
    // PM relinks; do not rely on an earlier HTTP session authentication alone.
    await sql.query(`select t.id ${eligibleTickets} order by t.workspace_id,t.id for share of w,s,sg,t,cg`,
      [subject.userId, subject.sessionId]);
  }

  private async lockProject(sql: Sql, target: ProjectTarget, subject: TicketSubject, write = false) {
    if (!id.safeParse(target.workspaceId).success || !id.safeParse(target.projectId).success) missing();
    const scope = await new PostgresTicketAuthorization(sql).lockQueueScope(target.workspaceId, subject);
    if (!scope) missing();
    if (write && scope.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Project changes are unavailable right now.');
    const { rows } = await sql.query(`select id from public.projects where workspace_id=$1 and id=$2 for ${write ? 'update' : 'share'}`,
      [target.workspaceId, target.projectId]);
    if (!rows.length) missing();
    return scope;
  }

  private async lockClientProject(sql: Sql, target: ProjectTarget, subject: Client, write = false) {
    const scope = await this.lockProject(sql, target, subject, write);
    const { rows } = await sql.query(`select t.id from alpha_private.tickets t
      join alpha_private.ticket_client_grants cg on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
        and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
      where t.workspace_id=$1 and t.project_id=$2 and t.client_user_id=$3 and t.project_client_visible
      order by t.id collate "C" for share of t,cg`, [target.workspaceId, target.projectId, subject.userId]);
    if (!rows.length) missing();
    if (write) {
      const { rows: workspace } = await sql.query<{ mode: string }>(`select settings_json->>'ticketing_write_mode' as mode
        from public.workspaces where id=$1`, [target.workspaceId]);
      if (workspace[0]?.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Project changes are unavailable right now.');
    }
    return scope;
  }

  async projects(subject: TicketSubject): Promise<{ items: ClientProject[] }> {
    const client = this.client(subject);
    return this.db.transaction(async sql => {
      await this.lockSession(sql, client);
      await this.lockRequestGrants(sql, client);
      const { rows } = await sql.query<ProjectRow>(`with linked as (
        select t.workspace_id,t.project_id,max(t.client_updated_at) as updated_at ${eligibleTickets} and ${visibleProject}
        group by t.workspace_id,t.project_id)
        select l.workspace_id,l.project_id,p.name,greatest(l.updated_at,pp.updated_at) as updated_at,
          pp.repository,pp.branch,pp.url from linked l
        join public.projects p on p.workspace_id=l.workspace_id and p.id=l.project_id
        left join lateral (${clientProjectPreviewSql('l.workspace_id', 'l.project_id', '$1')}) pp on true
        order by updated_at desc,l.workspace_id collate "C",l.project_id collate "C"`, [client.userId, client.sessionId]);
      const items: ClientProject[] = [];
      for (const row of rows) {
        await this.lockClientProject(sql, { workspaceId: row.workspace_id, projectId: row.project_id }, client);
        const preview = row.url ? { repository: row.repository!, branch: row.branch!, url: row.url } : null;
        if (!validTicketProjectPreview(preview)) throw new TicketReadInvariantError();
        items.push({ workspaceId: row.workspace_id, projectId: row.project_id,
          intakeOptionId: ticketClientProjectOptionId(row.workspace_id, client.userId, row.project_id),
          name: row.name, updatedAt: ticketSqlIso(row.updated_at), preview:preview?{branch:preview.branch,url:preview.url}:null,
          stage: await loadStageBadge(sql, { workspaceId: row.workspace_id, projectId: row.project_id, clientId: client.userId }) });
      }
      return { items };
    });
  }

  async requests(subject: TicketSubject, input: unknown, target?: ProjectTarget) {
    const client = this.client(subject);
    return this.db.transaction(async sql => {
      await this.lockSession(sql, client);
      await this.lockRequestGrants(sql, client);
      if (target) await this.lockClientProject(sql, target, client);
      const page = parse(pageSchema, input);
      const predicate = page.filter === 'history' ? `status in ('closed','declined','cancelled')`
        : page.filter === 'open' ? `status not in ('closed','declined','cancelled')` : page.filter === 'needs_client' ? needsAction : 'true';
      // Tickets have composite workspace identities. Encode both parts so equal
      // ticket IDs or timestamps in different workspaces cannot skip rows.
      let cursorId: string | null = null;
      let cursorWorkspace: string | null = null;
      if (page.after) {
        try {
          const decoded = z.tuple([id,id]).parse(JSON.parse(Buffer.from(page.after,'base64url').toString('utf8')));
          [cursorWorkspace,cursorId] = decoded;
        } catch { missing(); }
      }
      const pendingVisible = `t.project_id is null and exists (
        select 1 from alpha_private.tickets linked
        join alpha_private.ticket_client_grants grant_row on grant_row.workspace_id=linked.workspace_id
          and grant_row.ticket_id=linked.id and grant_row.client_user_id=linked.client_user_id
          and grant_row.active and grant_row.revoked_at is null
        join public.projects linked_project on linked_project.workspace_id=linked.workspace_id and linked_project.id=linked.project_id
        where linked.workspace_id=t.workspace_id and linked.client_user_id=t.client_user_id and linked.project_client_visible
          and linked.project_id=(select r.preferred_project_id from alpha_private.ticket_requests r
            where r.workspace_id=t.workspace_id and r.ticket_id=t.id))`;
      const preferenceName = `(select r.requested_project_label from alpha_private.ticket_requests r
        where r.workspace_id=t.workspace_id and r.ticket_id=t.id)`;
      const base = `select t.*,case when ${visibleProject} then t.project_id else null end as visible_project_id,
        case when ${visibleProject} then coalesce(nullif(btrim(t.project_display_name),''),
          (select p.name from public.projects p where p.id=t.project_id and p.workspace_id=t.workspace_id)) else null end as visible_project_name,
        case when ${pendingVisible} then ${preferenceName} else null end as requested_project_name,
        (t.project_id is null and exists (select 1 from alpha_private.ticket_requests r
          where r.workspace_id=t.workspace_id and r.ticket_id=t.id and r.preferred_project_id is not null)) as pending_project_requested
        ${eligibleTickets} and ($3::text is null or (t.workspace_id=$3 and
          ((t.project_id=$4 and t.project_client_visible) or (t.project_id is null and exists (
            select 1 from alpha_private.ticket_requests r where r.workspace_id=t.workspace_id and r.ticket_id=t.id and r.preferred_project_id=$4)))))`;
      const params = [client.userId, client.sessionId, target?.workspaceId ?? null, target?.projectId ?? null,
        page.search, cursorId, page.limit + 1, cursorWorkspace];
      const { rows } = await sql.query<RequestRow>(`with base as (${base}), filtered as (
        select * from base where (${predicate}) and ($5='' or position(lower($5) in lower(reference || ' ' || title))>0)),
        cursor_row as (select client_updated_at,workspace_id,id from filtered where id=$6 and workspace_id=$8), page_rows as (
          select * from filtered where $6::text is null or (client_updated_at,workspace_id collate "C",id collate "C") <
            (select client_updated_at,workspace_id collate "C",id collate "C" from cursor_row)
          order by client_updated_at desc,workspace_id collate "C" desc,id collate "C" desc limit $7)
        select p.*,($6::text is null or exists(select 1 from cursor_row)) as cursor_found
        from (select 1) seed left join page_rows p on true`, params);
      if (rows.some(row => !row.cursor_found)) missing();
      const { rows: counts } = await sql.query<{ open: string; needs_client: string }>(`with base as (${base})
        select count(*) filter(where status not in ('closed','declined','cancelled')) as open,
        count(*) filter(where ${needsAction}) as needs_client from base`, params.slice(0, 4));
      const items: ClientProjectRequest[] = [];
      const auth = new PostgresTicketAuthorization(sql);
      const present = rows.filter((row): row is RequestRow & { id: string } => row.id !== null);
      for (const row of present.slice(0, page.limit)) {
        const scope = await auth.lockQueueScope(row.workspace_id, client);
        const locked = await auth.lockTicket({ workspaceId: row.workspace_id, ticketId: row.id }, client);
        if (!scope || !locked) missing();
        const state = decodeTicketWorkflow(row.workflow_state);
        if (state.version !== locked.state.version || state.projectId !== row.project_id) throw new TicketReadInvariantError();
        const header = { workspaceId: row.workspace_id, ticketId: row.id, reference: row.reference, title: row.title,
          createdAt: ticketSqlIso(row.created_at), clientUpdatedAt: ticketSqlIso(row.client_updated_at),
          internalUpdatedAt: ticketSqlIso(row.internal_updated_at), closedAt: row.closed_at ? ticketSqlIso(row.closed_at) : null };
        const item = projectTicketQueueRow(scope, { ticket: locked, clientAccessActive: true, header });
        items.push({ ...item, workspaceId: row.workspace_id, projectId: row.visible_project_id, projectName: row.visible_project_name,
          requestedProjectName: row.requested_project_name,
          projectLinkStatus: row.visible_project_id ? 'linked' : row.pending_project_requested ? 'pending_review' : null });
      }
      const last = items.at(-1);
      return { items, nextCursor: present.length > page.limit && last
        ? Buffer.from(JSON.stringify([last.workspaceId,last.id])).toString('base64url') : null,
        counters: { kind: 'client' as const, open: Number(counts[0].open), needsClient: Number(counts[0].needs_client) } };
    });
  }

  /** A shared preview must be the project's current verified UAT build for that repository; access is checked first. */
  private async requireVerifiedBuild(target: ProjectTarget, subject: TicketSubject, preview: TicketSharedPreview) {
    if (!this.builds) return;
    await this.db.transaction(sql => this.authorizeProject(sql, target, subject));
    const build = await this.builds.resolve(target, preview.repository);
    if (build.frontend.repository !== preview.repository || new URL(build.frontend.url).origin !== new URL(preview.url).origin) {
      throw new TicketWorkflowError(409, 'uat_build_changed', 'Share the current verified UAT build. Reload the preview and try again.');
    }
  }

  async setPreview(target: ProjectTarget, subject: TicketSubject, input: unknown) {
    if (subject.kind !== 'internal') missing();
    const { preview } = parse(previewSchema, input);
    if (!validTicketProjectPreview(preview)) throw new TicketWorkflowError(400, 'invalid_project_preview', 'Use a hosted HTTPS Vercel preview.');
    if (preview) await this.requireVerifiedBuild(target, subject, preview);
    return this.db.transaction(async sql => {
      await this.lockProject(sql, target, subject, true);
      await sql.query(`insert into alpha_private.client_project_previews(workspace_id,project_id,repository,branch,url,updated_by)
        values ($1,$2,$3,$4,$5,$6) on conflict(workspace_id,project_id) do update set
        repository=excluded.repository,branch=excluded.branch,url=excluded.url,updated_by=excluded.updated_by,updated_at=now()`,
      [target.workspaceId, target.projectId, preview?.repository ?? null, preview?.branch ?? null, preview?.url ?? null, subject.userId]);
      return { preview };
    });
  }

  async clients(target: ProjectTarget, subject: TicketSubject) {
    if (subject.kind !== 'internal') missing();
    return this.db.transaction(async sql => {
      await this.lockProject(sql, target, subject);
      const { rows } = await sql.query<{ client_user_id: string; display_name: string }>(`select t.client_user_id,sg.display_name
        from alpha_private.tickets t
        join alpha_private.ticket_client_grants cg on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
          and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
        join alpha_private.ticket_service_grants sg on sg.workspace_id=t.workspace_id and sg.client_user_id=t.client_user_id
          and sg.status='active' and sg.revoked_at is null
        where t.workspace_id=$1 and t.project_id=$2 and t.project_client_visible and t.client_user_id is not null
        order by t.client_user_id collate "C",t.id collate "C" for share of t,cg,sg`, [target.workspaceId,target.projectId]);
      const clients = new Map<string, {clientId:string;displayName:string}>();
      for (const row of rows) {
        if (!id.safeParse(row.client_user_id).success || !id.safeParse(row.display_name).success) throw new TicketReadInvariantError();
        clients.set(row.client_user_id,{clientId:row.client_user_id,displayName:row.display_name});
      }
      return {items:[...clients.values()]};
    });
  }

  /** The one client whose project conversation this subject may read or write (same rules as the project thread). */
  authorizeThread(sql: Sql, target: ProjectTarget, subject: TicketSubject, requestedClient: unknown, write: boolean): Promise<string> {
    return this.threadClient(sql, target, subject, requestedClient, write);
  }

  private async threadClient(sql: Sql, target: ProjectTarget, subject: TicketSubject, requestedClient: unknown, write: boolean) {
    if (subject.kind === 'client') {
      const client = this.client(subject);
      await this.lockClientProject(sql, target, client, write);
      return client.userId;
    }
    await this.lockProject(sql, target, subject, write);
    if (requestedClient !== undefined && !id.safeParse(requestedClient).success) parse(id, requestedClient);
    const { rows } = await sql.query<{ client_user_id: string }>(`select t.client_user_id from alpha_private.tickets t
      join alpha_private.ticket_client_grants cg on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
        and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
      join alpha_private.ticket_service_grants sg on sg.workspace_id=t.workspace_id and sg.client_user_id=t.client_user_id
        and sg.status='active' and sg.revoked_at is null
      where t.workspace_id=$1 and t.project_id=$2 and t.project_client_visible and t.client_user_id is not null
        and ($3::text is null or t.client_user_id=$3) order by t.client_user_id,t.id for share of t,cg,sg`,
    [target.workspaceId, target.projectId, requestedClient ?? null]);
    const clients = [...new Set(rows.map(row => row.client_user_id))];
    if (!clients.length) missing();
    if (clients.length !== 1) throw new TicketWorkflowError(400, 'project_thread_client_required', 'Choose a client for this conversation.');
    return clients[0];
  }

  async messages(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown) {
    return this.db.transaction(async sql => {
      const client = await this.threadClient(sql, target, subject, clientId, false);
      const page = parse(messagePageSchema, input);
      const { rows } = await sql.query<{ id: string | null; author_kind: 'pm' | 'client'; body: string; created_at: Date; cursor_found: boolean }>(`
        with base as (select id,author_kind,body,created_at from alpha_private.client_project_messages
          where workspace_id=$1 and project_id=$2 and client_user_id=$3),
        cursor_row as (select created_at,id from base where id=$4), page_rows as (
          select * from base where $4::text is null or (created_at,id collate "C") < (select created_at,id collate "C" from cursor_row)
          order by created_at desc,id collate "C" desc limit $5)
        select p.*,($4::text is null or exists(select 1 from cursor_row)) as cursor_found
        from (select 1) seed left join page_rows p on true`, [target.workspaceId,target.projectId,client,page.before,page.limit+1]);
      if (rows.some(row => !row.cursor_found)) missing();
      const present = rows.filter(row => row.id !== null);
      const items = present.slice(0,page.limit).reverse().map(row => ({ id: row.id!, author: row.author_kind, body: row.body, createdAt: ticketSqlIso(row.created_at),
        ...(subject.kind === 'internal' ? {clientId:client} : {}) }));
      return { items, nextCursor: present.length > page.limit ? items[0]!.id : null };
    });
  }

  async reply(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown) {
    return this.db.transaction(async sql => {
      const client = await this.threadClient(sql, target, subject, clientId, true);
      const value = parse(messageSchema, input);
      const author = subject.kind === 'client' ? 'client' : 'pm';
      // The project row lock serializes replay checks and inserts. Operations
      // are scoped by thread AND actor, never shared between two clients.
      const params = [target.workspaceId,target.projectId,client,author,subject.userId,value.operationId];
      const { rows: saved } = await sql.query<{ id: string; body: string }>(`select id,body from alpha_private.client_project_messages
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and author_kind=$4 and author_id=$5 and operation_id=$6`, params);
      if (saved.length) {
        if (saved[0].body !== value.body) throw new TicketWorkflowError(409, 'project_message_operation_conflict', 'This operation was already used for another message.');
        return { messageId: saved[0].id, operationId: value.operationId };
      }
      const messageId = randomUUID();
      await sql.query(`insert into alpha_private.client_project_messages(workspace_id,project_id,client_user_id,author_kind,author_id,operation_id,id,body)
        values ($1,$2,$3,$4,$5,$6,$7,$8)`, [...params,messageId,value.body]);
      return { messageId, operationId: value.operationId };
    });
  }

  async operation(target: ProjectTarget, subject: TicketSubject, operationId: unknown, clientId?: unknown) {
    return this.db.transaction(async sql => {
      const client = await this.threadClient(sql, target, subject, clientId, false);
      const operation = parse(id, operationId);
      const { rows } = await sql.query<{ id: string }>(`select id from alpha_private.client_project_messages
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and author_kind=$4 and author_id=$5 and operation_id=$6`,
      [target.workspaceId,target.projectId,client,subject.kind === 'client' ? 'client' : 'pm',subject.userId,operation]);
      if (!rows.length) missing();
      return { messageId: rows[0].id, operationId: operation };
    });
  }
}
