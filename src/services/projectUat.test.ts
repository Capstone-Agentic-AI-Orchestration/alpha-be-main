import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import type { TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { PostgresClientProjectPortal } from './clientProjectPortal.js';
import { ProjectUat } from './projectUat.js';
import type { UatBuild } from '../ticketing/projectUat.js';
import { PostgresTicketReadStore } from '../store/ticketReadPostgresStore.js';
import { createTicketReadService } from './ticketReadService.js';

const target={workspaceId:'workspace-a',projectId:'project-a'};
const client:TicketSubject={kind:'client',userId:'client-a',sessionId:'a'.repeat(64)};
const other:TicketSubject={kind:'client',userId:'client-b',sessionId:'b'.repeat(64)};
const pm:TicketSubject={kind:'internal',userId:'pm',authentication:{kind:'verified_github_bearer',verificationId:'verified'}};
const initialBuild:UatBuild={frontend:{repository:'org/frontend',branch:'uat',deploymentId:'deployment-a',commitSha:'a'.repeat(40),url:'https://deployment-a.vercel.app'},
  backends:[],verifiedAt:'2026-10-28T10:00:00Z',embeddable:true,reason:null};
const check={title:'Checkout',steps:'Open the cart and check out.',expectedResult:'Order confirmation appears.',required:true};
let pg:PGlite,db:TransactionalSql,app:ProjectUat,portal:PostgresClientProjectPortal,build:UatBuild;
const resolve=vi.fn(async()=>build);
let operation=0;const op=()=>`operation-${++operation}`;
const blobs=new Map<string,Uint8Array>();
beforeAll(async()=>{pg=await createTestDatabase();db={...sqlFor(pg),transaction:work=>pg.transaction(tx=>work(sqlFor(tx as unknown as PGlite)))};portal=new PostgresClientProjectPortal(db);
  app=new ProjectUat(db,portal,{resolve,targets:async()=>[{repository:'org/frontend'}]},
    {put:async(path,bytes)=>{blobs.set(path,bytes.slice());},get:async path=>{const bytes=blobs.get(path);if(!bytes)throw new Error('Unavailable');return bytes;}});},60000);
afterAll(async()=>{await pg?.close();});
beforeEach(async()=>{
  build=structuredClone(initialBuild);resolve.mockClear();operation=0;blobs.clear();
  await pg.exec('truncate public.workspaces cascade; delete from alpha_private.ticket_client_sessions;');
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ('workspace-a','A','a','active','{"ticketing_write_mode":"enabled"}'),('workspace-b','B','b','active','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values('member','workspace-a','pm','pm'),('dev','workspace-a','developer','dev')`);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status) values('project-a','workspace-a','A','A','active'),
    ('project-b','workspace-a','B','B','active'),('project-x','workspace-b','X','X','active')`);
  for(const [user,session] of [['client-a','a'.repeat(64)],['client-b','b'.repeat(64)]]){
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,accepts_new_requests,write_mode)
      values($1,'workspace-a',$1,'active','Client',true,'enabled')`,[user]);
    await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
      values($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')`,[session,user,'c'.repeat(64)]);
    const state={...newTicketWorkflow(`ticket-${user}`,'workspace-a',user),projectId:'project-a'};
    await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
      workflow_state,client_user_id,project_id,project_display_name,project_client_visible)
      values($1,'workspace-a',$1,'Request','Description','Client','authenticated_client','received',0,$2,$3,'project-a','A',true)`,[state.id,JSON.stringify(state),user]);
    await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active) values('workspace-a',$1,$2,true)`,[state.id,user]);
  }
});
async function draft(clientId='client-a',items=[check]) {const receipt=await app.create(target,pm,{operationId:op(),clientId,repository:'org/frontend',title:'Review checkout',items});return receipt.roundId as string;}
async function command(id:string,action:'ready'|'publish'|'withdraw') {const row=await app.get(target,pm,id);return app.command(target,pm,id,{operationId:op(),expectedVersion:row.version,action});}
async function published(){const id=await draft();await command(id,'ready');await command(id,'publish');return id;}
async function save(id:string,status='passed',extra={}) {const row=await app.get(target,client,id);return app.result(target,client,id,row.items[0].id,
  {operationId:op(),expectedVersion:row.version,status,notes:'',reproduction:'',device:'Desktop',...extra});}

