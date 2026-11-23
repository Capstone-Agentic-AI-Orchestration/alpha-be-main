import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import type { TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { PostgresClientProjectPortal } from './clientProjectPortal.js';
import { ClientProjectConversation } from './clientProjectConversation.js';
import { ClientProjectStages } from './clientProjectStages.js';

export const client: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'a'.repeat(64) };
export const other: TicketSubject = { kind: 'client', userId: 'client-b', sessionId: 'b'.repeat(64) };
export const pm: TicketSubject = { kind: 'internal', userId: 'pm', authentication: { kind: 'verified_github_bearer', verificationId: 'verified' } };
const target = { workspaceId: 'workspace-a', projectId: 'project-a' };
let pg: PGlite;
let db: TransactionalSql;
let stages: ClientProjectStages;
let conversation: ClientProjectConversation;
let portal: PostgresClientProjectPortal;
let op = 0;
const cmd = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, operationId: `op-${++op}`, ...extra });
const draft = {
  title: 'Booking site', summary: 'A site where customers book a table.',
  features: [{ title: 'Online booking', detail: 'Pick a date and time' }, { title: 'Email confirmation', detail: '' }],
  screens: ['Home', 'Booking'], outOfScope: 'Payments', note: '',
};

async function ticket(id: string, user: string, project = 'project-a') {
  const state = { ...newTicketWorkflow(id, 'workspace-a', user), projectId: project, status: 'received' };
  await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
    workflow_state,client_user_id,project_id,project_display_name,project_client_visible,created_at,client_updated_at,internal_updated_at)
    values ($1,'workspace-a',$1,'Request','Details','Client','authenticated_client','received',0,$2,$3,$4,'Project A',true,now(),now(),now())`,
  [id, JSON.stringify(state), user, project]);
  await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active) values ('workspace-a',$1,$2,true)`, [id, user]);
}

beforeAll(async () => {
  pg = await createTestDatabase();
  db = { ...sqlFor(pg), transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  portal = new PostgresClientProjectPortal(db);
  stages = new ClientProjectStages(db, portal);
  conversation = new ClientProjectConversation(db, portal);
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec('truncate public.workspaces cascade');
  await pg.exec('delete from alpha_private.ticket_client_sessions');
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ('workspace-a','A','a','active','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values ('member','workspace-a','pm','pm')`);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status) values ('project-a','workspace-a','Project A','A','active')`);
  for (const [user, session] of [['client-a', 'a'.repeat(64)], ['client-b', 'b'.repeat(64)]]) {
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,write_mode)
      values ($1,'workspace-a',$2,'active','Client '||$2,'enabled')`, [user, user]);
    await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
      values ($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')`, [session, user, 'c'.repeat(64)]);
  }
  await ticket('t-1', 'client-a');
});

