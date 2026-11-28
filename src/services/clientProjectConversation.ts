import { z } from 'zod';
import type { Sql, TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { PostgresTicketAuthorization } from '../store/ticketPostgresAuthorization.js';
import { ticketSqlIso } from '../store/ticketPostgresCodec.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import type { PostgresClientProjectPortal, ProjectTarget } from './clientProjectPortal.js';

/**
 * One conversation per client and project.
 *
 * Nothing is copied: the conversation is read from the stores that already hold
 * each part, so the PM Tickets page, the project thread and this view never
 * disagree. It merges
 *  - the project thread (client_project_messages): general messages;
 *  - each request (a ticket on this project): when it was made, and its messages;
 *  - an accepted proposal's clarification questions and answers;
 *  - tasks linked to a request, and the request checklist (done / reopened).
 *
 * New general messages keep using the project thread's reply path, and new
 * requests keep using the client ticket creation path (with this project as the
 * shared-project preference), so access rules and idempotency stay where they are.
 */

const id = z.string().min(1).max(200).refine(v => v.trim() === v);
const checkSchema = z.object({ done: z.boolean() }).strict();
const linkSchema = z.object({ issueId: id, source: z.enum(['conversation', 'task_dialog']).default('conversation') }).strict();

export type RequestChecklistStatus = 'open' | 'in_progress' | 'ready_to_check' | 'done' | 'declined' | 'cancelled';
export type ConversationItemKind = 'message' | 'note' | 'request' | 'clarification' | 'task_linked' | 'request_done' | 'request_reopened'
  | 'stage_event';

/** A stage event in the timeline: what happened, to which POC/contract/round/quote, with its version number or signer's name. */
/** A stage event in the timeline. `decision`, `title` and `extra` describe change-request answers and extra rounds. */
export interface ConversationStageEvent {
  action: string; refId: string | null; number: number | null; name: string | null; stage: string | null;
  decision: string | null; title: string | null; extra: boolean;
}

export interface ConversationItem {
  id: string;
  kind: ConversationItemKind;
  author: 'client' | 'pm';
  body: string;
  createdAt: string;
  request: { ticketId: string; reference: string; title: string } | null;
  task: { issueId: string; identifier: string; title: string } | null;
  /** Only on stage events. */
  stage?: ConversationStageEvent;
}

export interface LinkedTask { issueId: string; identifier: string; title: string; status: string }

export interface ConversationRequest {
  ticketId: string; workspaceId: string; reference: string; title: string; description: string;
  ticketStatus: string; checklist: RequestChecklistStatus;
  doneBy: 'client' | 'pm' | null; doneAt: string | null; createdAt: string;
  linkedTasks: LinkedTask[];
}

export interface ClientProjectConversationSummary {
  workspaceId: string; projectId: string; projectName: string;
  openRequests: number; lastActivityAt: string;
}

function invalid(): never { throw new TicketWorkflowError(400, 'invalid_conversation_input', 'Check the request details.'); }
function missing(): never { throw new TicketWorkflowError(404, 'client_conversation_unavailable', 'This conversation is unavailable.'); }
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}

/** The checklist both sides see. A ticked request is done; finished tickets are done too. */
export function requestChecklistStatus(input: {
  ticketStatus: string; done: boolean | null; linkedTaskStatuses: readonly string[];
}): RequestChecklistStatus {
  if (input.ticketStatus === 'declined') return 'declined';
  if (input.ticketStatus === 'cancelled') return 'cancelled';
  if (input.done === true || input.ticketStatus === 'closed') return 'done';
  if (input.linkedTaskStatuses.length) {
    return input.linkedTaskStatuses.every(status => status === 'done') ? 'ready_to_check' : 'in_progress';
  }
  if (input.ticketStatus === 'ready_for_review') return 'ready_to_check';
  if (input.ticketStatus === 'in_progress') return 'in_progress';
  return 'open';
}

/** A client's tickets on this project that the client can currently see. */
const VISIBLE_REQUESTS_SQL = `select t.workspace_id,t.id,t.reference,t.title,t.description,t.status,t.created_at
  from alpha_private.tickets t
  join alpha_private.ticket_client_grants cg on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
    and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
  where t.workspace_id=$1 and t.project_id=$2 and t.client_user_id=$3 and t.project_client_visible`;

