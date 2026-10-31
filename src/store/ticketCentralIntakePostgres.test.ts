import { ClientProjectProposals } from '../services/clientProjectProposals.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { PostgresTicketQueueStore } from './ticketQueuePostgresStore.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { PostgresTicketTriageStore } from './ticketTriagePostgresStore.js';
import { PostgresClientProjectPortal } from '../services/clientProjectPortal.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import { createTicketProjectManagementService } from '../services/ticketProjectManagementService.js';
import { PostgresTicketProjectManagementStore } from './ticketProjectManagementPostgresStore.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTicketCentralIntakeService } from '../services/ticketCentralIntakeService.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { sqlFor, createTestDatabase } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import { PostgresTicketCentralIntakeStore } from './ticketCentralIntakePostgresStore.js';
import { PostgresTicketAcknowledgmentStore } from './ticketAcknowledgmentPostgresStore.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createTicketAcknowledgmentDeliveryService } from '../services/ticketAcknowledgmentDeliveryService.js';

const organizationKey = 'central-intake-test-org';
const workspaceA = 'central-intake-workspace-a';
const workspaceB = 'central-intake-workspace-b';
const submittedAt = new Date('2026-10-16T08:00:00.000Z');
const operationId = '00000000-0000-4000-8000-000000000001';
const pmA: TicketSubject = { kind: 'internal', userId: 'central-pm-a',
  authentication: { kind: 'verified_github_bearer', verificationId: 'central-test-a' } };
const pmB: TicketSubject = { kind: 'internal', userId: 'central-pm-b',
  authentication: { kind: 'verified_github_bearer', verificationId: 'central-test-b' } };
const developer: TicketSubject = { kind: 'internal', userId: 'central-dev',
  authentication: { kind: 'verified_github_bearer', verificationId: 'central-test-dev' } };
const inquiry = {
  schemaVersion: 1, operationId, fullName: 'Central Intake Client', email: 'person@example.test', company: 'Example Co',
  title: 'Review the new workflow', description: 'Please review this request before it becomes a workspace ticket.',
  requestedDeadline: '2026-11-01',
};

let pg: PGlite;
let db: TransactionalSql;
let app: ReturnType<typeof createTicketCentralIntakeService>;
let ids: number;

async function seedWorkspace(id: string) {
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json)
    values ($1,$2,$1,'active','{"ticketing_write_mode":"enabled"}')`, [id, id === workspaceA ? 'Workspace A' : 'Workspace B']);
}

beforeEach(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  ids = 0;
  await seedWorkspace(workspaceA);
  await seedWorkspace(workspaceB);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role,status) values
    ('central-member-a',$1,'central-pm-a','pm','active'),
    ('central-member-b',$2,'central-pm-b','pm','active'),
    ('central-member-dev',$1,'central-dev','dev','active')`, [workspaceA, workspaceB]);
  const store = new PostgresTicketCentralIntakeStore(db);
  app = createTicketCentralIntakeService({
    store,
    organizationKey,
    guard: { async admitRequest(entry, request) {
      if (entry.id !== organizationKey || request.origin !== 'https://alpha.example.test'
        || request.remoteAddress !== '192.0.2.10') return null;
      return { entryId: organizationKey, rateSubjectKey: 'a'.repeat(64),
        issuedAt: submittedAt.toISOString(), expiresAt: new Date(submittedAt.getTime() + 60_000).toISOString() };
    } },
    fingerprintKeys: [{ id: 'test-fingerprint-v1', secret: new Uint8Array(32).fill(9) }],
    maxRequestAgeMs: 300_000,
    now: () => submittedAt,
    nextId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
});

afterEach(async () => { await pg?.close(); });

