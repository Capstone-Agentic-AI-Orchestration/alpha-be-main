import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import type { TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { PostgresClientProjectPortal } from './clientProjectPortal.js';
import { ClientProjectConversation, requestChecklistStatus } from './clientProjectConversation.js';
import { clientRequestBriefsFromDatabase } from './clientRequestBriefs.js';

const client: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'a'.repeat(64) };
const other: TicketSubject = { kind: 'client', userId: 'client-b', sessionId: 'b'.repeat(64) };
const pm: TicketSubject = { kind: 'internal', userId: 'pm', authentication: { kind: 'verified_github_bearer', verificationId: 'verified' } };
const target = { workspaceId: 'workspace-a', projectId: 'project-a' };
let pg: PGlite;
let db: TransactionalSql;
let portal: PostgresClientProjectPortal;
let app: ClientProjectConversation;

async function ticket(id: string, user: string, at: string, extra: { status?: string; project?: string | null } = {}) {
  const state = { ...newTicketWorkflow(id, 'workspace-a', user), projectId: extra.project === undefined ? 'project-a' : extra.project,
    status: extra.status ?? 'received' };
  await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
    workflow_state,client_user_id,project_id,project_display_name,project_client_visible,created_at,client_updated_at,internal_updated_at,closed_at)
    values ($1,'workspace-a',$1,$2,'Details for '||$2,'Client','authenticated_client',$3,0,$4,$5,$6,'Project A',$7,$8,$8,$8,
      case when $3 in ('closed','declined','cancelled') then $8::timestamptz else null end)`,
  [id, 'Request ' + id, state.status, JSON.stringify(state), user, state.projectId, state.projectId !== null, at]);
  await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active) values ('workspace-a',$1,$2,true)`, [id, user]);
}

