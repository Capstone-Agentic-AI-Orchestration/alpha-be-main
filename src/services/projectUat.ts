import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql, TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { PostgresClientProjectPortal, type ProjectTarget } from './clientProjectPortal.js';
import type { ProjectUatBuilds } from './projectUatBuilds.js';
import type { TicketDocumentObjectStore } from '../store/ticketDocumentStore.js';
import { buildKey, parseUat, uatCommandSchema, uatCreateSchema, uatError, uatId, uatOutcome, uatResultSchema, uatSubmitSchema,
  type UatBuild, type UatLifecycle, type UatResult } from '../ticketing/projectUat.js';

interface RoundRow {
  id:string; client_user_id:string; number:number; title:string; status:UatLifecycle; version:number;
  build:UatBuild; build_key:string; reviewed_by:string|null; reviewed_at:Date|null; reviewed_build_key:string|null;
  outcome:string|null; created_at:Date; published_at:Date|null; submitted_at:Date|null;
}
export interface UatReceipt {roundId:string;operationId:string;version:number;outcome?:string;evidenceId?:string;
  itemId?:string;classification?:string;note?:string;issueId?:string|null}
const scope = (target:ProjectTarget) => [target.workspaceId,target.projectId];
const actor = (subject:TicketSubject) => subject.kind==='client' ? 'client' : 'pm';
const absent = () => uatError(404,'uat_review_unavailable','This review is unavailable.');
const pmOnly = (subject:TicketSubject) => { if(subject.kind!=='internal') absent(); };
const changed = () => uatError(409,'uat_version_conflict','This review changed. Reload before saving.');
function sameVersion(row:RoundRow,version:number) { if(row.version!==version) changed(); }
const iso = (value:Date|null) => value ? new Date(value).toISOString() : null;

/** Every command rechecks project, recipient grants and round revision in one SQL transaction. */
export class ProjectUat {
  constructor(private readonly db:TransactionalSql, private readonly portal:PostgresClientProjectPortal, private readonly builds:ProjectUatBuilds,
    private readonly objects:TicketDocumentObjectStore|null=null) {}

