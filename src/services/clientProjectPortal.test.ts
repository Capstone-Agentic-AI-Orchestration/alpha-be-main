import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import type { TransactionalSql } from '../store/database.js';
import { DatabaseCommitError } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { PostgresClientProjectPortal } from './clientProjectPortal.js';
import { PostgresTicketClientIntakeContextStore } from '../store/ticketClientIntakeContextPostgresStore.js';
import { createTicketClientIntakeContextService } from './ticketClientIntakeContextService.js';
import { createTicketCreationService } from './ticketCreationService.js';
import { PostgresTicketCreationStore } from '../store/ticketCreationPostgresStore.js';
import { createTicketProjectManagementService } from './ticketProjectManagementService.js';
import { PostgresTicketProjectManagementStore } from '../store/ticketProjectManagementPostgresStore.js';

const client: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'a'.repeat(64) };
const other: TicketSubject = { kind: 'client', userId: 'client-b', sessionId: 'b'.repeat(64) };
const pm: TicketSubject = { kind: 'internal', userId: 'pm', authentication: { kind: 'verified_github_bearer', verificationId: 'verified' } };
const target = { workspaceId: 'workspace-a', projectId: 'project-a' };
const preview = { repository: 'org/repo', branch: 'uat' as const, url: 'https://demo.vercel.app/path' };
const message = { schemaVersion: 1, operationId: 'operation-a', body: 'Please adjust the heading.' };
let pg: PGlite;
let db: TransactionalSql;
let app: PostgresClientProjectPortal;

beforeAll(async () => {
  pg = await createTestDatabase();
  db = { ...sqlFor(pg), transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  app = new PostgresClientProjectPortal(db);
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec('truncate public.workspaces cascade');
  // Sessions do not belong to a workspace.
  await pg.exec('delete from alpha_private.ticket_client_sessions');
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ('workspace-a','A','a','active','{"ticketing_write_mode":"enabled"}'),
    ('workspace-b','B','b','active','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values ('member','workspace-a','pm','pm')`);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status) values
    ('project-a','workspace-a','Project A','A','active'),('project-b','workspace-b','Project B','B','active'),
    ('preference-only','workspace-a','Not shared','C','active')`);
  for (const [user, session] of [['client-a','a'.repeat(64)],['client-b','b'.repeat(64)]]) {
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,accepts_new_requests,write_mode)
      values ($1,'workspace-a',$2,'active','Client',true,'enabled')`, [user,user]);
    await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
      values ($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')`, [session,user,'c'.repeat(64)]);
    const state = { ...newTicketWorkflow('ticket-'+user,'workspace-a',user), projectId: 'project-a' };
    await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
      workflow_state,client_user_id,project_id,project_display_name,project_client_visible,created_at,client_updated_at,internal_updated_at)
      values ($1,'workspace-a',$1,'Original request','Description','Client','authenticated_client','received',0,$2,$3,'project-a','Project A',true,
      now()-interval '1 day',now()-interval '1 day',now()-interval '1 day')`, [state.id,JSON.stringify(state),user]);
    await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active)
      values ('workspace-a',$1,$2,true)`, [state.id,user]);
  }
});

