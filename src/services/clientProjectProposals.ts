import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DatabaseCommitError, type TransactionalSql } from '../store/database.js';
import { isTransactionOutcomeUnknown } from '../store/transactionOutcome.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { CLIENT_TICKET_ACCESS_JOINS_SQL, CLIENT_VISIBLE_PROJECT_SQL } from '../store/ticketClientSql.js';

/** How long an accepted proposal stays in the client's list; after that the project lives on in their projects. */
export const ACCEPTED_PROPOSAL_DAYS = 30;

const inputSchema = z.object({ schemaVersion:z.literal(1), operationId:z.string().uuid(),
  title:z.string().trim().min(1).max(160), description:z.string().trim().min(1).max(6000),
  requestedDeadline:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
  }).nullable(),
}).strict();
const replySchema = z.object({ schemaVersion:z.literal(1), operationId:z.string().uuid(),
  body:z.string().trim().min(1).max(4000),
}).strict();
export class ClientProjectProposals {
  constructor(private readonly db:TransactionalSql, private readonly organizationKey:string) {}
  /**
   * The client's own proposals. Accepted ones stay for a while with what they became: the
   * project, but only when this client can see it right now (the same access and visibility
   * rules as their project list), so a hidden or unshared project is never named here.
   */
  async list(subject:Extract<TicketSubject,{kind:'client'}>) {
    const result=await this.db.query<{id:string;title:string;description:string;requested_deadline:string|null;submitted_at:Date|string;
      status:'pending'|'awaiting_client'|'declined'|'accepted';clarification_messages:unknown;accepted_at:Date|string|null;
      project_workspace_id:string|null;project_id:string|null;project_name:string|null}>(
      `select i.id,i.title,i.description,i.requested_deadline,i.submitted_at,i.status,i.accepted_at,
              vp.project_workspace_id,vp.project_id,vp.project_name,
              coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'author',e.actor_kind,'body',e.metadata->>'body','createdAt',e.occurred_at)
                  order by e.occurred_at,e.id)
                from alpha_private.ticket_central_intake_events e
               where e.organization_key=i.organization_key and e.intake_id=i.id
                 and e.event_type in ('proposal_clarification_requested','proposal_clarification_replied')),'[]'::jsonb) as clarification_messages
         from alpha_private.ticket_central_intakes i
         left join lateral (select t.workspace_id as project_workspace_id,t.project_id,p.name as project_name
             from alpha_private.tickets t
             ${CLIENT_TICKET_ACCESS_JOINS_SQL}
             join public.projects p on p.id=t.project_id and p.workspace_id=t.workspace_id
            where i.status='accepted' and t.workspace_id=i.accepted_workspace_id and t.id=i.accepted_ticket_id
              and t.client_user_id=$2 and ${CLIENT_VISIBLE_PROJECT_SQL}) vp on true
       where i.organization_key=$1 and i.client_user_id=$2 and i.kind='project_proposal'
         and (i.status in ('pending','awaiting_client','declined')
           or (i.status='accepted' and i.accepted_at > now() - make_interval(days => $3)))
       order by i.submitted_at desc,i.id desc`, [this.organizationKey,subject.userId,ACCEPTED_PROPOSAL_DAYS]);
    return {items:result.rows.map(row=>({id:row.id,title:row.title,description:row.description,
      requestedDeadline:row.requested_deadline,submittedAt:new Date(row.submitted_at).toISOString(),status:row.status,
      clarificationMessages:parseClarificationMessages(row.clarification_messages),
      ...(row.status==='accepted' ? {
        acceptedAt:row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
        project:row.project_id && row.project_workspace_id && row.project_name
          ? {workspaceId:row.project_workspace_id,projectId:row.project_id,name:row.project_name} : null,
      } : {})}))};
  }
  async submit(subject:Extract<TicketSubject,{kind:'client'}>,email:string|null,raw:unknown) {
    const parsed=inputSchema.safeParse(raw);
    if(!parsed.success) throw new TicketWorkflowError(400,'project_proposal_invalid','Check the project title, description, and target date.');
    if(!email) throw new TicketWorkflowError(503,'project_proposal_identity_unavailable','Your verified account email could not be confirmed. Try again.');
    const input=parsed.data;
    const fingerprint=createHash('sha256').update(JSON.stringify({userId:subject.userId,...input})).digest('hex');
    return this.db.transaction(async tx=>{
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`proposal:${this.organizationKey}:${input.operationId}`]);
      const saved=await tx.query<{id:string;client_user_id:string;fingerprint:string}>(
        'select id,client_user_id,fingerprint from alpha_private.ticket_central_intakes where organization_key=$1 and operation_id=$2 for update',
        [this.organizationKey,input.operationId]);
      if(saved.rows[0]) {
        if(saved.rows[0].client_user_id!==subject.userId || saved.rows[0].fingerprint!==fingerprint)
          throw new TicketWorkflowError(409,'project_proposal_conflict','This submission ID has already been used.');
        return {id:saved.rows[0].id};
      }
      const id=randomUUID();
      await tx.query(`insert into alpha_private.ticket_central_intakes
        (organization_key,id,operation_id,fingerprint,fingerprint_key_id,public_reference,full_name,email,title,description,
         requested_deadline,kind,client_user_id)
        values($1,$2,$3,$4,'project-proposal-v1',$5,left($6,160),$6,$7,$8,$9,'project_proposal',$10)`,
        [this.organizationKey,id,input.operationId,fingerprint,`INQ-${id.replaceAll('-','').toUpperCase()}`,email,
          input.title,input.description,input.requestedDeadline,subject.userId]);
      await tx.query(`insert into alpha_private.ticket_central_intake_events
        (id,organization_key,intake_id,event_type,actor_kind,actor_id,occurred_at,metadata)
        values($1,$2,$3,'project_proposal_received','client',$4,now(),$5::jsonb)`,
        [randomUUID(),this.organizationKey,id,subject.userId,JSON.stringify({operationId:input.operationId})]);
      return {id};
    });
  }

  async reply(subject:Extract<TicketSubject,{kind:'client'}>,proposalId:string,raw:unknown) {
    const parsed=replySchema.safeParse(raw);
    if(!parsed.success || typeof proposalId!=='string' || !proposalId.trim() || proposalId.length>200)
      throw new TicketWorkflowError(400,'project_proposal_reply_invalid','Write a reply before sending it.');
    const {operationId,body}=parsed.data;
    try { return await this.db.transaction(async tx=>{
      const proposal=await tx.query<{status:string}>(
        `select status from alpha_private.ticket_central_intakes
          where organization_key=$1 and id=$2 and client_user_id=$3 and kind='project_proposal' for update`,
        [this.organizationKey,proposalId,subject.userId]);
      if(!proposal.rows[0]) throw new TicketWorkflowError(404,'project_proposal_not_found','This proposal is no longer available.');
      const prior=await tx.query<{event_type:string;actor_id:string|null;body:string|null}>(
        `select event_type,actor_id,metadata->>'body' as body from alpha_private.ticket_central_intake_events
          where organization_key=$1 and intake_id=$2 and metadata->>'operationId'=$3`,
        [this.organizationKey,proposalId,operationId]);
      if(prior.rows[0]) {
        const row=prior.rows[0];
        if(row.event_type==='proposal_clarification_replied' && row.actor_id===subject.userId && row.body===body)
          return {id:proposalId,operationId,status:'pending' as const};
        throw new TicketWorkflowError(409,'project_proposal_reply_conflict','This reply ID was already used. Refresh the proposal and try again.');
      }
      if(proposal.rows[0].status!=='awaiting_client')
        throw new TicketWorkflowError(409,'project_proposal_reply_not_requested','Your project manager is not waiting for a reply on this proposal.');
      await tx.query(
        `insert into alpha_private.ticket_central_intake_events
          (id,organization_key,intake_id,event_type,actor_kind,actor_id,occurred_at,metadata)
         values($1,$2,$3,'proposal_clarification_replied','client',$4,now(),$5::jsonb)`,
        [randomUUID(),this.organizationKey,proposalId,subject.userId,JSON.stringify({operationId,body})]);
      const updated=await tx.query<{id:string}>(
        `update alpha_private.ticket_central_intakes set status='pending'
          where organization_key=$1 and id=$2 and client_user_id=$3 and status='awaiting_client' returning id`,
        [this.organizationKey,proposalId,subject.userId]);
      if(updated.rows.length!==1) throw new Error('Client proposal reply could not be saved.');
      return {id:proposalId,operationId,status:'pending' as const};
    }); } catch(error) {
      if(isTransactionOutcomeUnknown(error)) throw new DatabaseCommitError(error);
      throw error;
    }
  }
}

function parseClarificationMessages(value:unknown) {
  let rows=value;
  if(typeof rows==='string') {
    try { rows=JSON.parse(rows) as unknown; } catch { throw new Error('Project proposal messages are invalid.'); }
  }
  if(rows==null) return [];
  if(!Array.isArray(rows) || rows.length>100) throw new Error('Project proposal messages are invalid.');
  return rows.map((raw:unknown)=>{
    if(!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('Project proposal message is invalid.');
    const row=raw as Record<string,unknown>;
    if(typeof row.id!=='string' || !row.id.trim() || (row.author!=='pm' && row.author!=='client')
      || typeof row.body!=='string' || !row.body.trim() || row.body.length>4000
      || typeof row.createdAt!=='string' || !Number.isFinite(Date.parse(row.createdAt)))
      throw new Error('Project proposal message is invalid.');
    return {id:row.id,author:row.author,body:row.body,createdAt:new Date(row.createdAt).toISOString()};
  });
}
