import { randomUUID } from 'node:crypto';
import type { Sql, TransactionalSql } from './database.js';
import type { TicketSubject } from './ticketCommandStore.js';
import type { TicketDeveloperContextSnapshot, TicketDeveloperContextTransaction } from './ticketDeveloperContextStore.js';
import type { TicketExecutionAdmissionTransaction, TicketExecutionClaim, TicketExecutor, TicketIssueTarget } from './ticketExecutionAdmissionStore.js';
import { decodeTicketWorkflow, ticketSqlIso, ticketWriteMode } from './ticketPostgresCodec.js';
import { ticketClientAccess, ticketProjectFacts } from './ticketWorkflowPostgresStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

export type TicketExecutionTransaction = TicketExecutionAdmissionTransaction & TicketDeveloperContextTransaction;
export const ticketExecutionMissing = () => new TicketWorkflowError(404,'ticket_work_not_found','Issue work not found.');

export async function lockTicketDeveloper(sql:Sql,workspaceId:string,subject:TicketSubject) {
  if (subject.kind!=='internal') return null;
  const session=subject.authentication.kind==='session';
  const {rows}=await sql.query<{role:string}>(`select m.role from public.workspace_members m
    join public.workspaces w on w.id=m.workspace_id and w.status='active'
    ${session ? 'join alpha_private.sessions s on s.id=$3 and lower(s.login)=lower(m.user_id) and s.expires_at>now()' : ''}
    where m.workspace_id=$1 and m.user_id=$2 and m.status='active' and m.role in ('dev','pm','admin')
    for share of m,w${session?',s':''}`,[workspaceId,subject.userId,...(session?[subject.authentication.kind==='session'?subject.authentication.sessionId:'']:[])]);
  return rows[0]??null;
}

export async function loadTicketWorkContext(sql:Sql,target:TicketIssueTarget,subject:TicketSubject):Promise<TicketDeveloperContextSnapshot|null> {
  if (!await lockTicketDeveloper(sql,target.workspaceId,subject)) return null;
  const {rows:links}=await sql.query<{ticket_id:string}>(`select ticket_id from alpha_private.ticket_work_bindings where workspace_id=$1 and issue_id=$2`,[target.workspaceId,target.issueId]);
  if (!links[0]) return null;
  const {rows:tickets}=await sql.query<{reference:string;workflow_state:unknown}>(`select reference,workflow_state from alpha_private.tickets where workspace_id=$1 and id=$2 for update`,[target.workspaceId,links[0].ticket_id]);
  if (!tickets[0]) return null;
  const state=decodeTicketWorkflow(tickets[0].workflow_state);
  const {rows}=await sql.query<{project_id:string;status:TicketDeveloperContextSnapshot['issue']['status'];ticket_id:string;scope_version_id:string;initial_revision_id:string;current_revision_id:string}>(
    `select i.project_id,i.status,b.ticket_id,b.scope_version_id,b.initial_revision_id,b.current_revision_id from public.issues i
     join alpha_private.ticket_work_bindings b on b.workspace_id=i.workspace_id and b.issue_id=i.id
     where i.workspace_id=$1 and i.id=$2 for update of i,b`,[target.workspaceId,target.issueId]);
  const row=rows[0];
  if (!row || row.ticket_id!==state.id || row.project_id!==state.projectId) return null;
  const project=await ticketProjectFacts(sql,target.workspaceId,row.project_id);
  if (!project?.creatorActive) return null;
  const {rows:scopes}=await sql.query<{developer_brief:string;immutable:boolean}>(`select developer_brief,immutable from alpha_private.ticket_scopes where workspace_id=$1 and ticket_id=$2 and id=$3 for share`,[target.workspaceId,row.ticket_id,row.scope_version_id]);
  if (!scopes[0]) return null;
  let correction:TicketDeveloperContextSnapshot['correction']=null;
  if (row.current_revision_id!==row.initial_revision_id) {
    const {rows:revisions}=await sql.query<{previous_revision_id:string;instructions:string;source:'request_fixes'|'authorize_correction';authorized_by:string;authorized_at:string|Date}>(`select previous_revision_id,instructions,source,authorized_by,authorized_at from alpha_private.ticket_issue_revisions where workspace_id=$1 and issue_id=$2 and revision_id=$3 for share`,[target.workspaceId,target.issueId,row.current_revision_id]);
    const r=revisions[0]; if (!r) return null;
    correction={...target,ticketId:row.ticket_id,projectId:row.project_id,scopeVersionId:row.scope_version_id,issueRevisionId:row.current_revision_id,
      previousRevisionId:r.previous_revision_id,developerInstructions:r.instructions,source:r.source,authorizedByPmId:r.authorized_by,authorizedAt:ticketSqlIso(r.authorized_at),immutable:true};
  }
  return {workspaceId:target.workspaceId,developerProjectAccessActive:true,
    issue:{id:target.issueId,workspaceId:target.workspaceId,projectId:row.project_id,ticketId:row.ticket_id,revisionId:row.current_revision_id,initialRevisionId:row.initial_revision_id,status:row.status},
    project:{id:project.id,workspaceId:target.workspaceId,nonProductionSafe:project.nonProductionSafe},
    ticket:{id:state.id,workspaceId:state.workspaceId,reference:tickets[0].reference,state},
    scope:{id:row.scope_version_id,ticketId:state.id,workspaceId:state.workspaceId,developerBrief:scopes[0].developer_brief,
      immutable:scopes[0].immutable,clientAgreed:state.agreedScopeVersionId===row.scope_version_id},correction};
}