describe('client project portal on the complete migration schema', () => {
  it('returns only actual visible projects and the exact existing intake option ID', async () => {
    const result = await app.projects(client);
    const context = await createTicketClientIntakeContextService(new PostgresTicketClientIntakeContextStore(db)).get('workspace-a',client);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ ...target, name: 'Project A', preview: null, intakeOptionId: context.sharedProjects[0].optionId });
    expect(JSON.stringify(result)).not.toContain('preference-only');
    await db.query(`update alpha_private.tickets set project_client_visible=false where client_user_id='client-a'`);
    expect((await app.projects(client)).items).toEqual([]);
    await expect(app.messages(target,client,{})).rejects.toMatchObject({ status: 404 });
  });

  it('keeps pending project preferences visible without granting access or changing actual project links', async () => {
    const context = await createTicketClientIntakeContextService(new PostgresTicketClientIntakeContextStore(db)).get('workspace-a',client);
    const creation = createTicketCreationService(new PostgresTicketCreationStore(db));
    const created = await creation.create(context.intakeContextId,client,{ schemaVersion:1,operationId:'create',title:'Additional work',description:'Details',
      projectPreference:{ kind:'shared_project',optionId:context.sharedProjects[0].optionId } });
    const result = await app.requests(client,{},target);
    expect(result.items.find(t => t.id === created.ticketId)).toMatchObject({ workspaceId:'workspace-a',status:'received',
      projectId:null,projectName:null,requestedProjectName:'Project A',projectLinkStatus:'pending_review' });
    expect((await app.requests(client,{})).items).toHaveLength(2);
    await db.query(`update alpha_private.ticket_client_grants set active=false where ticket_id='ticket-client-a'`);
    await expect(app.requests(client,{},target)).rejects.toMatchObject({status:404});
    expect((await app.requests(client,{})).items.find(t=>t.id===created.ticketId)).toMatchObject({projectId:null,requestedProjectName:null,projectLinkStatus:'pending_review'});
    await db.query(`update alpha_private.ticket_client_grants set active=true where ticket_id='ticket-client-a'`);
    const link = createTicketProjectManagementService(new PostgresTicketProjectManagementStore(db));
    await link.linkProject({workspaceId:'workspace-a',ticketId:created.ticketId},pm,
      {schemaVersion:1,operationId:'link',expectedVersion:0,projectId:'project-a',clientVisible:true});
    expect((await app.requests(client,{},target)).items.find(t => t.id === created.ticketId)).toMatchObject({
      projectId:'project-a',projectName:'Project A',requestedProjectName:null,projectLinkStatus:'linked' });
    await db.query(`update alpha_private.tickets set project_client_visible=false where client_user_id='client-a'`);
    await expect(app.requests(client,{},target)).rejects.toMatchObject({status:404});
    const global = await app.requests(client,{});
    expect(global.items).toHaveLength(2);
    expect(global.items.every(t => t.projectId===null && t.projectName===null)).toBe(true);
  });

  it('requires current session, service and ticket grants, including revoked_at', async () => {
    await expect(app.projects({...client,sessionId:'e'.repeat(64)} as TicketSubject)).rejects.toMatchObject({status:404});
    await db.query(`update alpha_private.ticket_client_grants set revoked_at=now() where client_user_id='client-a'`);
    expect((await app.projects(client)).items).toEqual([]);
    expect((await app.requests(client,{})).items).toEqual([]);
    await expect(app.reply(target,client,message)).rejects.toMatchObject({status:404});
    await db.query(`update alpha_private.ticket_service_grants set revoked_at=now() where client_user_id='client-b'`);
    expect((await app.projects(other)).items).toEqual([]);
  });

  it('isolates threads by client and actor, supports replay/lookup and rejects changed-body reuse', async () => {
    const receipt = await app.reply(target,client,message);
    expect(await app.reply(target,client,message)).toEqual(receipt);
    expect(await app.operation(target,client,message.operationId)).toEqual(receipt);
    await expect(app.reply(target,client,{...message,body:'Different'})).rejects.toMatchObject({status:409});
    expect((await app.messages(target,other,{})).items).toEqual([]);
    await expect(app.operation(target,other,message.operationId)).rejects.toMatchObject({status:404});
    const ownOther = await app.reply(target,other,{...message,body:'Other client'});
    expect(ownOther.messageId).not.toBe(receipt.messageId);
    await expect(app.messages(target,pm,{})).rejects.toMatchObject({code:'project_thread_client_required'});
    await app.reply(target,pm,{...message,body:'PM response'},'client-a');
    expect((await app.messages(target,client,{})).items.map(m=>m.author)).toEqual(['client','pm']);
    expect((await app.messages(target,pm,{},'client-b')).items.map(m=>m.body)).toEqual(['Other client']);
    expect((await app.messages(target,pm,{},'client-a')).items.every(m=>m.clientId==='client-a')).toBe(true);
    expect((await app.messages(target,client,{})).items.every(m=>!('clientId' in m))).toBe(true);
    await expect(app.operation(target,pm,'absent','client-a')).rejects.toMatchObject({status:404});
    const ticketMessages = await db.query(`select * from alpha_private.ticket_messages`);
    expect(ticketMessages.rows).toHaveLength(0);
  });

  it('validates PM membership, selected workspace and preview URL constraints', async () => {
    await expect(app.getPreview({...target,workspaceId:'workspace-b'},pm)).rejects.toMatchObject({status:404});
    await expect(app.getPreview({...target,projectId:'project-b'},pm)).rejects.toMatchObject({status:404});
    await expect(app.getPreview(target,{...pm,userId:'outsider'})).rejects.toMatchObject({status:404});
    await expect(app.getPreview(target,client)).rejects.toMatchObject({status:404});
    expect(await app.getPreview(target,pm)).toEqual({preview:null});
    await expect(app.setPreview({...target,workspaceId:'workspace-b'},pm,{preview})).rejects.toMatchObject({status:404});
    await expect(app.setPreview({...target,projectId:'project-b'},pm,{preview})).rejects.toMatchObject({status:404});
    await expect(app.setPreview(target,{...pm,userId:'outsider'}, {preview})).rejects.toMatchObject({status:404});
    for (const url of ['http://demo.vercel.app','https://vercel.app','https://demo.vercel.app.evil.test','https://u:p@demo.vercel.app','https://demo.vercel.app:444']) {
      await expect(app.setPreview(target,pm,{preview:{...preview,url}})).rejects.toMatchObject({status:400});
    }
    await expect(app.setPreview(target,pm,{preview:{...preview,branch:'dev'}})).rejects.toMatchObject({status:400});
    await expect(app.setPreview(target,pm,{preview:{...preview,branch:'main'}})).rejects.toMatchObject({status:400});
    expect(await app.setPreview(target,pm,{preview})).toEqual({preview});
    // Configuration stays internal until a PM-reviewed UAT round is published.
    expect((await app.getPreview(target,pm)).preview).toEqual(preview);
    expect((await app.projects(client)).items[0].preview).toBeNull();
    await app.setPreview(target,pm,{preview:null});
    expect(await app.getPreview(target,pm)).toEqual({preview:null});
    expect((await app.projects(client)).items[0].preview).toBeNull();
  });

  it('paginates messages chronologically and denies foreign cursors and malformed writes', async () => {
    await app.reply(target,client,message);
    await app.reply(target,client,{...message,operationId:'second',body:'Second'});
    const first = await app.messages(target,client,{limit:'1'});
    expect(first.items).toHaveLength(1);
    expect(first.items[0].body).toBe('Second');
    expect(first.nextCursor).toBe(first.items[0].id);
    const earlier = await app.messages(target,client,{limit:1,before:first.nextCursor});
    expect(earlier.items[0].body).toBe('Please adjust the heading.');
    await expect(app.messages(target,other,{before:first.nextCursor})).rejects.toMatchObject({status:404});
    for (const input of [{...message,body:' '},{...message,schemaVersion:2},{...message,body:'x'.repeat(4001)},{...message,clientId:'client-b'}]) {
      await expect(app.reply(target,client,input)).rejects.toMatchObject({status:400});
    }
    await expect(app.messages(target,client,{limit:101})).rejects.toMatchObject({status:400});
  });

  it('uses real queue fields, filters, search, cursors and workspace IDs', async () => {
    const context = await createTicketClientIntakeContextService(new PostgresTicketClientIntakeContextStore(db)).get('workspace-a',client);
    await createTicketCreationService(new PostgresTicketCreationStore(db)).create(context.intakeContextId,client,
      {schemaVersion:1,operationId:'create',title:'Search needle',description:'Details'});
    const first = await app.requests(client,{limit:1});
    expect(first.items[0]).toMatchObject({workspaceId:'workspace-a',title:'Search needle',status:'received',readOnly:false,writesAvailable:true});
    expect(first.counters).toEqual({kind:'client',open:2,needsClient:0});
    const second = await app.requests(client,{limit:1,after:first.nextCursor});
    expect(second.items[0].id).toBe('ticket-client-a');
    expect((await app.requests(client,{search:'needle'})).items).toHaveLength(1);
    expect((await app.requests(client,{filter:'history'})).items).toHaveLength(0);
    expect((await app.requests(client,{filter:'needs_client'})).items).toHaveLength(0);
    await expect(app.requests(client,{after:'ticket-client-b'})).rejects.toMatchObject({status:404});
    await expect(app.requests(client,{filter:'needs_pm'})).rejects.toMatchObject({status:400});
  });

  it('does not let preference-only rows grant project access and honors write modes', async () => {
    await db.query(`insert into alpha_private.ticket_requests(workspace_id,ticket_id,source,project_preference,preferred_project_id,requested_project_label)
      values ('workspace-a','ticket-client-a','authenticated_client','shared_project','preference-only','Not shared')`);
    await expect(app.messages({workspaceId:'workspace-a',projectId:'preference-only'},client,{})).rejects.toMatchObject({status:404});
    expect((await app.projects(client)).items.map(p=>p.projectId)).toEqual(['project-a']);
    const sent = await app.reply(target,client,message);
    await db.query(`update public.workspaces set settings_json='{"ticketing_write_mode":"disabled"}' where id='workspace-a'`);
    await expect(app.reply(target,client,{...message,operationId:'new'})).rejects.toMatchObject({status:503});
    expect(await app.operation(target,client,message.operationId)).toEqual(sent);
    expect((await app.messages(target,client,{})).items).toHaveLength(1);
    await expect(app.setPreview(target,pm,{preview})).rejects.toMatchObject({status:503});
  });

  it('keeps new private tables inaccessible to browser database roles', async () => {
    const {rows} = await db.query<{relname:string;relrowsecurity:boolean}>(`select relname,relrowsecurity from pg_class
      where oid in ('alpha_private.client_project_previews'::regclass,'alpha_private.client_project_messages'::regclass)`);
    expect(rows).toHaveLength(2);
    expect(rows.every(r=>r.relrowsecurity)).toBe(true);
    for (const role of ['anon','authenticated']) {
      for (const table of ['client_project_messages','client_project_previews']) {
        const {rows:privileges}=await db.query<{allowed:boolean}>(`select has_table_privilege($1,$2,'select,insert,update,delete') as allowed`,[role,'alpha_private.'+table]);
        expect(privileges[0].allowed).toBe(false);
      }
    }
  });

  it('paginates duplicate ticket IDs across workspaces without skipping or exposing other clients', async () => {
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,accepts_new_requests,write_mode)
      values ('grant-b','workspace-b','client-a','active','Client',true,'enabled')`);
    const state={...newTicketWorkflow('ticket-client-a','workspace-b','client-a'),projectId:'project-b'};
    await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
      workflow_state,client_user_id,project_id,project_display_name,project_client_visible,created_at,client_updated_at,internal_updated_at)
      values ('ticket-client-a','workspace-b','SECOND','Second workspace','Details','Client','authenticated_client','received',0,
      $1,'client-a','project-b','Project B',true,now()-interval '1 day',now()-interval '1 day',now()-interval '1 day')`,[JSON.stringify(state)]);
    await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active)
      values ('workspace-b','ticket-client-a','client-a',true)`);
    await db.query(`update alpha_private.tickets set created_at='2026-01-01',client_updated_at='2026-01-01',internal_updated_at='2026-01-01'`);
    const first=await app.requests(client,{limit:1});
    const second=await app.requests(client,{limit:1,after:first.nextCursor});
    expect(first.items[0]).toMatchObject({workspaceId:'workspace-b',id:'ticket-client-a'});
    expect(second.items[0]).toMatchObject({workspaceId:'workspace-a',id:'ticket-client-a'});
    expect(second.nextCursor).toBeNull();
    expect(first.counters.open).toBe(2);
    expect((await app.projects(client)).items).toHaveLength(2);
    await expect(app.requests(other,{after:first.nextCursor})).rejects.toMatchObject({status:404});
  });

  it('reconciles a committed message after a lost COMMIT acknowledgement without duplication', async () => {
    const uncertain=new PostgresClientProjectPortal({...db,transaction:async work=>{
      await db.transaction(work);throw new DatabaseCommitError(new Error('Simulated lost acknowledgement'));
    }});
    await expect(uncertain.reply(target,client,message)).rejects.toBeInstanceOf(DatabaseCommitError);
    const recovered=await app.operation(target,client,message.operationId);
    expect(await app.reply(target,client,message)).toEqual(recovered);
    expect((await app.messages(target,client,{})).items).toHaveLength(1);
  });

  it('enforces composite project ownership and client authors in the schema', async () => {
    await expect(db.query(`insert into alpha_private.client_project_previews(workspace_id,project_id,updated_by)
      values ('workspace-a','project-b','pm')`)).rejects.toMatchObject({sqlState:'23503'});
    await expect(db.query(`insert into alpha_private.client_project_messages(workspace_id,project_id,client_user_id,id,author_kind,author_id,operation_id,body)
      values ('workspace-a','project-a','client-a','bad','client','client-b','bad','Body')`)).rejects.toMatchObject({sqlState:'23514'});
  });

  it('lists only currently eligible project clients for an authorized workspace PM', async () => {
    expect(await app.clients(target,pm)).toEqual({items:[{clientId:'client-a',displayName:'Client'},{clientId:'client-b',displayName:'Client'}]});
    await expect(app.clients(target,client)).rejects.toMatchObject({status:404});
    await expect(app.clients({...target,projectId:'project-b'},pm)).rejects.toMatchObject({status:404});
    await expect(app.clients(target,{...pm,userId:'outsider'})).rejects.toMatchObject({status:404});
    await db.query(`update alpha_private.ticket_client_grants set revoked_at=now() where client_user_id='client-b'`);
    expect((await app.clients(target,pm)).items.map(c=>c.clientId)).toEqual(['client-a']);
    await db.query(`update alpha_private.tickets set project_client_visible=false where client_user_id='client-a'`);
    expect((await app.clients(target,pm)).items).toEqual([]);
    await expect(app.messages(target,pm,{},'client-a')).rejects.toMatchObject({status:404});
  });
});