  private async authorized(target:ProjectTarget,subject:TicketSubject) {
    await this.db.transaction(sql => this.portal.authorizeProject(sql,target,subject));
  }
  async targets(target:ProjectTarget,subject:TicketSubject) {
    pmOnly(subject); await this.authorized(target,subject);
    return {items:await this.builds.targets(target)};
  }
  async preview(target:ProjectTarget,subject:TicketSubject,repository:unknown) {
    pmOnly(subject); const repo = parseUat(uatId,repository); await this.authorized(target,subject);
    const build = await this.builds.resolve(target,repo);
    await this.authorized(target,subject);
    return {build};
  }
  private async round(sql:Sql,target:ProjectTarget,subject:TicketSubject,id:string,write=false):Promise<RoundRow> {
    // Authorize project before reading recipient metadata; untrusted round IDs confer nothing.
    await this.portal.authorizeProject(sql,target,subject,write);
    const {rows} = await sql.query<RoundRow>(`select * from alpha_private.client_uat_rounds
      where workspace_id=$1 and project_id=$2 and id=$3
      and ($4::text is null or client_user_id=$4) for ${write?'update':'share'}`,
      [...scope(target),parseUat(uatId,id),subject.kind==='client'?subject.userId:null]);
    const row=rows[0]; if(!row || rows.length!==1 || (subject.kind==='client' && !row.published_at)) absent();
    await this.portal.authorizeRecipient(sql,target,subject,row.client_user_id,write);
    return row;
  }
  private async replay(sql:Sql,target:ProjectTarget,subject:TicketSubject,operationId:string,fingerprint?:string) {
    const {rows}=await sql.query<{fingerprint:string;receipt:UatReceipt;client_user_id:string}>(
      `select fingerprint,receipt,client_user_id from alpha_private.client_uat_events
       where workspace_id=$1 and project_id=$2 and actor_kind=$3 and actor_id=$4 and operation_id=$5`,
      [...scope(target),actor(subject),subject.userId,operationId]);
    const saved=rows[0]; if(!saved) return null;
    await this.portal.authorizeRecipient(sql,target,subject,saved.client_user_id);
    if(fingerprint && saved.fingerprint!==fingerprint) uatError(409,'uat_operation_conflict','This operation was used for different review details.');
    return saved.receipt;
  }
  async operation(target:ProjectTarget,subject:TicketSubject,operationId:string) {
    return this.db.transaction(async sql => {
      await this.portal.authorizeProject(sql,target,subject);
      return await this.replay(sql,target,subject,parseUat(uatId,operationId)) ?? absent();
    });
  }
  private fingerprint(action:string,input:unknown) {return createHash('sha256').update(JSON.stringify([action,input])).digest('hex');}
  private async event(sql:Sql,target:ProjectTarget,subject:TicketSubject,row:Pick<RoundRow,'id'|'client_user_id'|'version'>,
    action:string,operationId:string,fingerprint:string,extra:Partial<Omit<UatReceipt,'roundId'|'operationId'|'version'>>={}):Promise<UatReceipt> {
    const receipt:UatReceipt={roundId:row.id,operationId,version:row.version,...extra};
    await sql.query(`insert into alpha_private.client_uat_events
      (workspace_id,project_id,client_user_id,round_id,id,actor_kind,actor_id,action,operation_id,fingerprint,receipt)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [...scope(target),row.client_user_id,row.id,randomUUID(),actor(subject),subject.userId,action,operationId,fingerprint,JSON.stringify(receipt)]);
    return receipt;
  }
  async create(target:ProjectTarget,subject:TicketSubject,raw:unknown) {
    pmOnly(subject); const input=parseUat(uatCreateSchema,raw), fingerprint=this.fingerprint('create',input);
    // Retry lookup precedes provider I/O: a committed operation remains reconcilable after deployment drift.
    const saved=await this.db.transaction(async sql => {
      await this.portal.authorizeRecipient(sql,target,subject,input.clientId);
      return this.replay(sql,target,subject,input.operationId,fingerprint);
    });
    if(saved) return saved;
    const build=await this.builds.resolve(target,input.repository);
    return this.db.transaction(async sql => {
      await this.portal.authorizeRecipient(sql,target,subject,input.clientId,true);
      const replay=await this.replay(sql,target,subject,input.operationId,fingerprint); if(replay)return replay;
      const id=randomUUID();
      const {rows}=await sql.query<RoundRow>(`insert into alpha_private.client_uat_rounds
        (workspace_id,project_id,client_user_id,id,number,title,build,build_key,created_by)
        values($1,$2,$3,$4,(select coalesce(max(number),0)+1 from alpha_private.client_uat_rounds
          where workspace_id=$1 and project_id=$2 and client_user_id=$3),$5,$6,$7,$8) returning *`,
        [...scope(target),input.clientId,id,input.title,JSON.stringify(build),buildKey(build),subject.userId]);
      for(const [position,item] of input.items.entries()) await sql.query(`insert into alpha_private.client_uat_items
        (workspace_id,project_id,client_user_id,round_id,id,position,title,steps,expected_result,required)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...scope(target),input.clientId,id,randomUUID(),position,item.title,item.steps,item.expectedResult,item.required]);
      return this.event(sql,target,subject,rows[0],'created',input.operationId,fingerprint);
    });
  }
  async list(target:ProjectTarget,subject:TicketSubject,raw:unknown) {
    const query=parseUat(z.object({clientId:uatId.optional(),before:z.coerce.number().int().positive().optional()}).strict(),raw);
    return this.db.transaction(async sql => {
      const clientId=subject.kind==='client'?subject.userId:query.clientId;
      if(!clientId) uatError(400,'uat_client_required','Choose a client for this project.');
      await this.portal.authorizeRecipient(sql,target,subject,clientId);
      const {rows}=await sql.query<RoundRow>(`select * from alpha_private.client_uat_rounds where workspace_id=$1 and project_id=$2
        and client_user_id=$3 and ($4::int is null or number<$4) and ($5::boolean or published_at is not null) order by number desc limit 21`,
        [...scope(target),clientId,query.before??null,subject.kind==='internal']);
      return {items:rows.slice(0,20).map(row=>this.summary(row,subject)),nextBefore:rows.length>20?rows[19].number:null};
    });
  }
  async edit(target:ProjectTarget,subject:TicketSubject,id:string,raw:unknown) {
    pmOnly(subject);
    const input=parseUat(uatCreateSchema.pick({operationId:true,title:true,items:true}).extend({expectedVersion:z.number().int().nonnegative()}).strict(),raw);
    const fingerprint=this.fingerprint(`edit:${id}`,input);
    return this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id,true);
      const replay=await this.replay(sql,target,subject,input.operationId,fingerprint);if(replay)return replay;
      sameVersion(row,input.expectedVersion);
      if(row.status!=='draft')uatError(409,'uat_round_locked','Published review definitions are frozen. Create a new round.');
      await sql.query('delete from alpha_private.client_uat_items where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4',[...scope(target),row.client_user_id,id]);
      for(const [position,item]of input.items.entries())await sql.query(`insert into alpha_private.client_uat_items
        (workspace_id,project_id,client_user_id,round_id,id,position,title,steps,expected_result,required)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [...scope(target),row.client_user_id,id,randomUUID(),position,item.title,item.steps,item.expectedResult,item.required]);
      await sql.query(`update alpha_private.client_uat_rounds set title=$5,version=version+1,updated_at=now(),reviewed_by=null,reviewed_at=null,reviewed_build_key=null
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`,[...scope(target),row.client_user_id,id,input.title]);
      return this.event(sql,target,subject,{...row,version:row.version+1},'draft_edited',input.operationId,fingerprint);
    });
  }
  private summary(row:RoundRow,subject:TicketSubject) {
    return {id:row.id,number:row.number,title:row.title,status:row.status,version:row.version,outcome:row.outcome,
      createdAt:iso(row.created_at),publishedAt:iso(row.published_at),submittedAt:iso(row.submitted_at),reviewed:row.reviewed_build_key===row.build_key,
      ...(subject.kind==='internal'?{clientId:row.client_user_id,reviewedBy:row.reviewed_by,reviewedAt:iso(row.reviewed_at)}:{})};
  }
  async get(target:ProjectTarget,subject:TicketSubject,id:string) {
    return this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id);
      const {rows:items}=await sql.query<{id:string;title:string;steps:string;expected_result:string;required:boolean;status:UatResult['status']|null;notes:string|null;reproduction:string|null;device:string|null}>(
        `select i.*,r.status,r.notes,r.reproduction,r.device from alpha_private.client_uat_items i
         left join alpha_private.client_uat_results r on (r.workspace_id,r.project_id,r.client_user_id,r.round_id,r.item_id)=
           (i.workspace_id,i.project_id,i.client_user_id,i.round_id,i.id)
         where i.workspace_id=$1 and i.project_id=$2 and i.client_user_id=$3 and i.round_id=$4 order by i.position`,[...scope(target),row.client_user_id,row.id]);
      const {rows:events}=await sql.query<{action:string;actor_kind:string;created_at:Date;receipt:Record<string,unknown>}>(`select action,actor_kind,created_at,receipt from alpha_private.client_uat_events
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 order by created_at desc,id desc limit 100`,[...scope(target),row.client_user_id,row.id]);
      const {rows:evidence}=await sql.query<{id:string;item_id:string;filename:string;content_type:string;byte_length:number}>(`select id,item_id,filename,content_type,byte_length
        from alpha_private.client_uat_evidence where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 and status='available' order by created_at`,[...scope(target),row.client_user_id,row.id]);
      return {...this.summary(row,subject),preview:{url:row.build.frontend.url,branch:'uat',embeddable:row.build.embeddable,reason:row.build.reason},
        evidenceEnabled:this.objects!==null,evidence:evidence.map(item=>({id:item.id,itemId:item.item_id,filename:item.filename,contentType:item.content_type,byteLength:item.byte_length})),
        ...(subject.kind==='internal'?{build:row.build}:{}),
        items:items.map(item=>({id:item.id,title:item.title,steps:item.steps,expectedResult:item.expected_result,required:item.required,
          result:{status:item.status??'not_tested',notes:item.notes??'',reproduction:item.reproduction??'',device:item.device??''}})),
        ...(subject.kind==='internal'?{triage:events.filter(event=>event.action==='triaged').map(event=>event.receipt)}:{}),
        events:events.map(event=>({action:event.action,author:event.actor_kind,createdAt:iso(event.created_at)}))};
    });
  }
  private async freshBuild(target:ProjectTarget,subject:TicketSubject,id:string) {
    const row=await this.db.transaction(sql=>this.round(sql,target,subject,id));
    const build=await this.builds.resolve(target,row.build.frontend.repository);
    if(buildKey(build)!==row.build_key) uatError(409,'uat_build_changed','UAT changed. The project manager must review the new build and publish a new round.');
    return row.build_key;
  }
  async command(target:ProjectTarget,subject:TicketSubject,id:string,raw:unknown) {
    pmOnly(subject); const input=parseUat(uatCommandSchema,raw), fingerprint=this.fingerprint(`command:${id}`,input);
    const saved=await this.operationOrNull(target,subject,input.operationId,fingerprint); if(saved)return saved;
    const key=input.action==='withdraw'?null:await this.freshBuild(target,subject,id);
    return this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id,true);
      const replay=await this.replay(sql,target,subject,input.operationId,fingerprint); if(replay)return replay;
      sameVersion(row,input.expectedVersion);
      if(key && key!==row.build_key) changed();
      if(input.action==='withdraw') {
        if(!['draft','published'].includes(row.status)) uatError(409,'uat_round_locked','Only an open review can be withdrawn.');
      } else if(row.status!=='draft') uatError(409,'uat_round_locked','Create a new draft to review a new build.');
      if(input.action==='publish' && (!row.reviewed_by || row.reviewed_build_key!==row.build_key)) {
        uatError(409,'uat_pm_review_required','Review this UAT preview and mark it ready before client handoff.');
      }
      if(input.action==='publish') await sql.query(`update alpha_private.client_uat_rounds set status='superseded',version=version+1,updated_at=now()
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and status='published'`,[...scope(target),row.client_user_id]);
      await sql.query(`update alpha_private.client_uat_rounds set version=version+1,updated_at=now(),
        status=case when $5='publish' then 'published' when $5='withdraw' then 'withdrawn' else status end,
        reviewed_by=case when $5='ready' then $6 else reviewed_by end,
        reviewed_at=case when $5='ready' then now() else reviewed_at end,
        reviewed_build_key=case when $5='ready' then build_key else reviewed_build_key end,
        published_at=case when $5='publish' then now() else published_at end
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`,[...scope(target),row.client_user_id,id,input.action,subject.userId]);
      return this.event(sql,target,subject,{...row,version:row.version+1},input.action,input.operationId,fingerprint);
    });
  }
  private async operationOrNull(target:ProjectTarget,subject:TicketSubject,id:string,fingerprint:string) {
    return this.db.transaction(async sql=>{await this.portal.authorizeProject(sql,target,subject);return this.replay(sql,target,subject,id,fingerprint);});
  }
  async result(target:ProjectTarget,subject:TicketSubject,id:string,itemId:string,raw:unknown) {
    if(subject.kind!=='client') absent();
    const input=parseUat(uatResultSchema,raw), fingerprint=this.fingerprint(`result:${id}:${itemId}`,input);
    const saved=await this.operationOrNull(target,subject,input.operationId,fingerprint);if(saved)return saved;
    const key=await this.freshBuild(target,subject,id);
    return this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id,true);
      const replay=await this.replay(sql,target,subject,input.operationId,fingerprint);if(replay)return replay;
      sameVersion(row,input.expectedVersion);
      if(row.status!=='published'||key!==row.build_key) uatError(409,'uat_round_locked','This review is no longer open.');
      const params=[...scope(target),row.client_user_id,id,parseUat(uatId,itemId)];
      const exists=await sql.query('select id from alpha_private.client_uat_items where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 and id=$5',params);
      if(!exists.rows.length)absent();
      await sql.query(`insert into alpha_private.client_uat_results(workspace_id,project_id,client_user_id,round_id,item_id,status,notes,reproduction,device)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(workspace_id,project_id,client_user_id,round_id,item_id)
        do update set status=excluded.status,notes=excluded.notes,reproduction=excluded.reproduction,device=excluded.device,updated_at=now()`,
        [...params,input.status,input.notes,input.reproduction,input.device]);
      await sql.query('update alpha_private.client_uat_rounds set version=version+1,updated_at=now() where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4',params.slice(0,4));
      return this.event(sql,target,subject,{...row,version:row.version+1},'result_saved',input.operationId,fingerprint);
    });
  }
  async submit(target:ProjectTarget,subject:TicketSubject,id:string,raw:unknown) {
    if(subject.kind!=='client')absent();
    const input=parseUat(uatSubmitSchema,raw), fingerprint=this.fingerprint(`submit:${id}`,input);
    const saved=await this.operationOrNull(target,subject,input.operationId,fingerprint);if(saved)return saved;
    const key=await this.freshBuild(target,subject,id);
    return this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id,true);
      const replay=await this.replay(sql,target,subject,input.operationId,fingerprint);if(replay)return replay;
      sameVersion(row,input.expectedVersion);
      if(row.status!=='published'||key!==row.build_key)uatError(409,'uat_round_locked','This review is no longer open.');
      const {rows}=await sql.query<{required:boolean;status:UatResult['status']}>(`select i.required,coalesce(r.status,'not_tested') as status
        from alpha_private.client_uat_items i left join alpha_private.client_uat_results r
        on (r.workspace_id,r.project_id,r.client_user_id,r.round_id,r.item_id)=(i.workspace_id,i.project_id,i.client_user_id,i.round_id,i.id)
        where i.workspace_id=$1 and i.project_id=$2 and i.client_user_id=$3 and i.round_id=$4`,[...scope(target),row.client_user_id,id]);
      const outcome=uatOutcome(rows);
      await sql.query(`update alpha_private.client_uat_rounds set status='submitted',outcome=$5,submitted_at=now(),updated_at=now(),version=version+1
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`,[...scope(target),row.client_user_id,id,outcome]);
      return this.event(sql,target,subject,{...row,version:row.version+1},'submitted',input.operationId,fingerprint,{outcome});
    });
  }

  async triage(target:ProjectTarget,subject:TicketSubject,id:string,itemId:string,raw:unknown) {
    pmOnly(subject);
    const input=parseUat(z.object({operationId:uatId,expectedVersion:z.number().int().nonnegative(),
      classification:z.enum(['correction','clarification','new_scope']),note:z.string().trim().min(1).max(4000),issueId:uatId.nullable()}).strict(),raw);
    const fingerprint=this.fingerprint(`triage:${id}:${itemId}`,input);
    return this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id,true);
      const replay=await this.replay(sql,target,subject,input.operationId,fingerprint);if(replay)return replay;
      sameVersion(row,input.expectedVersion);
      const result=await sql.query(`select item_id from alpha_private.client_uat_results where workspace_id=$1 and project_id=$2
        and client_user_id=$3 and round_id=$4 and item_id=$5 and status in ('failed','blocked')`,[...scope(target),row.client_user_id,id,itemId]);
      if(!result.rows.length)uatError(409,'uat_triage_unavailable','Choose a failed or blocked check.');
      if(input.issueId){const issue=await sql.query('select id from public.issues where workspace_id=$1 and project_id=$2 and id=$3 for share',[...scope(target),input.issueId]);if(!issue.rows.length)absent();}
      // Triage appends a private PM event; it never mutates the client's verdict or authorizes work.
      return this.event(sql,target,subject,row,'triaged',input.operationId,fingerprint,{itemId,classification:input.classification,note:input.note,issueId:input.issueId});
    });
  }

  async uploadEvidence(target:ProjectTarget,subject:TicketSubject,id:string,itemId:string,raw:unknown,bytes:Uint8Array) {
    if(subject.kind!=='client')absent();
    const input=parseUat(z.object({operationId:uatId,filename:z.string().trim().min(1).max(200),contentType:z.enum(['image/png','image/jpeg'])}).strict(),raw);
    if(!this.objects)uatError(503,'uat_evidence_unavailable','Private screenshot storage is not configured. You can still report the problem in text.');
    if(!(bytes instanceof Uint8Array)||bytes.length<8||bytes.length>3*1024*1024||/[\\/\u0000-\u001f]/.test(input.filename))uatError(400,'invalid_uat_evidence','Choose a PNG or JPEG screenshot up to 3 MB.');
    const png=[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if((input.contentType==='image/png'&&(!png||!input.filename.toLowerCase().endsWith('.png')))
      ||(input.contentType==='image/jpeg'&&(!jpeg||!(/\.jpe?g$/i.test(input.filename)))))uatError(400,'invalid_uat_evidence','The screenshot content and file type do not match.');
    const sha=createHash('sha256').update(bytes).digest('hex'),fingerprint=this.fingerprint(`evidence:${id}:${itemId}`,[input,sha]);
    const replay=await this.operationOrNull(target,subject,input.operationId,fingerprint);if(replay)return replay;
    const key=await this.freshBuild(target,subject,id);
    const prepared=await this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id,true);if(row.status!=='published'||row.build_key!==key)uatError(409,'uat_round_locked','This review is no longer open.');
      const params=[...scope(target),row.client_user_id,id,itemId];
      const item=await sql.query('select id from alpha_private.client_uat_items where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 and id=$5',params);if(!item.rows.length)absent();
      const existing=await sql.query<{id:string;storage_path:string;fingerprint:string}>(`select id,storage_path,fingerprint from alpha_private.client_uat_evidence
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and operation_id=$4`,[...scope(target),row.client_user_id,input.operationId]);
      if(existing.rows[0]){if(existing.rows[0].fingerprint!==fingerprint)uatError(409,'uat_operation_conflict','This operation was used for another screenshot.');return existing.rows[0];}
      const count=await sql.query<{count:string}>(`select count(*) from alpha_private.client_uat_evidence where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 and item_id=$5`,params);
      if(Number(count.rows[0].count)>=10)uatError(409,'uat_evidence_limit','This check already has 10 screenshots.');
      const evidenceId=randomUUID(),namespace=createHash('sha256').update(JSON.stringify([...scope(target),row.client_user_id,id])).digest('hex');
      const storagePath=`uat-${namespace}/${createHash('sha256').update(itemId).digest('hex')}/${evidenceId}`;
      await sql.query(`insert into alpha_private.client_uat_evidence(workspace_id,project_id,client_user_id,round_id,item_id,id,operation_id,fingerprint,filename,content_type,byte_length,sha256,storage_path)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[...params,evidenceId,input.operationId,fingerprint,input.filename,input.contentType,bytes.length,sha,storagePath]);
      return {id:evidenceId,storage_path:storagePath,fingerprint};
    });
    try{await this.objects.put(prepared.storage_path,bytes,input.contentType);const stored=await this.objects.get(prepared.storage_path);
      if(createHash('sha256').update(stored).digest('hex')!==sha)throw new Error('Integrity check failed');
    }catch{uatError(503,'uat_evidence_storage_failed','The screenshot upload could not be confirmed. Retry the same file.');}
    await this.freshBuild(target,subject,id);
    return this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id,true);
      const saved=await this.replay(sql,target,subject,input.operationId,fingerprint);if(saved)return saved;
      if(row.status!=='published'||row.build_key!==key)uatError(409,'uat_round_locked','This review is no longer open.');
      await sql.query(`update alpha_private.client_uat_evidence set status='available' where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 and id=$5`,[...scope(target),row.client_user_id,id,prepared.id]);
      return this.event(sql,target,subject,row,'evidence_added',input.operationId,fingerprint,{evidenceId:prepared.id});
    });
  }

  async downloadEvidence(target:ProjectTarget,subject:TicketSubject,id:string,evidenceId:string) {
    const stored=await this.db.transaction(async sql=>{
      const row=await this.round(sql,target,subject,id);
      const result=await sql.query<{filename:string;content_type:string;byte_length:number;sha256:string;storage_path:string}>(`select filename,content_type,byte_length,sha256,storage_path
        from alpha_private.client_uat_evidence where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 and id=$5 and status='available'`,[...scope(target),row.client_user_id,id,evidenceId]);
      return result.rows[0]??absent();
    });
    if(!this.objects)uatError(503,'uat_evidence_unavailable','Screenshot storage is unavailable.');
    let bytes:Uint8Array;try{bytes=await this.objects.get(stored.storage_path);}catch{uatError(503,'uat_evidence_unavailable','The screenshot is temporarily unavailable.');}
    if(bytes.length!==stored.byte_length||createHash('sha256').update(bytes).digest('hex')!==stored.sha256)uatError(503,'uat_evidence_unavailable','The screenshot could not be verified.');
    await this.db.transaction(sql=>this.round(sql,target,subject,id));
    return {filename:stored.filename,contentType:stored.content_type,bytes};
  }
}