const LINKED_TASKS_SQL = `select x.ticket_id,i.id,i.identifier,i.title,i.status from (
    select ticket_id,issue_id from alpha_private.request_task_links where workspace_id=$1 and ticket_id=any($2::text[])
    union
    select ticket_id,issue_id from alpha_private.ticket_work_bindings where workspace_id=$1 and ticket_id=any($2::text[])
  ) x join public.issues i on i.id=x.issue_id and i.workspace_id=$1
    -- An archived task is off the board: it no longer counts toward the request, nor shows to the client.
    and i.archived_at is null
  order by i.created_at,i.id collate "C"`;

interface TimelineRow {
  id: string; kind: ConversationItemKind; author: 'client' | 'pm'; body: string | null; created_at: string | Date;
  ticket_id: string | null; reference: string | null; title: string | null;
  issue_id: string | null; identifier: string | null; issue_title: string | null;
  stage: { action: string; refId: string | null; number: unknown; name: unknown; stage: unknown; decision: unknown; title: unknown; extra: unknown } | null;
}
interface RequestRow {
  workspace_id: string; id: string; reference: string; title: string; description: string | null; status: string;
  created_at: string | Date; done: boolean | null; changed_by_kind: 'client' | 'pm' | null; changed_at: string | Date | null;
}
interface TaskRow { ticket_id: string; id: string; identifier: string; title: string; status: string }

function stageEvent(raw: NonNullable<TimelineRow['stage']>): ConversationStageEvent {
  return {
    action: raw.action, refId: raw.refId ?? null,
    number: typeof raw.number === 'number' ? raw.number : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    stage: typeof raw.stage === 'string' ? raw.stage : null,
    decision: typeof raw.decision === 'string' ? raw.decision : null,
    title: typeof raw.title === 'string' ? raw.title : null,
    extra: raw.extra === true,
  };
}

export class ClientProjectConversation {
  constructor(private readonly db: TransactionalSql, private readonly portal: PostgresClientProjectPortal) {}