describe('project stages: POC', () => {
  it('starts a new conversation in the POC stage, waiting on the PM', async () => {
    const summary = await stages.summary(target, client);
    expect(summary).toMatchObject({ stage: 'poc', revisionLimit: 3, revisionsUsed: 0, poc: null, pocDraft: null,
      nextAction: { who: 'pm', kind: 'publish_poc' } });
    expect('clientId' in summary).toBe(false);
    expect((await stages.summary(target, pm, 'client-a')).clientId).toBe('client-a');
  });

  it('keeps drafts with the PM, publishes versions, and lets the client ask for changes any number of times', async () => {
    let summary = await stages.savePocDraft(target, pm, draft, 'client-a');
    expect(summary.pocDraft).toMatchObject({ number: 1, status: 'draft', title: 'Booking site' });
    expect((await stages.summary(target, client)).poc).toBeNull();
    expect((await stages.summary(target, client)).pocDraft).toBeNull();

    const v1 = summary.pocDraft!.id;
    const published = await stages.publishPoc(target, pm, v1, cmd(), 'client-a');
    expect(published.receipt).toMatchObject({ action: 'poc_published', refId: v1 });
    summary = await stages.summary(target, client);
    expect(summary.poc).toMatchObject({ id: v1, number: 1, status: 'published' });
    expect(summary.poc?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.nextAction).toMatchObject({ who: 'client', kind: 'review_poc' });

    for (let round = 0; round < 2; round += 1) {
      const current = (await stages.summary(target, client)).poc!;
      await stages.requestPocChanges(target, client, current.id, cmd({ body: `Change ${round}` }));
      const pmView = await stages.summary(target, pm, 'client-a');
      expect(pmView.poc).toMatchObject({ status: 'changes_requested', changeRequest: { body: `Change ${round}` } });
      expect(pmView.nextAction?.who).toBe('pm');
      const next = await stages.savePocDraft(target, pm, { ...draft, summary: `Revised ${round}` }, 'client-a');
      await stages.publishPoc(target, pm, next.pocDraft!.id, cmd(), 'client-a');
    }
    summary = await stages.summary(target, client);
    expect(summary.poc).toMatchObject({ number: 3, status: 'published', summary: 'Revised 1' });
    expect(summary.pocHistory.map(item => [item.number, item.status])).toEqual([[3, 'published'], [2, 'superseded'], [1, 'superseded']]);
  });

  it('approves exactly the version the client read, then moves to the contract stage', async () => {
    const saved = await stages.savePocDraft(target, pm, draft, 'client-a');
    await stages.publishPoc(target, pm, saved.pocDraft!.id, cmd(), 'client-a');
    const poc = (await stages.summary(target, client)).poc!;

    await expect(stages.approvePoc(target, client, poc.id, cmd({ contentHash: 'f'.repeat(64), fullName: 'Juan Dela Cruz', consent: true })))
      .rejects.toMatchObject({ code: 'poc_changed' });
    await expect(stages.approvePoc(target, client, poc.id, cmd({ contentHash: poc.contentHash, fullName: 'Juan Dela Cruz', consent: false })))
      .rejects.toMatchObject({ code: 'invalid_stage_input' });
    await expect(stages.approvePoc(target, pm, poc.id, cmd({ contentHash: poc.contentHash, fullName: 'PM', consent: true }), ))
      .rejects.toMatchObject({ code: 'stage_action_not_allowed' });

    const approval = cmd({ contentHash: poc.contentHash, fullName: 'Juan Dela Cruz', consent: true });
    const result = await stages.approvePoc(target, client, poc.id, approval);
    expect(result.stage).toMatchObject({ stage: 'contract', poc: { status: 'approved', approvedName: 'Juan Dela Cruz' },
      nextAction: { who: 'pm', kind: 'issue_contract' } });
    // A repeated request returns the same receipt; reusing its id for something else is refused.
    const replay = await stages.approvePoc(target, client, poc.id, approval);
    expect(replay.receipt).toEqual(result.receipt);
    await expect(stages.requestPocChanges(target, client, poc.id, { schemaVersion: 1, operationId: approval.operationId, body: 'x' }))
      .rejects.toMatchObject({ code: 'stage_operation_conflict' });
    expect((await stages.operation(target, client, approval.operationId)).receipt).toEqual(result.receipt);

    await expect(stages.savePocDraft(target, pm, draft, 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.requestPocChanges(target, client, poc.id, cmd({ body: 'Too late' }))).rejects.toMatchObject({ code: 'stage_mismatch' });
  });

  it('shows stage events in the project conversation for both sides', async () => {
    const saved = await stages.savePocDraft(target, pm, draft, 'client-a');
    await stages.publishPoc(target, pm, saved.pocDraft!.id, cmd(), 'client-a');
    await stages.requestPocChanges(target, client, saved.pocDraft!.id, cmd({ body: 'Add a menu page' }));
    const items = (await conversation.timeline(target, client)).items.filter(item => item.kind === 'stage_event');
    expect(items.map(item => [item.author, item.stage?.action, item.stage?.number, item.body])).toEqual([
      ['pm', 'poc_published', 1, ''], ['client', 'poc_changes_requested', 1, 'Add a menu page']]);
    expect((await conversation.timeline(target, pm, 'client-a')).items.some(item => item.stage?.action === 'poc_published')).toBe(true);
  });

  it('keeps each client’s stage to that client', async () => {
    await ticket('t-b', 'client-b');
    const saved = await stages.savePocDraft(target, pm, draft, 'client-a');
    await stages.publishPoc(target, pm, saved.pocDraft!.id, cmd(), 'client-a');
    expect((await stages.summary(target, other)).poc).toBeNull();
    await expect(stages.requestPocChanges(target, other, saved.pocDraft!.id, cmd({ body: 'Mine?' }))).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.summary({ ...target, projectId: 'project-x' }, client)).rejects.toMatchObject({ status: 404 });
    await expect(stages.summary(target, pm)).rejects.toMatchObject({ code: 'project_thread_client_required' });
  });

  it('refuses writes while ticket writes are off', async () => {
    await db.query(`update public.workspaces set settings_json='{"ticketing_write_mode":"disabled"}'`);
    await expect(stages.savePocDraft(target, pm, draft, 'client-a')).rejects.toMatchObject({ status: 503 });
  });

  it('lets the PM choose where a project that predates stages starts, once', async () => {
    await db.query(`insert into alpha_private.client_project_stages(workspace_id,project_id,client_user_id,stage)
      values ('workspace-a','project-a','client-a','unset')`);
    expect((await stages.summary(target, client)).nextAction).toMatchObject({ who: 'pm', kind: 'set_stage' });
    await expect(stages.setStartingStage(target, client, cmd({ stage: 'development' }))).rejects.toMatchObject({ code: 'stage_action_not_allowed' });
    const result = await stages.setStartingStage(target, pm, cmd({ stage: 'development', revisionsUsed: 2 }), 'client-a');
    expect(result.stage).toMatchObject({ stage: 'development', revisionsUsed: 2, revisionLimit: 3 });
    await expect(stages.setStartingStage(target, pm, cmd({ stage: 'poc' }), 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
  });

  it('puts the stage on the client’s project list', async () => {
    const { items } = await portal.projects(client);
    expect(items[0]?.stage).toMatchObject({ stage: 'poc', label: 'Proof of concept', waitingOn: 'pm' });
  });
});