async function executorAllowed(sql:Sql,target:TicketIssueTarget,projectId:string,subject:TicketSubject,executor:TicketExecutor) {
  const member=await lockTicketDeveloper(sql,target.workspaceId,subject);
  if (!member || subject.kind!=='internal') return false;
  if (executor.kind==='agent') {
    const {rows}=await sql.query<{allowed_users:string|null;owner:string|null}>(`select allowed_users,owner from public.agents where workspace_id=$1 and id=$2 and not is_archived for share`,[target.workspaceId,executor.id]);
    const agent=rows[0];
    return Boolean(agent && (['team','everyone'].includes(agent.allowed_users??'team') || (agent.allowed_users==='private'&&agent.owner===subject.userId) || (agent.allowed_users==='admins'&&member.role==='admin')));
  }
  const {rows}=await sql.query(`select s.id from public.squads s
    join public.workspace_squad_projects p on p.workspace_id=s.workspace_id and p.squad_id=s.id and p.project_id=$3 and p.status='active'
    where s.workspace_id=$1 and s.id=$2 and ( $4 in ('pm','admin') or exists(select 1 from public.workspace_squad_owners o where o.workspace_id=s.workspace_id and o.squad_id=s.id and o.user_id=$5 and o.status='active'))
    for share of s,p`,[target.workspaceId,executor.id,projectId,member.role,subject.userId]);
  return rows.length===1;
}

function claim(row:Record<string,unknown>):TicketExecutionClaim {
  return {id:String(row.id),workspaceId:String(row.workspace_id),ticketId:String(row.ticket_id),projectId:String(row.project_id),issueId:String(row.issue_id),scopeVersionId:String(row.scope_version_id),issueRevisionId:String(row.issue_revision_id),developerId:String(row.developer_id),executor:{kind:row.executor_kind as 'agent'|'squad',id:String(row.executor_id)},phase:row.phase as TicketExecutionClaim['phase'],runId:row.run_id as string|null};
}

