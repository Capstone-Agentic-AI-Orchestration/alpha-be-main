import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const inputSchema = z.object({ schemaVersion:z.literal(1), operationId:z.string().uuid(),
  title:z.string().trim().min(1).max(160), description:z.string().trim().min(1).max(6000),
  requestedDeadline:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
  }).nullable(),
}).strict();
export class ClientProjectProposals {
  constructor(private readonly db:TransactionalSql, private readonly organizationKey:string) {}
  async list(subject:Extract<TicketSubject,{kind:'client'}>) {
    const result=await this.db.query<{id:string;title:string;description:string;requested_deadline:string|null;submitted_at:Date|string;status:'pending'|'declined'}>(
      `select id,title,description,requested_deadline,submitted_at,status from alpha_private.ticket_central_intakes
       where organization_key=$1 and client_user_id=$2 and kind='project_proposal' and status in ('pending','declined')
       order by submitted_at desc,id desc`, [this.organizationKey,subject.userId]);
    return {items:result.rows.map(row=>({id:row.id,title:row.title,description:row.description,
      requestedDeadline:row.requested_deadline,submittedAt:new Date(row.submitted_at).toISOString(),status:row.status}))};
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
}
