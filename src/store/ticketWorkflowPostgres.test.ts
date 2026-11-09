import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { PostgresTicketWorkflowStore } from './ticketWorkflowPostgresStore.js';
import { createTicketScopeService } from '../services/ticketScopeService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createTicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';

const target={workspaceId:'workflow-w',ticketId:'workflow-t'};
const pm: TicketSubject={kind:'internal',userId:'workflow-pm',authentication:{kind:'verified_github_bearer',verificationId:'verified-pm'}};
const client: TicketSubject={kind:'client',userId:'workflow-client',sessionId:createHash('sha256').update('workflow-session').digest('hex')};
let pg:PGlite;
let db:TransactionalSql;
let store:PostgresTicketWorkflowStore;
beforeEach(async()=>{
  pg=await createTestDatabase();
  db={...sqlFor(pg),transaction:work=>pg.transaction(tx=>work(sqlFor(tx as unknown as PGlite)))};
  store=new PostgresTicketWorkflowStore(db);
  await db.query(`insert into workspaces(id,name,slug,settings_json) values('workflow-w','Workflow','workflow-w','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into workspace_members(id,workspace_id,user_id,role) values
    ('workflow-pm-member','workflow-w','workflow-pm','pm'),('workflow-dev-member','workflow-w','workflow-dev','dev')`);
  await db.query(`insert into projects(id,workspace_id,name,key,status,created_by) values('workflow-p','workflow-w','Project','WF','in_progress','workflow-pm')`);
  await db.query(`insert into issues(id,workspace_id,project_id,identifier,title,status,priority) values
    ('workflow-i','workflow-w','workflow-p','WF-1','Unassigned Issue','todo','medium'),
    ('workflow-i2','workflow-w','workflow-p','WF-2','Another Issue','todo','medium')`);
  await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,write_mode)
    values('workflow-service','workflow-w','workflow-client','active','Client','disabled')`);
  await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
    values($1,'workflow-client',$2,now()-interval '1 minute',now()+interval '1 hour')`,[client.sessionId,'a'.repeat(64)]);
  const state=newTicketWorkflow(target.ticketId,target.workspaceId,client.userId);
  await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,workflow_state,client_user_id)
    values('workflow-t','workflow-w','TKT-WF','Request','Public request','Client','authenticated_client','received',0,$1::jsonb,'workflow-client')`,[JSON.stringify(state)]);
  await db.query(`insert into alpha_private.ticket_requests(workspace_id,ticket_id,source,project_preference) values('workflow-w','workflow-t','authenticated_client','not_sure')`);
  await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active) values('workflow-w','workflow-t','workflow-client',true)`);
},60000);
afterEach(async()=>{await pg?.close();});
async function agreed(){
  const commands=createTicketCommandService(store);
  await commands.execute(target,pm,{schemaVersion:1,operationId:'review',expectedVersion:0,command:{type:'review'}});
  const scope=await createTicketScopeService(store).propose(target,pm,{schemaVersion:1,operationId:'scope',expectedVersion:1,publicSummary:'Agreed client scope',developerBrief:'PRIVATE developer brief'});
  await commands.execute(target,client,{schemaVersion:1,operationId:'agree',expectedVersion:2,command:{type:'agree_scope',scopeVersionId:scope.scopeVersionId}});
  return {commands,scope};
}
async function authorizeIssue(){
  const {commands,scope}=await agreed();
  await commands.execute(target,pm,{schemaVersion:1,operationId:'authorize',expectedVersion:3,
    command:{type:'authorize_work',scopeVersionId:scope.scopeVersionId,projectId:'workflow-p',issueIds:['workflow-i']}});
}
async function insertRun(id:string,status:string,squadRunId:string|null=null){
  await db.query(`insert into public.prototype_runs(id,workspace_id,owner_id,issue_id,project_id,agent_id,status,squad_run_id)
    values($1,'workflow-w','workflow-dev','workflow-i','workflow-p','workflow-agent',$2,$3)`,[id,status,squadRunId]);
}
describe('durable ticket lifecycle',()=>{
  it('proposes scope, records agreement, and atomically links unassigned project Issues',async()=>{
    const {commands,scope}=await agreed();
    const input={schemaVersion:1,operationId:'authorize',expectedVersion:3,command:{type:'authorize_work',scopeVersionId:scope.scopeVersionId,projectId:'workflow-p',issueIds:['workflow-i']}};
    const receipt=await commands.execute(target,pm,input);
    expect(receipt).toMatchObject({version:4,status:'in_progress'});
    expect(await commands.execute(target,pm,input)).toEqual(receipt);
    expect((await db.query(`select * from alpha_private.ticket_work_bindings`)).rows).toHaveLength(1);
    const issue=(await db.query<{assigned_human:string|null;status:string}>(`select assigned_human,status from issues where id='workflow-i'`)).rows[0];
    expect(issue).toEqual({assigned_human:null,status:'todo'});
    const detail=await createTicketReadService(new PostgresTicketReadStore(db)).detail(target,client);
    const projection=JSON.stringify(detail);
    expect(projection).toContain('Agreed client scope');
    expect(projection).not.toContain('PRIVATE');
    expect(projection).not.toContain('workflow-i');
    expect(projection).not.toContain('workflow-pm');
  });
  it('rolls back an incomplete manifest and rejects stale decisions',async()=>{
    const {commands,scope}=await agreed();
    await expect(commands.execute(target,pm,{schemaVersion:1,operationId:'bad-manifest',expectedVersion:3,
      command:{type:'authorize_work',scopeVersionId:scope.scopeVersionId,projectId:'workflow-p',issueIds:['workflow-i','missing']}})).rejects.toMatchObject({status:409});
    expect((await db.query(`select * from alpha_private.ticket_work_bindings`)).rows).toHaveLength(0);
    expect((await db.query<{version:number}>(`select version from alpha_private.tickets where id='workflow-t'`)).rows[0].version).toBe(3);
    await expect(commands.execute(target,pm,{schemaVersion:1,operationId:'stale',expectedVersion:0,command:{type:'hold',reason:'Wait'}})).rejects.toMatchObject({status:409});
  });
  it('keeps client workflow usable when new-ticket writes are disabled and denies revoked grants',async()=>{
    await agreed();
    await db.query(`update alpha_private.ticket_client_grants set active=false where ticket_id='workflow-t'`);
    await expect(createTicketCommandService(store).lookup(target,client,'agree')).rejects.toMatchObject({status:404});
  });
  it('keeps every new authority table private with row security enabled',async()=>{
    const {rows}=await db.query<{relname:string;relrowsecurity:boolean}>(`select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='alpha_private' and relname in ('ticket_scope_operations','ticket_work_bindings','ticket_issue_revisions','ticket_issue_reviews',
        'ticket_execution_claims','ticket_execution_operations','ticket_execution_dispatches','ticket_ready_manifests','ticket_delivery_registrations','ticket_result_objects')`);
    expect(rows).toHaveLength(10);
    expect(rows.every(row=>row.relrowsecurity)).toBe(true);
    await db.query('set role authenticated');
    await expect(db.query(`select * from alpha_private.ticket_result_objects`)).rejects.toBeDefined();
    await db.query('reset role');
  });
  it('records an approved internal review and a durable readiness receipt',async()=>{
    await authorizeIssue();
    await db.query(`update public.issues set status='review' where workspace_id='workflow-w' and id='workflow-i'`);
    await insertRun('workflow-run','completed');
    const lifecycle=createTicketLifecycleRuntime(db,true);

    await expect(lifecycle.completeReviewedIssue({workspaceId:'workflow-w',issueId:'workflow-i'},pm,'workflow-run'))
      .resolves.toMatchObject({kind:'ticket',ready:true});
    const issue=(await db.query<{status:string}>(`select status from public.issues where id='workflow-i'`)).rows[0];
    const review=(await db.query<{verdict:string;run_id:string}>(`select verdict,run_id from alpha_private.ticket_issue_reviews where workspace_id='workflow-w' and issue_id='workflow-i'`)).rows[0];
    const manifest=(await db.query(`select * from alpha_private.ticket_ready_manifests where workspace_id='workflow-w' and ticket_id='workflow-t'`)).rows;
    expect(issue.status).toBe('done');
    expect(review).toEqual({verdict:'passed',run_id:'workflow-run'});
    expect(manifest).toHaveLength(1);
    await expect(lifecycle.completeReviewedIssue({workspaceId:'workflow-w',issueId:'workflow-i'},pm,'workflow-run'))
      .resolves.toMatchObject({kind:'ticket',ready:true});
    expect((await db.query(`select * from alpha_private.ticket_ready_manifests where workspace_id='workflow-w' and ticket_id='workflow-t'`)).rows).toHaveLength(1);
  });
  it('stops a rejected run claim and records the run decision atomically',async()=>{
    await authorizeIssue();
    await insertRun('workflow-rejected-run','awaiting_approval');
    const {rows:bindings}=await db.query<{scope_version_id:string;current_revision_id:string;project_id:string;ticket_id:string}>(
      `select scope_version_id,current_revision_id,project_id,ticket_id from alpha_private.ticket_work_bindings where workspace_id='workflow-w' and issue_id='workflow-i'`);
    const binding=bindings[0];
    await db.query(`insert into alpha_private.ticket_execution_claims
      (id,workspace_id,ticket_id,project_id,issue_id,scope_version_id,issue_revision_id,developer_id,executor_kind,executor_id,phase,run_id)
      values('workflow-claim','workflow-w',$1,$2,'workflow-i',$3,$4,'workflow-dev','agent','workflow-agent','admitted','workflow-rejected-run')`,
      [binding.ticket_id,binding.project_id,binding.scope_version_id,binding.current_revision_id]);
    const lifecycle=createTicketLifecycleRuntime(db,true);

    await expect(lifecycle.stopReviewedRun({workspaceId:'workflow-w',issueId:'workflow-i'},pm,'workflow-rejected-run'))
      .resolves.toEqual({kind:'ticket',stopped:true});
    expect((await db.query<{phase:string}>(`select phase from alpha_private.ticket_execution_claims where id='workflow-claim'`)).rows[0].phase).toBe('stopped');
    expect((await db.query<{status:string}>(`select status from public.prototype_runs where id='workflow-rejected-run'`)).rows[0].status).toBe('changes_requested');
    await expect(lifecycle.stopReviewedRun({workspaceId:'workflow-w',issueId:'workflow-i'},pm,'workflow-rejected-run'))
      .resolves.toEqual({kind:'ticket',stopped:true});
  });
});