describe('central PM inquiry intake on PostgreSQL', () => {
  it('paginates accepted and declined history and keeps it PM-only and private', async () => {
    const request = { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' };
    await app.submit(inquiry, request);
    await app.submit({ ...inquiry, operationId: '00000000-0000-4000-8000-000000000008', title: 'Another inquiry' }, request);
    const pending = await app.listPending(workspaceA, pmA, {});
    await app.accept(pending.items[0].id, workspaceA, pmA, { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000009' });
    await app.decline(pending.items[1].id, workspaceA, pmA, { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000010', reason: 'PRIVATE_INTERNAL_REASON' });
    const first = await app.listPending(workspaceA, pmA, { filter: 'handled', limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
    const second = await app.listPending(workspaceA, pmA, { filter: 'handled', limit: 1, after: first.nextCursor });
    expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(new Set([first.items[0].status, second.items[0].status])).toEqual(new Set(['accepted', 'declined']));
    expect(JSON.stringify([first, second])).not.toContain('PRIVATE_INTERNAL_REASON');
    await expect(app.listPending(workspaceA, developer, { filter: 'handled' })).rejects.toMatchObject({ status: 403 });
    const security = await db.query<{ relrowsecurity: boolean; anon_read: boolean }>(`select c.relrowsecurity,
      has_table_privilege('anon','alpha_private.ticket_central_intake_outcomes','select') as anon_read
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='alpha_private' and c.relname='ticket_central_intake_outcomes'`);
    expect(security.rows[0]).toEqual({ relrowsecurity: true, anon_read: false });
  });
  it('stores a pre-ticket inquiry centrally and creates a workspace ticket only after PM acceptance', async () => {
    const request = { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' };
    await expect(app.submit(inquiry, request)).resolves.toMatchObject({ received: true, publicReference: expect.stringMatching(/^INQ-[A-F0-9]{32}$/) });
    const receipt = await app.submit(inquiry, request);
    expect(receipt).toMatchObject({ received: true, publicReference: expect.stringMatching(/^INQ-[A-F0-9]{32}$/) });
    await expect(app.submit({ ...inquiry, title: 'Changed body' }, request))
      .rejects.toMatchObject({ code: 'operation_conflict' });
    expect((await db.query('select id from alpha_private.tickets')).rows).toEqual([]);
    expect((await db.query("select id from alpha_private.ticket_central_intakes where status='pending'")).rows).toHaveLength(1);

    await expect(app.listPending(workspaceA, developer, {})).rejects.toMatchObject({ status: 403 });
    const page = await app.listPending(workspaceA, pmA, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ fullName: inquiry.fullName, email: inquiry.email, title: inquiry.title });

    const acceptanceOperationId = '00000000-0000-4000-8000-000000000002';
    const accepted = await app.accept(page.items[0].id, workspaceA, pmA,
      { schemaVersion: 1, operationId: acceptanceOperationId });
    expect(accepted).toMatchObject({ workspaceId: workspaceA, operationId: acceptanceOperationId, reference: expect.stringMatching(/^TKT-[A-F0-9]{32}$/) });
    await expect(app.accept(page.items[0].id, workspaceA, pmA,
      { schemaVersion: 1, operationId: acceptanceOperationId })).resolves.toEqual(accepted);
    await expect(app.accept(page.items[0].id, workspaceB, pmB,
      { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000003' }))
      .rejects.toMatchObject({ status: 409 });
    await expect(app.listPending(workspaceA, pmA, {})).resolves.toMatchObject({ items: [], nextCursor: null });

    const { rows: ticketRows } = await db.query<Record<string, unknown>>(
      `select workspace_id,source,status,client_user_id,contact_id,project_id
         from alpha_private.tickets where id=$1`, [accepted.ticketId]);
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0]).toMatchObject({ workspace_id: workspaceA, source: 'public_inquiry', status: 'received',
      client_user_id: null, project_id: null });
    const { rows: contactRows } = await db.query<Record<string, unknown>>(
      `select email,email_verified from alpha_private.ticket_contacts where id=$1`, [ticketRows[0].contact_id]);
    expect(contactRows).toEqual([{ email: inquiry.email, email_verified: false }]);
    const { rows: requestRows } = await db.query<Record<string, unknown>>(
      `select requested_deadline,project_preference,preferred_project_id from alpha_private.ticket_requests where ticket_id=$1`, [accepted.ticketId]);
    expect(requestRows).toEqual([{ requested_deadline: inquiry.requestedDeadline, project_preference: 'not_sure', preferred_project_id: null }]);
    expect((await db.query('select * from alpha_private.ticket_client_grants where ticket_id=$1', [accepted.ticketId])).rows).toEqual([]);
    expect((await db.query('select * from public.projects where workspace_id=$1', [workspaceA])).rows).toEqual([]);
    expect((await db.query('select * from public.issues where workspace_id=$1', [workspaceA])).rows).toEqual([]);
    expect((await db.query('select event_type from alpha_private.ticket_central_intake_events where intake_id=$1 order by event_type', [page.items[0].id])).rows)
      .toEqual([{ event_type: 'inquiry_accepted' }, { event_type: 'inquiry_received' }]);
    expect((await db.query('select actor_kind,event_type from alpha_private.ticket_audit_events where ticket_id=$1 order by event_type', [accepted.ticketId])).rows)
      .toEqual([{ actor_kind: 'pm', event_type: 'inquiry_accepted' }, { actor_kind: 'anonymous', event_type: 'inquiry_received' }]);
  });

  it('does not let a PM without active membership in the selected workspace accept into it', async () => {
    await app.submit(inquiry, { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' });
    const page = await app.listPending(workspaceA, pmA, {});
    await expect(app.accept(page.items[0].id, workspaceB, pmA,
      { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000004' }))
      .rejects.toBeInstanceOf(TicketWorkflowError);
  });

  it('queues a receipt email with the stable central inquiry reference, without creating a ticket', async () => {
    const receipt = await app.submit(inquiry, { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' });
    let sent: unknown[] = [];
    const acknowledgments = new PostgresTicketAcknowledgmentStore(db);
    const delivery = createTicketAcknowledgmentDeliveryService(acknowledgments, {
      identity: 'central-receipt-provider',
      async send(...args: [string, string, string?]) { sent = args; },
    });
    expect(await delivery.deliverNext()).toBe(true);
    expect(sent).toEqual([inquiry.email, inquiry.operationId, receipt.publicReference]);
    expect((await db.query<{ status: string }>(
      'select status from alpha_private.ticket_central_intake_acknowledgments')).rows).toEqual([{ status: 'delivered' }]);
    expect((await db.query('select id from alpha_private.tickets')).rows).toEqual([]);
  });

  it('retains a PM decline and optional note without making a ticket or granting access', async () => {
    await app.submit(inquiry, { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' });
    const page = await app.listPending(workspaceA, pmA, {});
    const declineOperationId = '00000000-0000-4000-8000-000000000005';
    const declineInput = {
      schemaVersion: 1, operationId: declineOperationId, reason: 'Outside our current service scope.',
    };
    const declineReceipt = { intakeId: page.items[0].id, operationId: declineOperationId, status: 'declined' };
    await expect(app.decline(page.items[0].id, workspaceA, pmA, declineInput)).resolves.toEqual(declineReceipt);
    await expect(app.decline(page.items[0].id, workspaceA, pmA, declineInput)).resolves.toEqual(declineReceipt);
    await expect(app.decline(page.items[0].id, workspaceA, pmA, {
      ...declineInput, reason: 'A different internal note.',
    })).rejects.toMatchObject({ status: 409 });
    await expect(app.accept(page.items[0].id, workspaceA, pmA, {
      schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000006',
    })).rejects.toMatchObject({ status: 409 });
    expect((await app.listPending(workspaceA, pmA, {})).items).toEqual([]);
    const handled = await app.listPending(workspaceA, pmA, { filter: 'handled' });
    expect(handled.items[0]).toMatchObject({ id: page.items[0].id, status: 'declined', handledAt: submittedAt.toISOString(), outcomeEmailStatus: 'pending' });
    expect(JSON.stringify(handled)).not.toContain(declineInput.reason);
    await expect(app.listPending(workspaceA, developer, { filter: 'handled' })).rejects.toMatchObject({ status: 403 });
    await expect(app.listPending(workspaceA, pmA, { filter: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect((await db.query('select * from alpha_private.ticket_central_intake_outcomes')).rows).toHaveLength(1);
    const sends: unknown[][] = [];
    const delivery = createTicketAcknowledgmentDeliveryService(new PostgresTicketAcknowledgmentStore(db, true), {
      identity: 'test-outcome-provider', async send(...args) { sends.push(args); },
    });
    expect(await delivery.deliverNext()).toBe(true);
    expect(await delivery.deliverNext()).toBe(false);
    expect(sends).toEqual([[inquiry.email, expect.any(String), page.items[0].publicReference, 'declined']]);
    expect(JSON.stringify(sends)).not.toContain(declineInput.reason);
    expect((await app.listPending(workspaceA, pmA, { filter: 'handled' })).items[0].outcomeEmailStatus).toBe('delivered');
    expect((await db.query<{ status: string; decline_reason: string }>(
      'select status,decline_reason from alpha_private.ticket_central_intakes where id=$1', [page.items[0].id])).rows)
      .toEqual([{ status: 'declined', decline_reason: 'Outside our current service scope.' }]);
    expect((await db.query('select id from alpha_private.tickets')).rows).toEqual([]);
    expect((await db.query('select * from alpha_private.ticket_client_grants')).rows).toEqual([]);
  });
});

const proposalOwner = {kind:'client' as const,userId:'proposal-client',sessionId:'a'.repeat(64)};
const proposalBody = {schemaVersion:1 as const,operationId:'10000000-0000-4000-8000-000000000001',
 title:'New project',description:'A separate project outcome',requestedDeadline:null};
async function submitProposal() {
 const proposals=new ClientProjectProposals(db,organizationKey);
 const receipt=await proposals.submit(proposalOwner,'verified@example.test',proposalBody);
 return {proposals,receipt};
}
describe('authenticated project proposals',()=>{
 it('isolates ownership, validates identity fields, and keeps submission retries idempotent',async()=>{
  const {proposals,receipt}=await submitProposal();
  expect(await proposals.submit(proposalOwner,'verified@example.test',proposalBody)).toEqual(receipt);
  expect((await proposals.list(proposalOwner)).items).toHaveLength(1);
  expect((await proposals.list({...proposalOwner,userId:'other-client'})).items).toEqual([]);
  await expect(proposals.submit(proposalOwner,'verified@example.test',{...proposalBody,email:'spoof@example.test'})).rejects.toMatchObject({status:400});
  await expect(proposals.submit(proposalOwner,null,proposalBody)).rejects.toMatchObject({status:503});
  await expect(proposals.submit({...proposalOwner,userId:'other-client'},'other@example.test',proposalBody)).rejects.toMatchObject({status:409});
  const event=await db.query('select event_type,actor_kind,actor_id,workspace_id,ticket_id from alpha_private.ticket_central_intake_events where intake_id=$1',[receipt.id]);
  expect(event.rows).toEqual([{event_type:'project_proposal_received',actor_kind:'client',actor_id:proposalOwner.userId,workspace_id:null,ticket_id:null}]);
  const pending=await app.listPending(workspaceA,pmA,{});
  expect(pending.items[0]).toMatchObject({kind:'project_proposal',fullName:'verified@example.test',email:'verified@example.test'});
  expect(JSON.stringify(pending)).not.toContain('proposal-client');
 });
 it('accepts exactly once into an account-linked unlinked ticket with both grants',async()=>{
  const {proposals,receipt}=await submitProposal();
  const command={schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000001'};
  const accepted=await app.accept(receipt.id,workspaceA,pmA,command);
  expect(await app.accept(receipt.id,workspaceA,pmA,command)).toEqual(accepted);
  await expect(app.accept(receipt.id,workspaceB,pmB,{...command,operationId:'20000000-0000-4000-8000-000000000002'})).rejects.toMatchObject({status:409});
  expect((await proposals.list(proposalOwner)).items).toEqual([]);
  const rows=await db.query(`select t.client_user_id,t.project_id,t.source,r.project_preference,g.active,s.status
   from alpha_private.tickets t join alpha_private.ticket_requests r on r.workspace_id=t.workspace_id and r.ticket_id=t.id
   join alpha_private.ticket_client_grants g on g.workspace_id=t.workspace_id and g.ticket_id=t.id
   join alpha_private.ticket_service_grants s on s.workspace_id=t.workspace_id and s.client_user_id=t.client_user_id
   where t.id=$1`,[accepted.ticketId]);
  expect(rows.rows).toEqual([{client_user_id:proposalOwner.userId,project_id:null,source:'authenticated_client',project_preference:'new_project',active:true,status:'active'}]);
  expect((await db.query('select * from public.projects')).rows).toHaveLength(0);
  await db.query(`insert into alpha_private.ticket_client_sessions
   (session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
   values($1,$2,$3,now()-interval '1 minute',now()+interval '1 hour')`,[proposalOwner.sessionId,proposalOwner.userId,'b'.repeat(64)]);
  const queue=await createTicketQueueService(new PostgresTicketQueueStore(db)).list(workspaceA,proposalOwner,{});
  expect(queue.items.map(item=>item.id)).toContain(accepted.ticketId);
  const target={workspaceId:workspaceA,ticketId:accepted.ticketId};
  const version=async()=> (await db.query<{version:number}>('select version from alpha_private.tickets where id=$1',[accepted.ticketId])).rows[0].version;
  const messages=createTicketMessageService(new PostgresTicketTriageStore(db,{communicationEnabled:true}));
  await messages.reply(target,proposalOwner,{schemaVersion:1,operationId:'30000000-0000-4000-8000-000000000001',expectedVersion:await version(),body:'Can we discuss the scope?'});
  await messages.reply(target,pmA,{schemaVersion:1,operationId:'30000000-0000-4000-8000-000000000002',expectedVersion:await version(),body:'Yes, let us confirm it.'});
  const project=await new PostgresProjectStore(db).create(workspaceA,{id:'proposal-project',name:'New client project',key:'NEW',status:'in_progress',createdBy:pmA.userId});
  await createTicketProjectManagementService(new PostgresTicketProjectManagementStore(db)).linkProject(target,pmA,
   {schemaVersion:1,operationId:'40000000-0000-4000-8000-000000000001',expectedVersion:await version(),projectId:project.id,clientVisible:true,projectPreview:null});
  const projects=await new PostgresClientProjectPortal(db).projects(proposalOwner);
  expect(JSON.stringify(projects)).toContain('New client project');
 });
 it('lets a PM open an accepted account-linked proposal without exposing auth contact data',async()=>{
  const {receipt}=await submitProposal();
  const accepted=await app.accept(receipt.id,workspaceA,pmA,{schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000004'});
  const target={workspaceId:workspaceA,ticketId:accepted.ticketId};
  await db.query(`insert into alpha_private.ticket_messages
   (workspace_id,ticket_id,id,author_kind,author_id,audience,body,created_at)
   values($1,$2,'proposal-message','client',$3,'client','working?',now())`,[workspaceA,accepted.ticketId,proposalOwner.userId]);
  const reads=createTicketReadService(new PostgresTicketReadStore(db));
  await expect(reads.detail(target,pmA)).resolves.toMatchObject({
   internal:{request:{source:'authenticated_client',contact:null}},
  });
  await expect(reads.conversation(target,pmA,{})).resolves.toMatchObject({
   items:[{id:'proposal-message',author:'client',body:'working?'}],nextCursor:null,
  });
 });
 it('enables an existing disabled client grant when a PM accepts a proposal',async()=>{
  const {receipt}=await submitProposal();
  await db.query(`insert into alpha_private.ticket_service_grants
    (id,workspace_id,client_user_id,status,display_name,accepts_new_requests,write_mode)
    values('preexisting-grant',$1,$2,'active','Client portal',false,'disabled')`,[workspaceA,proposalOwner.userId]);
  const accepted=await app.accept(receipt.id,workspaceA,pmA,{schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000003'});
  expect(accepted.workspaceId).toBe(workspaceA);
  expect((await db.query(`select status,accepts_new_requests,write_mode,revoked_at
    from alpha_private.ticket_service_grants where workspace_id=$1 and client_user_id=$2`,[workspaceA,proposalOwner.userId])).rows)
    .toEqual([{status:'active',accepts_new_requests:false,write_mode:'enabled',revoked_at:null}]);
 });
 it.each(['suspended','revoked'])('does not revive a %s grant or partially create a ticket',async(status)=>{
  const {receipt}=await submitProposal();
  await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name)
   values('restricted',$1,$2,$3,'Client')`,[workspaceA,proposalOwner.userId,status]);
  await expect(app.accept(receipt.id,workspaceA,pmA,{schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000001'})).rejects.toMatchObject({status:409,code:'client_access_unavailable'});
  expect((await db.query('select * from alpha_private.tickets')).rows).toHaveLength(0);
  expect((await db.query('select status from alpha_private.ticket_service_grants')).rows).toEqual([{status}]);
 });
 it('declines without ticket, grants, or email and keeps the PM note internal',async()=>{
  const {proposals,receipt}=await submitProposal();
  await app.decline(receipt.id,workspaceA,pmA,{schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000001',reason:'PRIVATE_NOTE'});
  const result=await proposals.list(proposalOwner);
  expect(result.items[0].status).toBe('declined');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NOTE');
  for(const table of ['tickets','ticket_service_grants','ticket_client_grants','ticket_central_intake_outcomes','ticket_central_intake_acknowledgments'])
   expect((await db.query('select * from alpha_private.'+table)).rows).toHaveLength(0);
 });
 it('rejects unauthorized workspaces and unavailable writes before creating grants',async()=>{
  const {receipt}=await submitProposal();
  const command={schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000001'};
  await expect(app.accept(receipt.id,workspaceB,pmA,command)).rejects.toMatchObject({status:403});
  await db.query(`update public.workspaces set settings_json='{"ticketing_write_mode":"disabled"}' where id=$1`,[workspaceA]);
  await expect(app.accept(receipt.id,workspaceA,pmA,command)).rejects.toMatchObject({status:503});
  expect((await db.query('select * from alpha_private.ticket_service_grants')).rows).toHaveLength(0);
 });
});

it('serializes competing PM decisions and rolls back all acceptance writes on a grant failure',async()=>{
 const {receipt}=await submitProposal();
 const failingDb:TransactionalSql={...db,transaction:work=>db.transaction(tx=>work({...tx,query:async(text,values)=>{
   if(text.includes('insert into alpha_private.ticket_client_grants')) throw new Error('Injected grant failure');
   return tx.query(text,values);
 }}))};
 await expect(new PostgresTicketCentralIntakeStore(failingDb).accept({organizationKey,intakeId:receipt.id,
  workspaceId:workspaceA,subject:pmA,operationId:'20000000-0000-4000-8000-000000000001',ticketId:'failed-ticket',
  reference:'TKT-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',occurredAt:submittedAt.toISOString()})).rejects.toThrow('Injected grant failure');
 for(const table of ['tickets','ticket_contacts','ticket_service_grants','ticket_client_grants'])
  expect((await db.query('select * from alpha_private.'+table)).rows).toHaveLength(0);
 const results=await Promise.allSettled([
  app.accept(receipt.id,workspaceA,pmA,{schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000001'}),
  app.accept(receipt.id,workspaceB,pmB,{schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000002'}),
 ]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
 expect((await db.query('select * from alpha_private.tickets')).rows).toHaveLength(1);
 expect((await db.query('select * from alpha_private.ticket_client_grants')).rows).toHaveLength(1);
});