  /** The whole conversation, oldest first (the latest 400 entries). */
  async timeline(target: ProjectTarget, subject: TicketSubject, clientId?: unknown) {
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, false);
      const pm = subject.kind === 'internal';
      const { rows } = await sql.query<TimelineRow>(`with visible as (${VISIBLE_REQUESTS_SQL}),
        entries as (
          select 'pm:'||m.id as id,'message' as kind,m.author_kind as author,m.body,m.created_at,
            null::text as ticket_id,null::text as issue_id,null::jsonb as stage
          from alpha_private.client_project_messages m
          where m.workspace_id=$1 and m.project_id=$2 and m.client_user_id=$3
          union all
          select 'request:'||v.id,'request','client',v.description,v.created_at,v.id,null,null from visible v
          union all
          select 'tm:'||m.id,case when m.audience='internal' then 'note' else 'message' end,m.author_kind,m.body,m.created_at,m.ticket_id,null,null
          from alpha_private.ticket_messages m join visible v on v.workspace_id=m.workspace_id and v.id=m.ticket_id
          where m.audience='client' or $4::boolean
          union all
          select 'ce:'||e.id,'clarification',
            case when e.event_type='proposal_clarification_requested' then 'pm' else 'client' end,
            e.metadata->>'body',e.occurred_at,v.id,null,null
          from alpha_private.ticket_central_intakes i
          join visible v on v.workspace_id=i.accepted_workspace_id and v.id=i.accepted_ticket_id
          join alpha_private.ticket_central_intake_events e on e.organization_key=i.organization_key and e.intake_id=i.id
          where e.event_type in ('proposal_clarification_requested','proposal_clarification_replied')
            and coalesce(btrim(e.metadata->>'body'),'')<>''
          union all
          select 'tl:'||l.issue_id,'task_linked','pm',null,l.linked_at,l.ticket_id,l.issue_id,null
          from alpha_private.request_task_links l join visible v on v.workspace_id=l.workspace_id and v.id=l.ticket_id
          union all
          select 'ck:'||c.ticket_id,case when c.done then 'request_done' else 'request_reopened' end,c.changed_by_kind,null,c.changed_at,c.ticket_id,null,null
          from alpha_private.client_request_checks c join visible v on v.workspace_id=c.workspace_id and v.id=c.ticket_id
          union all
          select 'se:'||e.id,'stage_event',e.actor_kind,e.body,e.created_at,null,null,
            jsonb_build_object('action',e.action,'refId',e.ref_id,'number',e.metadata->'number','name',e.metadata->'name',
              'stage',e.metadata->'stage','decision',e.metadata->'decision','title',e.metadata->'title','extra',e.metadata->'extra')
          from alpha_private.client_project_stage_events e
          where e.workspace_id=$1 and e.project_id=$2 and e.client_user_id=$3
        ),
        latest as (select * from entries order by created_at desc,id collate "C" desc limit 400)
        select l.id,l.kind,l.author,l.body,l.created_at,l.ticket_id,v.reference,v.title,
          i.id as issue_id,i.identifier,i.title as issue_title,l.stage
        from latest l
        left join visible v on v.id=l.ticket_id
        left join public.issues i on i.id=l.issue_id and i.workspace_id=$1
        order by l.created_at,l.id collate "C"`, [target.workspaceId, target.projectId, client, pm]);
      const items = rows.map((row): ConversationItem => ({
        id: row.id, kind: row.kind, author: row.author, body: row.body ?? '', createdAt: ticketSqlIso(row.created_at),
        request: row.ticket_id && row.reference && row.title !== null ? { ticketId: row.ticket_id, reference: row.reference, title: row.title } : null,
        task: row.issue_id && row.identifier ? { issueId: row.issue_id, identifier: row.identifier, title: row.issue_title ?? '' } : null,
        ...(row.kind === 'stage_event' && row.stage ? { stage: stageEvent(row.stage) } : {}),
      })).filter(item => item.kind !== 'task_linked' || item.task !== null);
      const summaries = await sql.query<{ ticket_id: string; title: string; body: string }>(`
        with visible as (${VISIBLE_REQUESTS_SQL})
        select v.id as ticket_id,v.title,e.metadata->>'discoverySummary' as body
          from visible v
          join alpha_private.ticket_central_intakes i on i.accepted_workspace_id=v.workspace_id
            and i.accepted_ticket_id=v.id and i.kind='project_proposal' and i.client_user_id=$3
          join alpha_private.ticket_central_intake_events e on e.organization_key=i.organization_key
            and e.intake_id=i.id and e.workspace_id=v.workspace_id and e.ticket_id=v.id and e.event_type='inquiry_accepted'
          where jsonb_typeof(e.metadata->'discoverySummary')='string' and btrim(e.metadata->>'discoverySummary')<>''
          order by e.occurred_at desc,e.id`, [target.workspaceId, target.projectId, client]);
      const discoverySummaries = summaries.rows.map(row => ({ ticketId: row.ticket_id, title: row.title, body: row.body }));
      return { items, ...(pm ? { clientId: client } : {}), ...(discoverySummaries.length ? { discoverySummaries } : {}) };
    });
  }

  /** The requests panel: every request on this project with its checklist status and linked tasks. */
  async requests(target: ProjectTarget, subject: TicketSubject, clientId?: unknown): Promise<{ items: ConversationRequest[] }> {
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, false);
      return { items: await this.loadRequests(sql, target, client) };
    });
  }

  /** Tick a request done, or reopen it. Either side may; a finished ticket cannot be reopened here. */
  async setDone(target: ProjectTarget, ticketId: unknown, subject: TicketSubject, input: unknown, clientId?: unknown) {
    const ticket = parse(id, ticketId);
    const { done } = parse(checkSchema, input);
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, true);
      const { rows } = await sql.query<{ status: string }>(`select v.status from (${VISIBLE_REQUESTS_SQL}) v where v.id=$4`,
        [target.workspaceId, target.projectId, client, ticket]);
      const status = rows[0]?.status;
      if (!status) missing();
      if (status === 'declined' || status === 'cancelled') {
        throw new TicketWorkflowError(409, 'request_not_checkable', 'This request was not taken on, so it has no checklist.');
      }
      if (!done && status === 'closed') {
        throw new TicketWorkflowError(409, 'request_finished', 'This request is finished. Make a new request for more changes.');
      }
      const actorKind = subject.kind === 'client' ? 'client' : 'pm';
      await sql.query(`insert into alpha_private.client_request_checks(workspace_id,ticket_id,done,changed_by_kind,changed_by,changed_at)
        values ($1,$2,$3,$4,$5,now()) on conflict(workspace_id,ticket_id) do update set
          done=excluded.done,changed_by_kind=excluded.changed_by_kind,changed_by=excluded.changed_by,changed_at=excluded.changed_at
        where client_request_checks.done is distinct from excluded.done`,
      [target.workspaceId, ticket, done, actorKind, subject.userId]);
      const request = (await this.loadRequests(sql, target, client)).find(item => item.ticketId === ticket);
      if (!request) missing();
      return request;
    });
  }

  /** PM: the projects this client can talk about, newest activity first. */
  async clientProjects(workspaceId: string, subject: TicketSubject, clientId: unknown): Promise<{ items: ClientProjectConversationSummary[] }> {
    const client = parse(id, clientId);
    return this.db.transaction(async sql => {
      await this.requirePm(sql, workspaceId, subject);
      const { rows } = await sql.query<{ project_id: string; name: string; open_requests: string; last_activity_at: string | Date }>(
        `with visible as (
          select t.project_id,t.status,t.client_updated_at,t.id,c.done
          from alpha_private.tickets t
          join alpha_private.ticket_client_grants cg on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
            and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
          join alpha_private.ticket_service_grants sg on sg.workspace_id=t.workspace_id and sg.client_user_id=t.client_user_id
            and sg.status='active' and sg.revoked_at is null
          left join alpha_private.client_request_checks c on c.workspace_id=t.workspace_id and c.ticket_id=t.id
          where t.workspace_id=$1 and t.client_user_id=$2 and t.project_id is not null and t.project_client_visible)
        select v.project_id,p.name,
          count(*) filter (where v.status not in ('closed','declined','cancelled') and v.done is not true) as open_requests,
          greatest(max(v.client_updated_at),coalesce((select max(m.created_at) from alpha_private.client_project_messages m
            where m.workspace_id=$1 and m.project_id=v.project_id and m.client_user_id=$2),'-infinity'::timestamptz)) as last_activity_at
        from visible v join public.projects p on p.workspace_id=$1 and p.id=v.project_id
        group by v.project_id,p.name
        order by last_activity_at desc,v.project_id collate "C"`, [workspaceId, client]);
      return { items: rows.map(row => ({ workspaceId, projectId: row.project_id, projectName: row.name,
        openRequests: Number(row.open_requests), lastActivityAt: ticketSqlIso(row.last_activity_at) })) };
    });
  }

  /** PM: open requests on a project, for the New task dialog's request picker. */
  async openRequests(workspaceId: string, projectId: unknown, subject: TicketSubject) {
    const project = parse(id, projectId);
    return this.db.transaction(async sql => {
      await this.requirePm(sql, workspaceId, subject);
      const { rows } = await sql.query<{ id: string; reference: string; title: string; client_user_id: string; client_name: string | null }>(
        `select t.id,t.reference,t.title,t.client_user_id,sg.display_name as client_name
         from alpha_private.tickets t
         left join alpha_private.ticket_service_grants sg on sg.workspace_id=t.workspace_id and sg.client_user_id=t.client_user_id
         left join alpha_private.client_request_checks c on c.workspace_id=t.workspace_id and c.ticket_id=t.id
         where t.workspace_id=$1 and t.project_id=$2 and t.client_user_id is not null
           and t.status not in ('closed','declined','cancelled') and c.done is not true
         order by t.created_at desc,t.id collate "C"`, [workspaceId, project]);
      return { items: rows.map(row => ({ ticketId: row.id, reference: row.reference, title: row.title,
        clientId: row.client_user_id, clientName: row.client_name ?? null })) };
    });
  }

  /** PM: which request each task on a project belongs to, for the task drawer. */
  async taskRequestLinks(workspaceId: string, projectId: unknown, subject: TicketSubject) {
    const project = parse(id, projectId);
    return this.db.transaction(async sql => {
      await this.requirePm(sql, workspaceId, subject);
      const { rows } = await sql.query<{ issue_id: string; ticket_id: string; reference: string; title: string; client_user_id: string | null }>(
        `select x.issue_id,t.id as ticket_id,t.reference,t.title,t.client_user_id from (
            select ticket_id,issue_id from alpha_private.request_task_links where workspace_id=$1 and project_id=$2
            union
            select ticket_id,issue_id from alpha_private.ticket_work_bindings where workspace_id=$1 and project_id=$2
          ) x join alpha_private.tickets t on t.workspace_id=$1 and t.id=x.ticket_id
         order by x.issue_id collate "C"`, [workspaceId, project]);
      return { items: rows.map(row => ({ issueId: row.issue_id, ticketId: row.ticket_id, reference: row.reference,
        title: row.title, clientId: row.client_user_id })) };
    });
  }

  /**
   * PM: link a task on the request's project to the request. Idempotent; a task belongs to one request.
   * New work under a request someone ticked done reopens it, so the client does not see Done while it is underway.
   */
  async linkTask(workspaceId: string, ticketId: unknown, subject: TicketSubject, input: unknown) {
    const ticket = parse(id, ticketId);
    const { issueId, source } = parse(linkSchema, input);
    return this.db.transaction(async sql => {
      await this.requirePm(sql, workspaceId, subject, true);
      const { rows: tickets } = await sql.query<{ project_id: string | null; status: string }>(
        `select project_id,status from alpha_private.tickets where workspace_id=$1 and id=$2 for share`, [workspaceId, ticket]);
      const request = tickets[0];
      if (!request) missing();
      if (!request.project_id) throw new TicketWorkflowError(409, 'request_project_required', 'Link this request to a project first.');
      if (['declined', 'cancelled'].includes(request.status)) throw new TicketWorkflowError(409, 'request_not_linkable', 'This request was not taken on.');
      const { rows: issues } = await sql.query<{ project_id: string }>(
        `select project_id from public.issues where id=$1 and workspace_id=$2 for share`, [issueId, workspaceId]);
      if (!issues[0]) throw new TicketWorkflowError(404, 'task_not_found', 'Task not found. If it was just created, try again in a moment.');
      if (issues[0].project_id !== request.project_id) {
        throw new TicketWorkflowError(409, 'task_project_mismatch', 'The task and the request belong to different projects.');
      }
      const { rows: existing } = await sql.query<{ ticket_id: string }>(
        `select ticket_id from alpha_private.request_task_links where workspace_id=$1 and issue_id=$2
         union all select ticket_id from alpha_private.ticket_work_bindings where workspace_id=$1 and issue_id=$2`, [workspaceId, issueId]);
      if (existing.some(row => row.ticket_id !== ticket)) {
        throw new TicketWorkflowError(409, 'task_already_linked', 'This task already belongs to another request.');
      }
      let reopened = false;
      if (!existing.length) {
        await sql.query(`insert into alpha_private.request_task_links(workspace_id,issue_id,ticket_id,project_id,source,linked_by)
          values ($1,$2,$3,$4,$5,$6)`, [workspaceId, issueId, ticket, request.project_id, source, subject.userId]);
        const { rows: reopenedRows } = await sql.query<{ ticket_id: string }>(
          `update alpha_private.client_request_checks set done=false,changed_by_kind='pm',changed_by=$3,changed_at=now()
            where workspace_id=$1 and ticket_id=$2 and done returning ticket_id`, [workspaceId, ticket, subject.userId]);
        reopened = reopenedRows.length > 0;
      }
      return { ticketId: ticket, issueId, reopened };
    });
  }

  /** PM: remove a link made here. Links made by plan approval stay with the plan. */
  async unlinkTask(workspaceId: string, ticketId: unknown, issueId: unknown, subject: TicketSubject) {
    const ticket = parse(id, ticketId);
    const issue = parse(id, issueId);
    return this.db.transaction(async sql => {
      await this.requirePm(sql, workspaceId, subject, true);
      await sql.query(`delete from alpha_private.request_task_links where workspace_id=$1 and ticket_id=$2 and issue_id=$3`,
        [workspaceId, ticket, issue]);
      return { ticketId: ticket, issueId: issue };
    });
  }

  private async requirePm(sql: Sql, workspaceId: string, subject: TicketSubject, write = false) {
    if (subject.kind !== 'internal' || !id.safeParse(workspaceId).success) missing();
    const scope = await new PostgresTicketAuthorization(sql).lockQueueScope(workspaceId, subject);
    if (!scope || scope.principal.kind !== 'pm') missing();
    if (write && scope.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
    return scope;
  }

  private async loadRequests(sql: Sql, target: ProjectTarget, client: string): Promise<ConversationRequest[]> {
    const { rows } = await sql.query<RequestRow>(`select v.*,c.done,c.changed_by_kind,c.changed_at
      from (${VISIBLE_REQUESTS_SQL}) v
      left join alpha_private.client_request_checks c on c.workspace_id=v.workspace_id and c.ticket_id=v.id
      order by v.created_at desc,v.id collate "C"`, [target.workspaceId, target.projectId, client]);
    if (!rows.length) return [];
    const { rows: tasks } = await sql.query<TaskRow>(LINKED_TASKS_SQL, [target.workspaceId, rows.map(row => row.id)]);
    return rows.map(row => {
      const linkedTasks = tasks.filter(task => task.ticket_id === row.id)
        .map(task => ({ issueId: task.id, identifier: task.identifier, title: task.title, status: task.status }));
      const checklist = requestChecklistStatus({ ticketStatus: row.status, done: row.done, linkedTaskStatuses: linkedTasks.map(task => task.status) });
      const ticked = row.done === true && row.changed_at;
      return {
        ticketId: row.id, workspaceId: row.workspace_id, reference: row.reference, title: row.title,
        description: row.description ?? '', ticketStatus: row.status, checklist,
        doneBy: ticked ? row.changed_by_kind : null, doneAt: ticked ? ticketSqlIso(row.changed_at!) : null,
        createdAt: ticketSqlIso(row.created_at), linkedTasks,
      };
    });
  }
}