beforeAll(async () => {
  pg = await createTestDatabase();
  db = { ...sqlFor(pg), transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  portal = new PostgresClientProjectPortal(db);
  app = new ClientProjectConversation(db, portal);
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec('truncate public.workspaces cascade');
  await pg.exec('delete from alpha_private.ticket_client_sessions');
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ('workspace-a','A','a','active','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values ('member','workspace-a','pm','pm')`);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status) values
    ('project-a','workspace-a','Project A','A','active'),('project-c','workspace-a','Project C','C','active')`);
  for (const [user, session] of [['client-a', 'a'.repeat(64)], ['client-b', 'b'.repeat(64)]]) {
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,write_mode)
      values ($1,'workspace-a',$2,'active','Client '||$2,'enabled')`, [user, user]);
    await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
      values ($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')`, [session, user, 'c'.repeat(64)]);
  }
  await ticket('t-1', 'client-a', '2026-11-01T10:00:00Z');
  await ticket('t-2', 'client-a', '2026-11-02T10:00:00Z');
  await ticket('t-other', 'client-b', '2026-11-01T11:00:00Z');
  await db.query(`insert into public.issues(id,workspace_id,identifier,title,status,priority,project_id) values
    ('issue-1','workspace-a','A-1','Build the page','todo','medium','project-a'),
    ('issue-2','workspace-a','A-2','Write the copy','done','medium','project-a'),
    ('issue-c','workspace-a','C-1','Elsewhere','todo','medium','project-c')`);
});

describe('request checklist status', () => {
  it('follows linked tasks until someone ticks it done', () => {
    expect(requestChecklistStatus({ ticketStatus: 'received', done: null, linkedTaskStatuses: [] })).toBe('open');
    expect(requestChecklistStatus({ ticketStatus: 'under_review', done: null, linkedTaskStatuses: ['todo', 'done'] })).toBe('in_progress');
    expect(requestChecklistStatus({ ticketStatus: 'under_review', done: null, linkedTaskStatuses: ['done'] })).toBe('ready_to_check');
    expect(requestChecklistStatus({ ticketStatus: 'under_review', done: true, linkedTaskStatuses: ['todo'] })).toBe('done');
    expect(requestChecklistStatus({ ticketStatus: 'closed', done: null, linkedTaskStatuses: [] })).toBe('done');
    expect(requestChecklistStatus({ ticketStatus: 'declined', done: true, linkedTaskStatuses: [] })).toBe('declined');
  });
});

describe('one conversation per client and project', () => {
  it('merges the project thread, requests, their messages and an accepted proposal, without other clients', async () => {
    await portal.reply(target, client, { schemaVersion: 1, operationId: 'op-1', body: 'General hello' });
    await db.query(`insert into alpha_private.ticket_messages(id,workspace_id,ticket_id,author_kind,author_id,audience,body,created_at) values
      ('m-1','workspace-a','t-1','pm','pm','client','About request one','2026-11-01T12:00:00Z'),
      ('m-2','workspace-a','t-1','pm','pm','internal','PM only note','2026-11-01T12:30:00Z'),
      ('m-3','workspace-a','t-other','client','client-b','client','Other client','2026-11-01T12:00:00Z')`);
    // The proposal that became request t-1, with one clarification round.
    await db.query(`insert into alpha_private.ticket_central_intakes(organization_key,id,operation_id,fingerprint,fingerprint_key_id,
        full_name,email,title,description,status,submitted_at,accepted_by,accepted_workspace_id,accepted_ticket_id,
        acceptance_operation_id,accepted_at,public_reference,kind,client_user_id)
      values ('org','intake-1','submit-op',$1,'key','Client A','a@example.com','P','D','accepted','2026-10-30T10:00:00Z',
        'pm','workspace-a','t-1','accept-op','2026-11-01T10:00:00Z','INQ-1','project_proposal','client-a')`, ['f'.repeat(64)]);
    await db.query(`insert into alpha_private.ticket_central_intake_events(id,organization_key,intake_id,event_type,actor_kind,actor_id,
        workspace_id,ticket_id,occurred_at,metadata) values
      ('e-1','org','intake-1','proposal_clarification_requested','pm','pm','workspace-a',null,'2026-10-31T09:00:00Z','{"body":"Which pages?"}'),
      ('e-2','org','intake-1','proposal_clarification_replied','client','client-a',null,null,'2026-10-31T10:00:00Z','{"body":"Home and About."}'),
      ('e-3','org','intake-1','inquiry_accepted','pm','pm','workspace-a','t-1','2026-11-01T10:00:00Z','{"discoverySummary":"Start with Home and About."}')`);

    const forClient = await app.timeline(target, client);
    const bodies = forClient.items.map(item => item.body);
    expect(bodies).toContain('General hello');
    expect(bodies).toContain('About request one');
    expect(bodies).not.toContain('PM only note');
    expect(bodies).not.toContain('Other client');
    expect(forClient.items.filter(item => item.kind === 'request').map(item => item.request?.ticketId)).toEqual(['t-1', 't-2']);
    expect(forClient.items.find(item => item.body === 'About request one')?.request).toMatchObject({ ticketId: 't-1', title: 'Request t-1' });
    expect('clientId' in forClient).toBe(false);
    const clarifications = forClient.items.filter(item => item.kind === 'clarification');
    expect(clarifications.map(item => [item.author, item.body])).toEqual([['pm', 'Which pages?'], ['client', 'Home and About.']]);
    expect(forClient.items[0]?.body).toBe('Which pages?');
    expect(forClient.discoverySummaries).toEqual([{ ticketId: 't-1', title: 'Request t-1', body: 'Start with Home and About.' }]);
    expect((await app.timeline(target, other)).discoverySummaries).toBeUndefined();

    const forPm = await app.timeline(target, pm, 'client-a');
    expect(forPm.discoverySummaries).toEqual(forClient.discoverySummaries);
    expect(forPm.clientId).toBe('client-a');
    expect(forPm.items.find(item => item.body === 'PM only note')?.kind).toBe('note');
    await expect(app.timeline(target, pm)).rejects.toMatchObject({ code: 'project_thread_client_required' });
  });

  it('lists requests with linked tasks and lets the client tick one done, then reopen it', async () => {
    await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-1' });
    await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-1' });
    let requests = (await app.requests(target, client)).items;
    expect(requests.map(r => r.ticketId)).toEqual(['t-2', 't-1']);
    expect(requests.find(r => r.ticketId === 't-1')).toMatchObject({ checklist: 'in_progress', linkedTasks: [{ issueId: 'issue-1', identifier: 'A-1' }] });
    expect(requests.find(r => r.ticketId === 't-2')?.checklist).toBe('open');

    await db.query(`update public.issues set status='done' where id='issue-1'`);
    expect((await app.requests(target, client)).items.find(r => r.ticketId === 't-1')?.checklist).toBe('ready_to_check');

    const done = await app.setDone(target, 't-1', client, { done: true });
    expect(done).toMatchObject({ checklist: 'done', doneBy: 'client' });
    const reopened = await app.setDone(target, 't-1', pm, { done: false }, 'client-a');
    expect(reopened).toMatchObject({ checklist: 'ready_to_check', doneBy: null });
    const kinds = (await app.timeline(target, client)).items.map(item => item.kind);
    expect(kinds).toContain('task_linked');
    expect(kinds).toContain('request_reopened');

    await expect(app.setDone(target, 't-other', client, { done: true })).rejects.toMatchObject({ status: 404 });
    await expect(app.setDone(target, 't-1', other, { done: true })).rejects.toMatchObject({ status: 404 });
    requests = (await app.requests(target, other)).items;
    expect(requests.map(r => r.ticketId)).toEqual(['t-other']);
  });

  it('refuses to reopen a finished ticket or tick a declined one', async () => {
    await ticket('t-closed', 'client-a', '2026-11-03T10:00:00Z', { status: 'closed' });
    await ticket('t-declined', 'client-a', '2026-11-03T11:00:00Z', { status: 'declined' });
    expect((await app.requests(target, client)).items.find(r => r.ticketId === 't-closed')?.checklist).toBe('done');
    await expect(app.setDone(target, 't-closed', client, { done: false })).rejects.toMatchObject({ code: 'request_finished' });
    await expect(app.setDone(target, 't-declined', client, { done: true })).rejects.toMatchObject({ code: 'request_not_checkable' });
  });

  it('reopens a request ticked done when a new task is added under it', async () => {
    await app.setDone(target, 't-1', client, { done: true });
    expect(await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-1' })).toMatchObject({ reopened: true });
    const request = (await app.requests(target, client)).items.find(r => r.ticketId === 't-1');
    expect(request).toMatchObject({ checklist: 'in_progress', doneBy: null });
    expect((await app.timeline(target, client)).items.map(item => item.kind)).toContain('request_reopened');
    // Linking the same task again changes nothing.
    expect(await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-1' })).toMatchObject({ reopened: false });
  });

  it('leaves archived tasks out of a request’s progress', async () => {
    await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-1' });
    await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-2' });
    expect((await app.requests(target, client)).items.find(r => r.ticketId === 't-1')?.checklist).toBe('in_progress');
    await db.query(`update public.issues set archived_at = now() where id = 'issue-1'`);
    const request = (await app.requests(target, client)).items.find(r => r.ticketId === 't-1');
    expect(request?.linkedTasks.map(task => task.issueId)).toEqual(['issue-2']);
    expect(request?.checklist).toBe('ready_to_check');
  });

  it('gives a build the live requests behind its tasks, on that project only', async () => {
    await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-1' });
    await app.linkTask('workspace-a', 't-2', pm, { issueId: 'issue-2' });
    expect(await clientRequestBriefsFromDatabase(db, 'workspace-a', 'project-a', ['issue-1', 'issue-2'])).toEqual([
      { reference: 't-1', title: 'Request t-1', description: 'Details for Request t-1' },
      { reference: 't-2', title: 'Request t-2', description: 'Details for Request t-2' }]);
    expect(await clientRequestBriefsFromDatabase(db, 'workspace-a', 'project-c', ['issue-1'])).toEqual([]);
    // A cancelled request is not background for anything: its link is ignored.
    await ticket('t-cancelled', 'client-a', '2026-11-04T10:00:00Z', { status: 'cancelled' });
    await db.query(`insert into public.issues(id,workspace_id,identifier,title,status,priority,project_id)
      values ('issue-3','workspace-a','A-3','Old work','todo','medium','project-a')`);
    await db.query(`insert into alpha_private.request_task_links(workspace_id,issue_id,ticket_id,project_id,source,linked_by)
      values ('workspace-a','issue-3','t-cancelled','project-a','conversation','pm')`);
    expect((await clientRequestBriefsFromDatabase(db, 'workspace-a', 'project-a', ['issue-1', 'issue-3'])).map(b => b.reference)).toEqual(['t-1']);
  });

  it('links a task only to a request on the same project, once, and only for PMs', async () => {
    await expect(app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-c' })).rejects.toMatchObject({ code: 'task_project_mismatch' });
    await expect(app.linkTask('workspace-a', 't-1', client, { issueId: 'issue-1' })).rejects.toMatchObject({ status: 404 });
    await app.linkTask('workspace-a', 't-1', pm, { issueId: 'issue-1', source: 'task_dialog' });
    await expect(app.linkTask('workspace-a', 't-2', pm, { issueId: 'issue-1' })).rejects.toMatchObject({ code: 'task_already_linked' });
    expect((await app.taskRequestLinks('workspace-a', 'project-a', pm)).items).toEqual([
      { issueId: 'issue-1', ticketId: 't-1', reference: 't-1', title: 'Request t-1', clientId: 'client-a' }]);
    await app.unlinkTask('workspace-a', 't-1', 'issue-1', pm);
    expect((await app.taskRequestLinks('workspace-a', 'project-a', pm)).items).toEqual([]);
  });

  it('gives the PM open requests for the task picker and the client’s project list', async () => {
    await app.setDone(target, 't-2', client, { done: true });
    const open = (await app.openRequests('workspace-a', 'project-a', pm)).items;
    expect(open.map(r => r.ticketId).sort((a, b) => a.localeCompare(b))).toEqual(['t-1', 't-other']);
    expect(open.find(r => r.ticketId === 't-1')?.clientName).toBe('Client client-a');
    const projects = (await app.clientProjects('workspace-a', pm, 'client-a')).items;
    expect(projects).toEqual([expect.objectContaining({ projectId: 'project-a', projectName: 'Project A', openRequests: 1 })]);
    await expect(app.clientProjects('workspace-a', client, 'client-a')).rejects.toMatchObject({ status: 404 });
  });
});