export class PostgresTicketExecutionStore {
  constructor(
    private readonly db:TransactionalSql,
    private readonly executor?:TicketExecutor,
    private readonly requestSubject?:TicketSubject,
    private readonly plannedRunId?:string,
  ) {}
  transaction<T>(work:(tx:TicketExecutionTransaction)=>Promise<T>):Promise<T> {
    const plannedRunId=this.plannedRunId;
    return this.db.transaction(async sql=>{
      let authorized:TicketIssueTarget|null=null;
      const check=(target:TicketIssueTarget)=>{if (!authorized || target.workspaceId!==authorized.workspaceId || target.issueId!==authorized.issueId) throw ticketExecutionMissing();};
      const tx:TicketExecutionTransaction={
        loadAuthorizedWorkContext:(workspaceId,issueId,subject)=>loadTicketWorkContext(sql,{workspaceId,issueId},subject),
        async lockAuthorizedIssue(target,subject) {
          if (!await lockTicketDeveloper(sql,target.workspaceId,subject)) return null;
          const snapshot=await loadTicketWorkContext(sql,target,subject);
          if (!snapshot) {
            // A missing binding is serialized with the PM's insertion by locking
            // the actual existing Issue, then checking the binding slot again.
            const {rows}=await sql.query<{project_id:string}>(`select project_id from public.issues where workspace_id=$1 and id=$2 for update`,[target.workspaceId,target.issueId]);
            if (!rows[0]) return null;
            const {rows:bindings}=await sql.query(`select issue_id from alpha_private.ticket_work_bindings where workspace_id=$1 and issue_id=$2`,[target.workspaceId,target.issueId]);
            if (bindings.length) throw new TicketWorkflowError(409,'ticket_execution_conflict','The work authorization changed. Refresh and retry.');
            if (!(await ticketProjectFacts(sql,target.workspaceId,rows[0].project_id))?.creatorActive) return null;
            authorized=target;
            return {...target,kind:'unlinked',developerId:subject.userId};
          }
          authorized=target;
          const project=await ticketProjectFacts(sql,target.workspaceId,snapshot.project.id);
          const {rows:workspaces}=await sql.query<{mode:string}>(`select settings_json->>'ticketing_write_mode' as mode from public.workspaces where id=$1`,[target.workspaceId]);
          const executor=requiredExecutor;
          return {kind:'ticket',snapshot,
            clientAccessActive:await ticketClientAccess(sql,{state:snapshot.ticket.state,actor:{kind:'developer',workspaceId:target.workspaceId,userId:subject.userId}}),
            projectCreatorActive:project?.creatorActive===true,mode:ticketWriteMode(workspaces[0]?.mode),
            executor:{...executor,active:true,allowed:await executorAllowed(sql,target,snapshot.project.id,subject,executor)}};
        },
        async lockVerifiedRun(target,subject) {
          if (!requestSubject || requestSubject.kind!=='internal') return null;
          const {rows}=await sql.query<{claim_id:string;run_id:string;developer_id:string;executor_kind:'agent'|'squad';executor_id:string}>(
            `select d.* from alpha_private.ticket_execution_dispatches d join alpha_private.ticket_execution_claims c on c.id=d.claim_id
             where d.verification_id=$1 and c.workspace_id=$2 and c.issue_id=$3 and d.developer_id=$4 for share of d`,[subject.verificationId,target.workspaceId,target.issueId,requestSubject.userId]);
          if (!rows[0]) return null;
          const issue=await tx.lockAuthorizedIssue(target,requestSubject);
          if (!issue || issue.kind!=='ticket') return null;
          return {issue,claimId:rows[0].claim_id,runId:rows[0].run_id,developerId:rows[0].developer_id,executor:{kind:rows[0].executor_kind,id:rows[0].executor_id}};
        },
        async findOperation(key) {
          check(key);
          const {rows}=await sql.query<{fingerprint:string;receipt:import('./ticketExecutionAdmissionStore.js').TicketAdmissionReceipt}>(`select fingerprint,receipt from alpha_private.ticket_execution_operations where workspace_id=$1 and issue_id=$2 and actor_id=$3 and operation_id=$4`,[key.workspaceId,key.issueId,key.actorId,key.operationId]);
          return rows[0]?{key,...rows[0]}:null;
        },
        async findActiveClaim(target) {
          check(target);
          const {rows}=await sql.query(`select * from alpha_private.ticket_execution_claims where workspace_id=$1 and issue_id=$2 and phase in ('reserved','admitted') for update`,[target.workspaceId,target.issueId]);
          return rows[0]?claim(rows[0]):null;
        },
        async insertClaim(value) {
          check(value);
          await sql.query(`insert into alpha_private.ticket_execution_claims
            (id,workspace_id,ticket_id,project_id,issue_id,scope_version_id,issue_revision_id,developer_id,executor_kind,executor_id,phase,run_id)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[value.id,value.workspaceId,value.ticketId,value.projectId,value.issueId,value.scopeVersionId,value.issueRevisionId,value.developerId,value.executor.kind,value.executor.id,value.phase,value.runId]);
          const runId=plannedRunId??`ticket-run-${randomUUID()}`;
          await sql.query(`insert into alpha_private.ticket_execution_dispatches(verification_id,claim_id,run_id,developer_id,executor_kind,executor_id) values($1,$2,$3,$4,$5,$6)`,[randomUUID(),value.id,runId,value.developerId,value.executor.kind,value.executor.id]);
        },
        async admitClaim(value,runId) {
          check(value);
          const {rows}=await sql.query(`update alpha_private.ticket_execution_claims set phase='admitted',run_id=$4 where id=$1 and workspace_id=$2 and issue_id=$3 and phase='reserved' and run_id is null returning id`,[value.id,value.workspaceId,value.issueId,runId]);
          return rows.length===1;
        },
        async appendAudit(event) {
          check(event.claim);
          await sql.query(`insert into alpha_private.ticket_audit_events(id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
            values($1,$2,$3,'developer',$4,$5,$6,$7::jsonb)`,[randomUUID(),event.claim.workspaceId,event.claim.ticketId,event.claim.developerId,event.type,event.occurredAt,JSON.stringify({claimId:event.claim.id,issueId:event.claim.issueId,revisionId:event.claim.issueRevisionId})]);
        },
        async insertOperation(value) {
          check(value.key);
          await sql.query(`insert into alpha_private.ticket_execution_operations(workspace_id,issue_id,actor_id,operation_id,fingerprint,receipt) values($1,$2,$3,$4,$5,$6::jsonb)`,[value.key.workspaceId,value.key.issueId,value.key.actorId,value.key.operationId,value.fingerprint,JSON.stringify(value.receipt)]);
        },
      };
      const requiredExecutor=this.executor??{kind:'agent' as const,id:'unselected'};
      const requestSubject=this.requestSubject;
      return work(tx);
    });
  }
}
