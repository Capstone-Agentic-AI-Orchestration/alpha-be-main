import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TransactionalSql } from '../store/database.js';
import type { TicketSubject, TicketTarget, LockedTicket } from '../store/ticketCommandStore.js';
import type { TicketExecutor, TicketIssueTarget } from '../store/ticketExecutionAdmissionStore.js';
import type { SavedTicketReadiness } from '../store/ticketTechnicalReadinessStore.js';
import type { TicketDeliveryReadPolicy, TicketDeliverySnapshot } from '../store/ticketDeliveryStore.js';
import { PostgresTicketExecutionStore, loadTicketWorkContext, lockTicketDeveloper, ticketExecutionMissing } from '../store/ticketExecutionPostgresStore.js';
import { createTicketWorkflowTransaction, PostgresTicketWorkflowStore, PostgresTicketResultObjects, ticketManifestHash, ticketClientAccess, ticketIssueFacts, ticketProjectFacts } from '../store/ticketWorkflowPostgresStore.js';
import { createTicketExecutionAdmissionService } from './ticketExecutionAdmissionService.js';
import { createTicketCommandService } from './ticketCommandService.js';
import { createTicketMessageService } from './ticketMessageService.js';
import { createTicketScopeService } from './ticketScopeService.js';
import { createTicketDeliveryService } from './ticketDeliveryService.js';
import { createTicketDeliveryAssessmentService } from './ticketDeliveryAssessmentService.js';
import { projectDeveloperTicketContext } from '../ticketing/developerContext.js';
import { assertCompletedTicketWork, decideTechnicalReadiness, TicketWorkflowError } from '../ticketing/workflow.js';
import { ticketReadyManifest, sameTicketReadyManifest } from '../ticketing/technicalReadiness.js';
import { verifyTicketDeliveryRegistration } from '../ticketing/deliveryReadModels.js';
import { ticketWriteMode } from '../store/ticketPostgresCodec.js';

export const ticketResultPolicy:TicketDeliveryReadPolicy={maxFiles:1,maxFileBytes:65536,maxTotalBytes:65536,objectReadTimeoutMs:10000};
const id=z.string().trim().min(1).max(200);
const executorSchema=z.object({kind:z.enum(['agent','squad']),id}).strict();
const reserveSchema=z.object({operationId:id,executor:executorSchema,runId:id}).strict();
const resultSchema=z.object({schemaVersion:z.literal(1),operationId:id,expectedVersion:z.number().int().nonnegative(),
  publicSummary:z.string().trim().min(1).max(4000).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))}).strict();
const unavailable=()=>new TicketWorkflowError(503,'ticket_workflow_unavailable','Ticket workflow is unavailable right now.');
const executionConflict=()=>new TicketWorkflowError(409,'ticket_execution_conflict','Reconcile the current task execution before starting work.');