describe('project-scoped UAT against the complete migration schema',()=>{
  it('requires PM readiness for the exact build before handoff and hides configured previews and drafts',async()=>{
    await portal.setPreview(target,pm,{preview:{repository:'org/frontend',branch:'uat',url:'https://unsafe-config-only.vercel.app'}});
    expect((await portal.getPreview(target,pm)).preview?.url).toContain('unsafe-config-only');
    expect((await portal.projects(client)).items[0].preview).toBeNull();
    const id=await draft();expect((await app.list(target,client,{})).items).toEqual([]);
    await expect(app.get(target,client,id)).rejects.toMatchObject({status:404});
    await expect(command(id,'publish')).rejects.toMatchObject({code:'uat_pm_review_required'});
    await command(id,'ready');expect((await app.list(target,client,{})).items).toEqual([]);
    await command(id,'publish');const visible=await app.get(target,client,id);
    expect(visible.preview).toMatchObject({branch:'uat',url:build.frontend.url});
    expect(visible).not.toHaveProperty('build');expect(visible).not.toHaveProperty('clientId');expect(visible).not.toHaveProperty('reviewedBy');
    expect((await portal.projects(client)).items[0].preview?.url).toBe(build.frontend.url);
    const ticket=await createTicketReadService(new PostgresTicketReadStore(db)).detail({workspaceId:'workspace-a',ticketId:'ticket-client-a'},client);
    expect(ticket.sharedProjectPreviewUrl).toBe(build.frontend.url);
  });
  it('keeps all data and receipts in the exact project, workspace and recipient',async()=>{
    const id=await published();
    expect((await app.list(target,other,{})).items).toEqual([]);
    await expect(app.get(target,other,id)).rejects.toMatchObject({status:404});
    await expect(app.get({...target,projectId:'project-b'},client,id)).rejects.toMatchObject({status:404});
    await expect(app.get({workspaceId:'workspace-b',projectId:'project-x'},pm,id)).rejects.toMatchObject({status:404});
    const receipt=await save(id);
    await expect(app.operation(target,other,receipt.operationId)).rejects.toMatchObject({status:404});
    await expect(app.operation({...target,projectId:'project-b'},client,receipt.operationId)).rejects.toMatchObject({status:404});
    await expect(app.get(target,{...pm,userId:'developer'},id)).rejects.toMatchObject({status:404});
  });
  it('does not expose withdrawn internal drafts',async()=>{
    const id=await draft();await command(id,'withdraw');
    expect((await app.list(target,client,{})).items).toEqual([]);
    await expect(app.get(target,client,id)).rejects.toMatchObject({status:404});
  });
  it('validates required results, finalizes findings and leaves delivery/work authorization untouched',async()=>{
    const id=await published();let row=await app.get(target,client,id);
    await expect(app.submit(target,client,id,{operationId:op(),expectedVersion:row.version})).rejects.toMatchObject({code:'uat_incomplete'});
    await expect(save(id,'failed')).rejects.toMatchObject({status:400});
    await save(id,'failed',{notes:'The payment button does not work.',reproduction:'Open checkout; click Pay.'});
    row=await app.get(target,client,id);
    const receipt=await app.submit(target,client,id,{operationId:op(),expectedVersion:row.version});
    expect(receipt.outcome).toBe('changes_requested');
    await expect(save(id)).rejects.toMatchObject({code:'uat_round_locked'});
    await expect(app.result(target,pm,id,row.items[0].id,{operationId:op(),expectedVersion:row.version,status:'passed',notes:'',reproduction:'',device:''})).rejects.toMatchObject({status:404});
    const state=await db.query<{workflow_state:any;status:string}>('select workflow_state,status from alpha_private.tickets where id=$1',['ticket-client-a']);
    expect(state.rows[0].status).toBe('received');expect(state.rows[0].workflow_state.delivery).toBeNull();
    expect((await app.get(target,client,id)).items[0].result.notes).toContain('payment button');
  });
  it('blocks handoff and saves after frontend or API drift, while old receipts remain reconcilable',async()=>{
    const id=await draft();await command(id,'ready');build.frontend={...build.frontend,deploymentId:'new',commitSha:'b'.repeat(40)};
    await expect(command(id,'publish')).rejects.toMatchObject({code:'uat_build_changed'});
    build=structuredClone(initialBuild);await command(id,'publish');
    const row=await app.get(target,client,id),input={operationId:op(),expectedVersion:row.version,status:'passed',notes:'',reproduction:'',device:''};
    const receipt=await app.result(target,client,id,row.items[0].id,input);
    build.backends=[{repository:'org/backend',branch:'uat',deploymentId:'api-new',commitSha:'c'.repeat(40),url:'https://api.onrender.com'}];
    expect(await app.result(target,client,id,row.items[0].id,input)).toEqual(receipt);
    await expect(save(id)).rejects.toMatchObject({code:'uat_build_changed'});
  });
  it('rechecks revoked/expired/relinked access on history, lookup and writes',async()=>{
    const id=await published(),receipt=await save(id);
    await db.query(`update alpha_private.ticket_client_grants set revoked_at=now() where client_user_id='client-a'`);
    for(const call of [()=>app.get(target,client,id),()=>app.operation(target,client,receipt.operationId),()=>app.list(target,client,{})])await expect(call()).rejects.toMatchObject({status:404});
    await db.query(`update alpha_private.ticket_client_grants set revoked_at=null where client_user_id='client-a'`);
    await db.query(`update alpha_private.ticket_client_sessions set expires_at=now()-interval '1 second' where client_user_id='client-a'`);
    await expect(app.get(target,client,id)).rejects.toMatchObject({status:404});
  });
  it('serializes version checks and safely replays exactly the same operation',async()=>{
    const id=await published(),row=await app.get(target,client,id);
    const input={operationId:op(),expectedVersion:row.version,status:'passed',notes:'',reproduction:'',device:''};
    const first=await app.result(target,client,id,row.items[0].id,input);
    expect(await app.result(target,client,id,row.items[0].id,input)).toEqual(first);
    await expect(app.result(target,client,id,row.items[0].id,{...input,notes:'different'})).rejects.toMatchObject({code:'uat_operation_conflict'});
    await expect(app.result(target,client,id,row.items[0].id,{...input,operationId:op()})).rejects.toMatchObject({code:'uat_version_conflict'});
    const events=await db.query<{count:string}>('select count(*) from alpha_private.client_uat_events where action=$1',['result_saved']);expect(Number(events.rows[0].count)).toBe(1);
  });
  it('preserves failed rounds during retest and never supersedes another client',async()=>{
    const id=await published();await save(id,'blocked',{notes:'No test login was supplied.'});
    const otherId=await draft('client-b');await command(otherId,'ready');await command(otherId,'publish');
    const newId=await draft();await command(newId,'ready');await command(newId,'publish');
    expect((await app.get(target,client,id)).status).toBe('superseded');
    expect((await app.get(target,client,id)).items[0].result.status).toBe('blocked');
    expect((await app.get(target,other,otherId)).status).toBe('published');
    expect((await app.get(target,client,newId)).items[0].result.status).toBe('not_tested');
  });
  it('honors read-only workspace and client write modes',async()=>{
    const id=await published();await db.query(`update alpha_private.ticket_service_grants set write_mode='disabled' where client_user_id='client-a'`);
    await expect(save(id)).rejects.toMatchObject({status:503});expect((await app.get(target,client,id)).status).toBe('published');
    await db.query(`update public.workspaces set settings_json='{"ticketing_write_mode":"disabled"}' where id='workspace-a'`);
    await expect(command(id,'withdraw')).rejects.toMatchObject({status:503});
  });
  it('keeps screenshot objects private, verifies content and isolates downloads/retries',async()=>{
    const id=await published(),row=await app.get(target,client,id),item=row.items[0].id;
    const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const input={operationId:op(),filename:'screenshot.png',contentType:'image/png'};
    const receipt=await app.uploadEvidence(target,client,id,item,input,png);
    expect(await app.uploadEvidence(target,client,id,item,input,png)).toEqual(receipt);
    const result=await app.get(target,client,id);expect(result.evidence).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('storage_path');expect(JSON.stringify(result)).not.toContain('uat-');
    const evidenceId=result.evidence[0].id;
    expect((await app.downloadEvidence(target,pm,id,evidenceId)).bytes).toEqual(png);
    await expect(app.downloadEvidence(target,other,id,evidenceId)).rejects.toMatchObject({status:404});
    await expect(app.uploadEvidence(target,client,id,item,{...input,operationId:op(),filename:'evil.svg'},png)).rejects.toMatchObject({status:400});
    await expect(app.uploadEvidence(target,client,id,item,{...input,filename:'different.png'},png)).rejects.toMatchObject({code:'uat_operation_conflict'});
    const path=[...blobs.keys()][0];blobs.set(path,Uint8Array.from([1]));
    await expect(app.downloadEvidence(target,client,id,evidenceId)).rejects.toMatchObject({status:503});
    await db.query(`update alpha_private.ticket_service_grants set revoked_at=now() where client_user_id='client-a'`);
    await expect(app.downloadEvidence(target,client,id,evidenceId)).rejects.toMatchObject({status:404});
  });
  it('records PM triage without leaking internal notes or accepting a foreign project issue',async()=>{
    const id=await published();await save(id,'failed',{notes:'Wrong total',reproduction:'Add two items.'});
    const row=await app.get(target,client,id),item=row.items[0].id;
    await db.query(`insert into public.issues(id,workspace_id,identifier,title,status,priority,project_id) values
      ('issue-a','workspace-a','A-1','Fix checkout','todo','high','project-a'),('issue-b','workspace-a','B-1','Other project','todo','high','project-b')`);
    const input={operationId:op(),expectedVersion:row.version,classification:'correction',note:'Private PM diagnosis',issueId:'issue-b'};
    await expect(app.triage(target,pm,id,item,input)).rejects.toMatchObject({status:404});
    await app.triage(target,pm,id,item,{...input,issueId:'issue-a'});
    const pmView=await app.get(target,pm,id);expect(pmView.triage?.[0]).toMatchObject({note:'Private PM diagnosis',issueId:'issue-a'});
    expect(JSON.stringify(await app.get(target,client,id))).not.toContain('Private PM diagnosis');
    expect((await app.get(target,client,id)).items[0].result.status).toBe('failed');
  });
  it('keeps QA tables unreadable to browser database roles',async()=>{
    for(const name of ['client_uat_rounds','client_uat_items','client_uat_results','client_uat_events','client_uat_evidence']){
      const result=await db.query<{allowed:boolean}>(`select has_table_privilege('authenticated',$1,'SELECT') as allowed`,[`alpha_private.${name}`]);
      expect(result.rows[0].allowed).toBe(false);
    }
  });
  it('allows draft edits, clears readiness and freezes definitions after publication',async()=>{
    const id=await draft();await command(id,'ready');let row=await app.get(target,pm,id);
    await app.edit(target,pm,id,{operationId:op(),expectedVersion:row.version,title:'Updated review',items:[{...check,title:'Updated check'}]});
    row=await app.get(target,pm,id);expect(row.reviewed).toBe(false);expect(row.items[0].title).toBe('Updated check');
    await expect(command(id,'publish')).rejects.toMatchObject({code:'uat_pm_review_required'});
    await command(id,'ready');await command(id,'publish');row=await app.get(target,pm,id);
    await expect(app.edit(target,pm,id,{operationId:op(),expectedVersion:row.version,title:'Overwrite',items:[check]})).rejects.toMatchObject({code:'uat_round_locked'});
  });
});