/** Production composition of the existing lifecycle decisions and durable stores. */
export function createTicketLifecycleRuntime(db:TransactionalSql,enabled:boolean) {
  const store=new PostgresTicketWorkflowStore(db);
  const objects=new PostgresTicketResultObjects(db);
  const commands=createTicketCommandService(store,undefined,undefined,ticketResultPolicy);
  const requireEnabled=()=>{if(!enabled)throw unavailable();};
  return {
    enabled,store,commands,messages:createTicketMessageService(store),scopes:createTicketScopeService(store),
    deliveries:createTicketDeliveryService(store,objects,ticketResultPolicy),
    candidates:createTicketDeliveryAssessmentService(store,objects,ticketResultPolicy),

    async reserve(target:TicketIssueTarget,subject:TicketSubject,input:unknown) {
      const parsed=reserveSchema.safeParse(input);
      if(!parsed.success)throw new TicketWorkflowError(400,'invalid_ticket_command','Invalid execution request.');
      // The positively unlinked path stays available during a disabled rollout.
      const snapshot=await new PostgresTicketExecutionStore(db).transaction(tx=>tx.loadAuthorizedWorkContext(target.workspaceId,target.issueId,subject));
      if(snapshot)requireEnabled();
      const service=createTicketExecutionAdmissionService(new PostgresTicketExecutionStore(db,parsed.data.executor,subject,parsed.data.runId));
      const outcome=await service.reserve(target,subject,{schemaVersion:1,operationId:parsed.data.operationId,
        expectedRevisionId:snapshot?.issue.revisionId??'unlinked',executor:parsed.data.executor});
      if(outcome.kind==='unlinked')return outcome;
      const {rows}=await db.query<{run_id:string;verification_id:string}>(`select d.run_id,d.verification_id from alpha_private.ticket_execution_dispatches d join alpha_private.ticket_execution_claims c on c.id=d.claim_id
        where c.workspace_id=$1 and c.issue_id=$2 and c.id=$3 and c.developer_id=$4`,[target.workspaceId,target.issueId,outcome.receipt.claimId,subject.userId]);
      if(!rows[0]||!snapshot)throw executionConflict();
      if(rows[0].run_id!==parsed.data.runId)throw executionConflict();
      return {...outcome,runId:rows[0].run_id,verificationId:rows[0].verification_id,context:projectDeveloperTicketContext(target.workspaceId,target.issueId,subject.userId,snapshot)};
    },

    async admit(target:TicketIssueTarget,subject:TicketSubject,input:unknown) {
      requireEnabled();
      const parsed=z.object({claimId:id,runId:id,executor:executorSchema,memberOrder:z.number().int().min(0).default(0)}).strict().safeParse(input);
      if(!parsed.success||subject.kind!=='internal')throw ticketExecutionMissing();
      const value=parsed.data;
      const {rows}=await db.query<{verification_id:string}>(`select d.verification_id from alpha_private.ticket_execution_dispatches d join alpha_private.ticket_execution_claims c on c.id=d.claim_id
        where c.workspace_id=$1 and c.issue_id=$2 and c.id=$3 and d.run_id=$4 and d.developer_id=$5 and d.executor_kind=$6 and d.executor_id=$7`,
        [target.workspaceId,target.issueId,value.claimId,value.runId,subject.userId,value.executor.kind,value.executor.id]);
      if(!rows[0])throw ticketExecutionMissing();
      const service=createTicketExecutionAdmissionService(new PostgresTicketExecutionStore(db,value.executor,subject));
      const admitted=await service.admit(target,{kind:'verified_run_admission',verificationId:rows[0].verification_id});
      // One launch per logical agent run or per ordered squad member. Replayed
      // admission cannot spawn a second process, including after a lost response.
      const launched=await db.transaction(async sql=>{
        const context=await loadTicketWorkContext(sql,target,subject);
        if(!context)throw ticketExecutionMissing();
        projectDeveloperTicketContext(target.workspaceId,target.issueId,subject.userId,context);
        if(!await ticketClientAccess(sql,{state:context.ticket.state,actor:{kind:'developer',workspaceId:target.workspaceId,userId:subject.userId}}))throw executionConflict();
        const {rows:claims}=await sql.query(`select id from alpha_private.ticket_execution_claims where id=$1 and workspace_id=$2 and issue_id=$3 and phase='admitted' and run_id=$4 for update`,[value.claimId,target.workspaceId,target.issueId,value.runId]);
        if(!claims.length)throw executionConflict();
        if(value.executor.kind==='agent'&&value.memberOrder!==0)throw executionConflict();
        if(value.executor.kind==='squad'){
          const {rows:squads}=await sql.query<{member_agent_ids:string[]}>(`select member_agent_ids from squads where workspace_id=$1 and id=$2 for share`,[target.workspaceId,value.executor.id]);
          if(!squads[0]||value.memberOrder>=squads[0].member_agent_ids.length)throw executionConflict();
        }
        const {rows:turn}=await sql.query(`update alpha_private.ticket_execution_dispatches set next_member_order=next_member_order+1
          where verification_id=$1 and next_member_order=$2 returning verification_id`,[rows[0].verification_id,value.memberOrder]);
        return turn.length===1;
      });
      return {launch:launched,context:admitted.context};
    },

    async stop(target:TicketIssueTarget,subject:TicketSubject,claimId:string) {
      return db.transaction(async sql=>{
        if(!await lockTicketDeveloper(sql,target.workspaceId,subject))throw ticketExecutionMissing();
        const {rows}=await sql.query<{phase:string;run_id:string|null;ticket_id:string;executor_kind:'agent'|'squad'}>(`select phase,run_id,ticket_id,executor_kind from alpha_private.ticket_execution_claims
          where workspace_id=$1 and issue_id=$2 and id=$3 and developer_id=$4 for update`,[target.workspaceId,target.issueId,claimId,subject.userId]);
        if(!rows[0])throw ticketExecutionMissing();
        if(rows[0].phase==='stopped')return {stopped:true};
        if(rows[0].phase==='admitted'){
          if (rows[0].executor_kind === 'squad') {
            const {rows:squads}=await sql.query<{status:string}>(`select status from public.squad_runs where workspace_id=$1 and id=$2`,[target.workspaceId,rows[0].run_id]);
            const {rows:members}=await sql.query<{status:string}>(`select status from public.prototype_runs where workspace_id=$1 and squad_run_id=$2`,[target.workspaceId,rows[0].run_id]);
            const stopped = squads.some(run=>['failed','cancelled'].includes(run.status))
              || members.some(run=>['failed','cancelled','changes_requested'].includes(run.status));
            if (!stopped) throw executionConflict();
          } else {
            const {rows:runs}=await sql.query<{status:string}>(`select status from prototype_runs where workspace_id=$1 and id=$2`,[target.workspaceId,rows[0].run_id]);
            if(!runs[0]||!['failed','cancelled','changes_requested','completed'].includes(runs[0].status))throw executionConflict();
          }
        }
        await sql.query(`update alpha_private.ticket_execution_claims set phase='stopped',stopped_at=now() where id=$1`,[claimId]);
        return {stopped:true};
      });
    },

    /** Called from the existing authenticated human review checkpoint. The
     * source Issue, run and complete ticket manifest are freshly read in SQL. */
    async completeReviewedIssue(target:TicketIssueTarget,subject:TicketSubject,runId?:string) {
      return db.transaction(async sql=>{
        if(subject.kind!=='internal')throw ticketExecutionMissing();
        const member=await lockTicketDeveloper(sql,target.workspaceId,subject);
        if(!member)throw ticketExecutionMissing();
        const snapshot=await loadTicketWorkContext(sql,target,subject);
        if(!snapshot)return {kind:'unlinked' as const};
        requireEnabled();
        const state=snapshot.ticket.state;
        // The developer context projector intentionally accepts only startable
        // Issues. Review runs arrive in `review`, so completion validates the
        // agreed manifest directly instead of misusing that execution reader.
        if(!snapshot.developerProjectAccessActive||!snapshot.project.nonProductionSafe
          ||snapshot.issue.status!=='in_progress'&&snapshot.issue.status!=='review'&&snapshot.issue.status!=='done'
          ||state.status!=='in_progress'||state.withdrawalRequested||state.hold!==null||state.delivery!==null
          ||state.correctionRequestedFor!==null||!state.requiredIssueIds.includes(target.issueId)
          ||state.projectId!==snapshot.project.id||state.scopeVersionId!==snapshot.scope.id
          ||state.agreedScopeVersionId!==snapshot.scope.id||state.authorizedScopeVersionId!==snapshot.scope.id
          ||!snapshot.scope.immutable||!snapshot.scope.clientAgreed)throw executionConflict();
        const {rows:claims}=await sql.query<{id:string;developer_id:string;run_id:string|null;phase:string;executor_kind:string}>(`select * from alpha_private.ticket_execution_claims where workspace_id=$1 and issue_id=$2 and phase in ('reserved','admitted') for update`,[target.workspaceId,target.issueId]);
        const active=claims[0];
        // PMs can review another developer's completed work; an active process
        // is never converted into a passing review by a status update.
        const {rows:runs}=await sql.query<{id:string;status:string;squad_run_id:string|null}>(`select id,status,squad_run_id from prototype_runs where workspace_id=$1 and issue_id=$2 order by created_at desc`,[target.workspaceId,target.issueId]);
        const reviewRun=runId?runs.find(run=>run.id===runId):null;
        if(runId&&(!reviewRun||reviewRun.status!=='completed'))throw executionConflict();
        if(runs.some(run=>['queued','running','awaiting_approval'].includes(run.status)))throw executionConflict();
        if(active?.phase==='admitted'&&(!reviewRun
          ||active.executor_kind==='agent'&&active.run_id!==reviewRun.id
          ||active.executor_kind==='squad'&&active.run_id!==reviewRun.squad_run_id))throw executionConflict();
        if(active?.phase==='reserved')throw executionConflict();
        const actorKind=member.role==='dev'?'developer':'pm';
        const ticket:LockedTicket={state,actor:actorKind==='pm'
          ?{kind:'pm',workspaceId:target.workspaceId,userId:subject.userId,membershipActive:true,canManageTickets:true}
          :{kind:'developer',workspaceId:target.workspaceId,userId:subject.userId},mode:'enabled'};
        if(!await ticketClientAccess(sql,ticket))throw executionConflict();
        const {rows:workspaces}=await sql.query<{mode:string}>(`select settings_json->>'ticketing_write_mode' as mode from workspaces where id=$1`,[target.workspaceId]);
        if(ticketWriteMode(workspaces[0]?.mode)!=='enabled')throw unavailable();
        if(active)await sql.query(`update alpha_private.ticket_execution_claims set phase='stopped',stopped_at=now() where id=$1`,[active.id]);
        await sql.query(`update public.issues set status='done',updated_at=now() where workspace_id=$1 and id=$2`,[target.workspaceId,target.issueId]);
        await sql.query(`insert into alpha_private.ticket_issue_reviews(workspace_id,issue_id,revision_id,reviewed_by,verdict,run_id,evidence)
          values($1,$2,$3,$4,'passed',$5,$6::jsonb) on conflict(workspace_id,issue_id,revision_id) do nothing`,
          [target.workspaceId,target.issueId,snapshot.issue.revisionId,subject.userId,runId??null,JSON.stringify({checkpoint:'existing-human-review',runId:runId??null})]);
        // lockAuthorizedTicket is PM/client-only. Trusted completion operates on
        // its already authorized developer snapshot through the same facts loader.
        const facts={clientAccessActive:true,project:await ticketProjectFacts(sql,target.workspaceId,snapshot.project.id),
          issues:await ticketIssueFacts(sql,ticket,snapshot.ticket.state.requiredIssueIds)};
        if(facts.issues.some(issue=>issue.status!=='done'||!issue.requiredReviewsPassed||issue.hasActiveRun))return {kind:'ticket' as const,ready:false};
        assertCompletedTicketWork(ticket.state,facts);
        const manifest=ticketReadyManifest(ticket.state,facts);
        const hash=ticketManifestHash(manifest);
        const {rows:existing}=await sql.query(`select id from alpha_private.ticket_ready_manifests where workspace_id=$1 and ticket_id=$2 and manifest_hash=$3`,[target.workspaceId,ticket.state.id,hash]);
        if(existing.length)return {kind:'ticket' as const,ready:true};
        const operationId=`ready-${hash}`;
        const eventId=randomUUID();
        const decision=decideTechnicalReadiness(ticket.state,{kind:'execution',userId:subject.userId,workspaceId:target.workspaceId,ticketId:ticket.state.id,
          issueId:target.issueId,issueRevisionId:snapshot.issue.revisionId,authorized:true},operationId,ticket.state.version,facts,'enabled');
        const saved:SavedTicketReadiness={key:{...target,ticketId:ticket.state.id,kind:'technical_work_ready',actorId:subject.userId,runId:runId??`manual-${eventId}`,completionId:eventId,operationId},
          fingerprint:hash,manifest,receipt:{ticketId:ticket.state.id,operationId,version:decision.state.version,status:decision.state.status}};
        await sql.query(`insert into alpha_private.ticket_ready_manifests(id,workspace_id,ticket_id,scope_version_id,manifest_hash,readiness) values($1,$2,$3,$4,$5,$6::jsonb)`,[manifest.id,target.workspaceId,ticket.state.id,snapshot.scope.id,hash,JSON.stringify(saved)]);
        const {rows:savedState}=await sql.query(`update alpha_private.tickets set workflow_state=$4::jsonb,version=$3,internal_updated_at=now()
          where workspace_id=$1 and id=$2 and version=$5 returning id`,[target.workspaceId,ticket.state.id,decision.state.version,JSON.stringify(decision.state),ticket.state.version]);
        if(!savedState.length)throw executionConflict();
        await sql.query(`insert into alpha_private.ticket_audit_events(id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
          values($1,$2,$3,$4,$5,'technical_work_ready',now(),$6::jsonb)`,[eventId,target.workspaceId,ticket.state.id,actorKind,subject.userId,JSON.stringify({manifestId:manifest.id})]);
        return {kind:'ticket' as const,ready:true};
      });
    },

    /** A PM's run rejection ends the durable ticket claim before a later retry. */
    async stopReviewedRun(target:TicketIssueTarget,subject:TicketSubject,runId:string) {
      requireEnabled();
      if(subject.kind!=='internal')throw ticketExecutionMissing();
      return db.transaction(async sql=>{
        const member=await lockTicketDeveloper(sql,target.workspaceId,subject);
        if(!member)throw ticketExecutionMissing();
        const snapshot=await loadTicketWorkContext(sql,target,subject);
        if(!snapshot)return {kind:'unlinked' as const};
        const {rows:runs}=await sql.query<{id:string;status:string;squad_run_id:string|null}>(
          `select id,status,squad_run_id from prototype_runs where workspace_id=$1 and issue_id=$2 and id=$3 for update`,
          [target.workspaceId,target.issueId,runId]);
        const run=runs[0];
        if(!run||!['review','awaiting_approval','changes_requested','failed','cancelled'].includes(run.status))throw executionConflict();
        const {rows:claims}=await sql.query<{id:string;run_id:string|null;executor_kind:'agent'|'squad';phase:string}>(
          `select id,run_id,executor_kind,phase from alpha_private.ticket_execution_claims
            where workspace_id=$1 and issue_id=$2 and phase in ('reserved','admitted') for update`,
          [target.workspaceId,target.issueId]);
        for(const claim of claims){
          const matches=claim.executor_kind==='agent'?claim.run_id===run.id:claim.run_id===run.squad_run_id;
          if(!matches)throw executionConflict();
          await sql.query(`update alpha_private.ticket_execution_claims set phase='stopped',stopped_at=now() where id=$1`,[claim.id]);
        }
        if(run.status!=='changes_requested'){
          await sql.query(`update public.prototype_runs set status='changes_requested',updated_at=now() where workspace_id=$1 and id=$2`,[target.workspaceId,run.id]);
          await sql.query(`update public.issues set status='todo',updated_at=now() where workspace_id=$1 and id=$2`,[target.workspaceId,target.issueId]);
          await sql.query(`insert into alpha_private.ticket_audit_events(id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
            values($1,$2,$3,$4,$5,'issue_review_changes_requested',now(),$6::jsonb)`,
            [randomUUID(),target.workspaceId,snapshot.ticket.id,member.role==='dev'?'developer':'pm',subject.userId,JSON.stringify({issueId:target.issueId,runId:run.id})]);
        }
        return {kind:'ticket' as const,stopped:true};
      });
    },

    /** A bounded plain-text result is generated from the PM's explicit public
     * summary. No Issue descriptions, contacts, notes or runner logs are copied. */
    async prepareResult(target:TicketTarget,subject:TicketSubject,input:unknown) {
      requireEnabled();
      const parsed=resultSchema.safeParse(input);
      if(!parsed.success)throw new TicketWorkflowError(400,'invalid_ticket_command','Enter a result summary.');
      return db.transaction(async sql=>{
        const tx=createTicketWorkflowTransaction(sql);
        const ticket=await tx.lockAuthorizedTicket(target,subject);
        if(!ticket||ticket.actor.kind!=='pm')throw ticketExecutionMissing();
        if(ticket.mode!=='enabled')throw unavailable();
        const value=parsed.data;
        const {rows:replays}=await sql.query<{snapshot:TicketDeliverySnapshot}>(`select snapshot from alpha_private.ticket_delivery_registrations where workspace_id=$1 and ticket_id=$2 and created_by=$3 and operation_id=$4`,[target.workspaceId,target.ticketId,subject.userId,value.operationId]);
        if(replays[0]){
          if(replays[0].snapshot.delivery.publicSummary!==value.publicSummary)throw new TicketWorkflowError(409,'ticket_operation_conflict','This operation ID was used for another result.');
          return {deliveryId:replays[0].snapshot.delivery.id};
        }
        if(ticket.state.version!==value.expectedVersion||ticket.state.delivery)throw executionConflict();
        const facts=await tx.loadFacts(ticket,{schemaVersion:1,operationId:value.operationId,expectedVersion:value.expectedVersion,command:{type:'review'}});
        assertCompletedTicketWork(ticket.state,facts);
        const ready=ticketReadyManifest(ticket.state,facts);
        const {rows}=await sql.query<{id:string;readiness:SavedTicketReadiness}>(`select id,readiness from alpha_private.ticket_ready_manifests where workspace_id=$1 and ticket_id=$2 and manifest_hash=$3 for share`,[target.workspaceId,target.ticketId,ticketManifestHash(ready)]);
        if(!rows[0]||!sameTicketReadyManifest(rows[0].readiness.manifest,ready))throw executionConflict();
        const deliveryId=randomUUID(),assetId=randomUUID(),fileId=randomUUID();
        const bytes=Buffer.from(value.publicSummary,'utf8');
        const sha256=createHash('sha256').update(bytes).digest('hex');
        const now=new Date().toISOString();
        const objectKey=JSON.stringify([target.workspaceId,target.ticketId,assetId,fileId]);
        const revisions=ready.issueRevisions.map(issue=>issue.revisionId);
        const snapshot:TicketDeliverySnapshot={delivery:{...target,id:deliveryId,scopeVersionId:ready.scopeVersionId,pinnedAssetId:assetId,issueRevisionIds:revisions,
          immutable:true,clientVisible:true,publicSummary:value.publicSummary,sharedAt:null},manifest:{...target,id:assetId,scopeVersionId:ready.scopeVersionId,issueRevisionIds:revisions,immutable:true,
          files:[{...target,id:fileId,pinnedAssetId:assetId,filename:'project-result.txt',mediaType:'text/plain',byteLength:bytes.length,sha256,immutable:true,clientVisible:true,
            scan:{verdict:'clean',sha256,policyVersion:'generated-utf8-text-v1',completedAt:now},object:{key:objectKey,version:sha256}}]}};
        verifyTicketDeliveryRegistration(snapshot,ready,ticketResultPolicy);
        await sql.query(`insert into alpha_private.ticket_result_objects(workspace_id,ticket_id,asset_id,file_id,object_key,object_version,content) values($1,$2,$3,$4,$5,$6,$7)`,[target.workspaceId,target.ticketId,assetId,fileId,objectKey,sha256,bytes]);
        await sql.query(`insert into alpha_private.ticket_deliveries(id,workspace_id,ticket_id,scope_version_id,pinned_asset_id,issue_revision_ids,immutable,client_visible,public_summary)
          values($1,$2,$3,$4,$5,$6::jsonb,true,true,$7)`,[deliveryId,target.workspaceId,target.ticketId,ready.scopeVersionId,assetId,JSON.stringify(revisions),value.publicSummary]);
        await sql.query(`insert into alpha_private.ticket_delivery_registrations(workspace_id,ticket_id,id,ready_manifest_id,snapshot,operation_id,created_by) values($1,$2,$3,$4,$5::jsonb,$6,$7)`,[target.workspaceId,target.ticketId,deliveryId,rows[0].id,JSON.stringify(snapshot),value.operationId,subject.userId]);
        return {deliveryId};
      });
    },
  };
}
export type TicketLifecycleRuntime=ReturnType<typeof createTicketLifecycleRuntime>;
