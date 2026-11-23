import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql, TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import {
  loadStageSummary, lockStageRow, type ContractTerms, type PocFeature, type StageSummary, type StageThread,
} from '../store/clientProjectStageStore.js';
import { defaultContractTerms, type ContractSource } from './projectContractTerms.js';
import { canTransition, contentHash, type ProjectStage } from './projectStageRules.js';
import type { PostgresClientProjectPortal, ProjectTarget } from './clientProjectPortal.js';

/**
 * A project's stages in the PM–client conversation: POC → Contract →
 * Development → Completed (see projectStageRules.ts and the migration
 * 20261125120000_client_project_stages.sql).
 *
 * Every call authorizes through the project conversation's own rule
 * (`authorizeThread`), so a stage is visible to exactly the people who can read
 * that conversation. Every write is one transaction that locks the thread's
 * stage row, replays a repeated operation from its receipt, checks the stage,
 * acts, records one stage event (which the conversation timeline shows) and
 * returns the new summary.
 */

const id = z.string().min(1).max(200).refine(v => v.trim() === v);
const text = (max: number) => z.string().trim().max(max);
const fullName = z.string().trim().min(2).max(200);
const command = z.object({ schemaVersion: z.literal(1), operationId: id });
const feature = z.object({ title: z.string().trim().min(1).max(300), detail: text(2000).default('') }).strict();
const pocDraftSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(8000),
  features: z.array(feature).min(1).max(100),
  screens: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
  outOfScope: text(4000).default(''),
  note: text(4000).default(''),
}).strict();
const startingStageSchema = command.extend({
  stage: z.enum(['poc', 'development', 'completed']),
  revisionsUsed: z.number().int().min(0).max(20).default(0),
  revisionLimit: z.number().int().min(0).max(20).default(3),
}).strict();
const plainCommand = command.strict();
const changesSchema = command.extend({ body: z.string().trim().min(1).max(4000) }).strict();
const signOffSchema = command.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/), fullName, consent: z.literal(true) }).strict();
const countersignSchema = command.extend({ fullName }).strict();
const clause = z.object({ title: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(8000) }).strict();
const contractDraftSchema = z.object({
  deliverables: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  clauses: z.array(clause).min(1).max(30).optional(),
  notes: text(8000).optional(),
}).strict();

function invalid(): never { throw new TicketWorkflowError(400, 'invalid_stage_input', 'Check the details and try again.'); }
function missing(): never { throw new TicketWorkflowError(404, 'client_conversation_unavailable', 'This conversation is unavailable.'); }
export function parseStageInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}
function stageMismatch(message: string): never { throw new TicketWorkflowError(409, 'stage_mismatch', message); }

export type StageAction =
  | 'stage_set' | 'poc_published' | 'poc_changes_requested' | 'poc_approved'
  | 'contract_issued' | 'contract_voided' | 'contract_signed' | 'contract_countersigned'
  | 'build_shared' | 'round_submitted' | 'round_classified'
  | 'quote_requested' | 'quote_sent' | 'quote_accepted' | 'quote_declined'
  | 'final_delivered' | 'final_accepted';

export interface StageReceipt { operationId: string; action: StageAction; refId: string | null; version: number }
export interface StageResult { receipt: StageReceipt; stage: StageSummary }

/** What one write did: the event to record, and the stage to move to, if any. */
export interface StageChange { refId: string | null; body?: string | null; metadata?: Record<string, unknown>; moveTo?: ProjectStage }
export interface StageContext { sql: Sql; thread: StageThread; stage: ProjectStage; subject: TicketSubject; actor: 'pm' | 'client' }

export class ClientProjectStages {
  constructor(protected readonly db: TransactionalSql, protected readonly portal: PostgresClientProjectPortal) {}

  /** The stage track, as the reader may see it. */
  async summary(target: ProjectTarget, subject: TicketSubject, clientId?: unknown): Promise<StageSummary> {
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, false);
      return loadStageSummary(sql, { ...target, clientId: client }, audience(subject));
    });
  }

  /** Look up an earlier write by its operation id (after a lost response). */
  async operation(target: ProjectTarget, subject: TicketSubject, operationId: unknown, clientId?: unknown): Promise<StageResult> {
    const operation = parseStageInput(id, operationId);
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, false);
      const thread = { ...target, clientId: client };
      const { rows } = await sql.query<{ receipt: StageReceipt }>(`select receipt from alpha_private.client_project_stage_events
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and actor_kind=$4 and actor_id=$5 and operation_id=$6`,
      [thread.workspaceId, thread.projectId, thread.clientId, audience(subject), subject.userId, operation]);
      if (!rows[0]) missing();
      return { receipt: rows[0].receipt, stage: await loadStageSummary(sql, thread, audience(subject)) };
    });
  }

  /** PM: where a project that predates stages starts. Only once, while it is unset. */
  async setStartingStage(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown) {
    const value = parseStageInput(startingStageSchema, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'stage_set', value, async ({ sql, thread, stage }) => {
      if (stage !== 'unset') stageMismatch('This project’s stage is already set.');
      await sql.query(`update alpha_private.client_project_stages set revision_limit=$4,revisions_offset=$5
        where workspace_id=$1 and project_id=$2 and client_user_id=$3`,
      [thread.workspaceId, thread.projectId, thread.clientId, value.revisionLimit, value.stage === 'development' ? value.revisionsUsed : 0]);
      return { refId: null, metadata: { stage: value.stage }, moveTo: value.stage };
    });
  }

  /** PM: create or replace the one POC draft. Not shown to the client until published. */
  async savePocDraft(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown): Promise<StageSummary> {
    requireActor(subject, 'pm');
    const value = parseStageInput(pocDraftSchema, input);
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, true);
      const thread = { ...target, clientId: client };
      const row = await lockStageRow(sql, thread, true);
      if (row.stage !== 'poc') stageMismatch('The proof of concept can only change during the POC stage.');
      const values = [thread.workspaceId, thread.projectId, thread.clientId, value.title, value.summary,
        JSON.stringify(value.features), JSON.stringify(value.screens), value.outOfScope, value.note];
      const { rows: updated } = await sql.query(`update alpha_private.client_project_poc_versions set title=$4,summary=$5,features=$6::jsonb,
          screens=$7::jsonb,out_of_scope=$8,note=$9,updated_at=now()
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and status='draft' returning id`, values);
      if (!updated.length) {
        await sql.query(`insert into alpha_private.client_project_poc_versions(workspace_id,project_id,client_user_id,id,number,status,
            title,summary,features,screens,out_of_scope,note,created_by)
          select $1,$2,$3,$10,coalesce(max(number),0)+1,'draft',$4,$5,$6::jsonb,$7::jsonb,$8,$9,$11
          from alpha_private.client_project_poc_versions where workspace_id=$1 and project_id=$2 and client_user_id=$3`,
        [...values, randomUUID(), subject.userId]);
      }
      await bumpVersion(sql, thread);
      return loadStageSummary(sql, thread, 'pm');
    });
  }

  /** PM: publish the draft as the next POC version; earlier versions are superseded. */
  async publishPoc(target: ProjectTarget, subject: TicketSubject, pocId: unknown, input: unknown, clientId?: unknown) {
    const poc = parseStageInput(id, pocId);
    const value = parseStageInput(plainCommand, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'poc_published', { poc }, async ({ sql, thread, stage }) => {
      if (stage !== 'poc') stageMismatch('A proof of concept can only be shared during the POC stage.');
      const { rows } = await sql.query<{ number: number; title: string; summary: string; features: unknown; screens: unknown; out_of_scope: string; note: string }>(
        `select number,title,summary,features,screens,out_of_scope,note from alpha_private.client_project_poc_versions
         where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4 and status='draft' for update`, [...threadParams(thread), poc]);
      const draft = rows[0];
      if (!draft) stageMismatch('This draft was already shared. Refresh to see the latest version.');
      await sql.query(`update alpha_private.client_project_poc_versions set status='superseded',updated_at=now()
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and status in ('published','changes_requested')`, threadParams(thread));
      const hash = pocHash(draft);
      await sql.query(`update alpha_private.client_project_poc_versions set status='published',content_hash=$5,published_at=now(),updated_at=now()
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), poc, hash]);
      return { refId: poc, metadata: { number: draft.number } };
    });
  }

  /** Client: ask for changes to the shared POC. Unlimited during the POC stage. */
  async requestPocChanges(target: ProjectTarget, subject: TicketSubject, pocId: unknown, input: unknown) {
    const poc = parseStageInput(id, pocId);
    const value = parseStageInput(changesSchema, input);
    return this.mutate(target, subject, undefined, 'client', value.operationId, 'poc_changes_requested', { poc, body: value.body },
      async ({ sql, thread, stage }) => {
        if (stage !== 'poc') stageMismatch('The proof of concept is already approved.');
        const number = await this.publishedPoc(sql, thread, poc);
        await sql.query(`update alpha_private.client_project_poc_versions set status='changes_requested',updated_at=now()
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), poc]);
        return { refId: poc, body: value.body, metadata: { number } };
      });
  }

  /** Client: approve exactly the POC version they read. Moves the project to the contract stage. */
  async approvePoc(target: ProjectTarget, subject: TicketSubject, pocId: unknown, input: unknown) {
    const poc = parseStageInput(id, pocId);
    const value = parseStageInput(signOffSchema, input);
    return this.mutate(target, subject, undefined, 'client', value.operationId, 'poc_approved',
      { poc, contentHash: value.contentHash, fullName: value.fullName }, async ({ sql, thread, stage }) => {
        if (stage !== 'poc') stageMismatch('The proof of concept is already approved.');
        const { rows } = await sql.query<{ number: number; content_hash: string }>(`select number,content_hash
          from alpha_private.client_project_poc_versions
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4 and status='published' for update`, [...threadParams(thread), poc]);
        if (!rows[0]) stageMismatch('This version is no longer the one waiting for review. Refresh to see the latest.');
        if (rows[0].content_hash !== value.contentHash) {
          throw new TicketWorkflowError(409, 'poc_changed', 'The proof of concept changed while you were reading it. Review the latest version.');
        }
        await sql.query(`update alpha_private.client_project_poc_versions set status='approved',approved_at=now(),approved_name=$5,
            approved_hash=content_hash,updated_at=now()
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), poc, value.fullName]);
        await sql.query(`delete from alpha_private.client_project_poc_versions
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and status='draft'`, threadParams(thread));
        return { refId: poc, metadata: { number: rows[0].number, name: value.fullName }, moveTo: 'contract' };
      });
  }

  /**
   * PM: create the contract draft from the approved POC (first call), or edit
   * its deliverables, clauses and notes. The scope and revision limit always
   * come from the approved POC and the stage, never from the request.
   */
  async saveContractDraft(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown): Promise<StageSummary> {
    requireActor(subject, 'pm');
    const value = parseStageInput(contractDraftSchema, input ?? {});
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, true);
      const thread = { ...target, clientId: client };
      const row = await lockStageRow(sql, thread, true);
      if (row.stage !== 'contract') stageMismatch('The contract can only be prepared during the contract stage.');
      const { rows: live } = await sql.query<{ id: string; status: string; terms: ContractTerms }>(`select id,status,terms
        from alpha_private.client_project_contracts where workspace_id=$1 and project_id=$2 and client_user_id=$3 and status<>'void' for update`,
      threadParams(thread));
      if (live[0] && live[0].status !== 'draft') stageMismatch('The contract was already issued. Withdraw it first to change it.');
      const base = live[0]?.terms ?? defaultContractTerms(await this.contractSource(sql, thread, row.revision_limit));
      const terms: ContractTerms = { ...base, deliverables: value.deliverables ?? base.deliverables,
        clauses: value.clauses ?? base.clauses, notes: value.notes ?? base.notes };
      if (live[0]) {
        await sql.query(`update alpha_private.client_project_contracts set terms=$5::jsonb,updated_at=now()
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), live[0].id, JSON.stringify(terms)]);
      } else {
        await sql.query(`insert into alpha_private.client_project_contracts(workspace_id,project_id,client_user_id,id,poc_version_id,status,terms,created_by)
          select $1,$2,$3,$4,id,'draft',$5::jsonb,$6 from alpha_private.client_project_poc_versions
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and status='approved'`,
        [...threadParams(thread), randomUUID(), JSON.stringify(terms), subject.userId]);
      }
      await bumpVersion(sql, thread);
      return loadStageSummary(sql, thread, 'pm');
    });
  }

  /** PM: issue the draft for signing. Its text is fixed from here on. */
  async issueContract(target: ProjectTarget, subject: TicketSubject, contractId: unknown, input: unknown, clientId?: unknown) {
    const contract = parseStageInput(id, contractId);
    const value = parseStageInput(plainCommand, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'contract_issued', { contract }, async ({ sql, thread, stage, subject: pm }) => {
      if (stage !== 'contract') stageMismatch('The contract can only be issued during the contract stage.');
      const terms = await this.contractTerms(sql, thread, contract, 'draft', 'This contract was already issued. Refresh to see it.');
      await sql.query(`update alpha_private.client_project_contracts set status='issued',content_hash=$5,issued_by=$6,issued_at=now(),updated_at=now()
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), contract, contentHash(terms), pm.userId]);
      return { refId: contract };
    });
  }

  /** PM: withdraw an issued contract the client has not signed, to correct it. A new draft starts from the same POC. */
  async voidContract(target: ProjectTarget, subject: TicketSubject, contractId: unknown, input: unknown, clientId?: unknown) {
    const contract = parseStageInput(id, contractId);
    const value = parseStageInput(plainCommand, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'contract_voided', { contract }, async ({ sql, thread, stage }) => {
      if (stage !== 'contract') stageMismatch('Only a contract waiting for signatures can be withdrawn.');
      await this.contractTerms(sql, thread, contract, 'issued', 'Only an issued contract the client has not signed can be withdrawn.');
      await sql.query(`update alpha_private.client_project_contracts set status='void',voided_at=now(),updated_at=now()
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), contract]);
      return { refId: contract };
    });
  }

  /** Client: sign exactly the contract text they read. */
  async signContract(target: ProjectTarget, subject: TicketSubject, contractId: unknown, input: unknown) {
    const contract = parseStageInput(id, contractId);
    const value = parseStageInput(signOffSchema, input);
    return this.mutate(target, subject, undefined, 'client', value.operationId, 'contract_signed',
      { contract, contentHash: value.contentHash, fullName: value.fullName }, async ({ sql, thread, stage }) => {
        if (stage !== 'contract') stageMismatch('This contract is no longer waiting for your signature.');
        const terms = await this.contractTerms(sql, thread, contract, 'issued', 'This contract is no longer waiting for your signature. Refresh to see the latest.');
        if (contentHash(terms) !== value.contentHash) {
          throw new TicketWorkflowError(409, 'contract_changed', 'The contract changed while you were reading it. Review the latest version.');
        }
        await sql.query(`update alpha_private.client_project_contracts set status='client_signed',client_signed_name=$5,client_signed_at=now(),
            client_signed_hash=content_hash,updated_at=now()
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), contract, value.fullName]);
        return { refId: contract, metadata: { name: value.fullName } };
      });
  }

  /** PM: countersign the contract the client signed. Development starts. */
  async countersignContract(target: ProjectTarget, subject: TicketSubject, contractId: unknown, input: unknown, clientId?: unknown) {
    const contract = parseStageInput(id, contractId);
    const value = parseStageInput(countersignSchema, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'contract_countersigned', { contract, fullName: value.fullName },
      async ({ sql, thread, stage, subject: pm }) => {
        if (stage !== 'contract') stageMismatch('This contract is not waiting for your signature.');
        await this.contractTerms(sql, thread, contract, 'client_signed', 'The client has not signed this contract yet.');
        await sql.query(`update alpha_private.client_project_contracts set status='countersigned',pm_signed_by=$5,pm_signed_name=$6,
            pm_signed_at=now(),updated_at=now()
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), contract, pm.userId, value.fullName]);
        return { refId: contract, metadata: { name: value.fullName }, moveTo: 'development' };
      });
  }

  /** A contract's terms, locked, when it is in `status`; otherwise a stage mismatch with `message`. */
  protected async contractTerms(sql: Sql, thread: StageThread, contract: string, status: string, message: string): Promise<ContractTerms> {
    const { rows } = await sql.query<{ terms: ContractTerms }>(`select terms from alpha_private.client_project_contracts
      where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4 and status=$5 for update`, [...threadParams(thread), contract, status]);
    if (!rows[0]) stageMismatch(message);
    return rows[0].terms;
  }

  /** What the first contract draft is made from: the approved POC, the project and the client's names. */
  protected async contractSource(sql: Sql, thread: StageThread, revisionLimit: number): Promise<ContractSource> {
    const { rows } = await sql.query<{ number: number; title: string; summary: string; features: PocFeature[]; screens: string[];
      out_of_scope: string; project_name: string; client_name: string | null }>(`select v.number,v.title,v.summary,v.features,v.screens,v.out_of_scope,
        p.name as project_name,sg.display_name as client_name
      from alpha_private.client_project_poc_versions v
      join public.projects p on p.workspace_id=v.workspace_id and p.id=v.project_id
      left join alpha_private.ticket_service_grants sg on sg.workspace_id=v.workspace_id and sg.client_user_id=v.client_user_id
      where v.workspace_id=$1 and v.project_id=$2 and v.client_user_id=$3 and v.status='approved'`, threadParams(thread));
    const poc = rows[0];
    if (!poc) stageMismatch('Approve a proof of concept first.');
    return { projectName: poc.project_name, clientName: poc.client_name ?? 'Client', revisionLimit,
      poc: { number: poc.number, title: poc.title, summary: poc.summary, features: poc.features, screens: poc.screens, outOfScope: poc.out_of_scope } };
  }

  /** The number of the published POC version `poc`, or a stage mismatch. */
  protected async publishedPoc(sql: Sql, thread: StageThread, poc: string): Promise<number> {
    const { rows } = await sql.query<{ number: number }>(`select number from alpha_private.client_project_poc_versions
      where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4 and status='published' for update`, [...threadParams(thread), poc]);
    if (!rows[0]) stageMismatch('This version is no longer the one waiting for review. Refresh to see the latest.');
    return rows[0].number;
  }

  /**
   * One stage write: authorize, lock, replay, act, record, return.
   * `request` is what makes two operations "the same" for replay.
   */
  protected async mutate(target: ProjectTarget, subject: TicketSubject, clientId: unknown, actor: 'pm' | 'client', operationId: string,
    action: StageAction, request: unknown, work: (context: StageContext) => Promise<StageChange>): Promise<StageResult> {
    requireActor(subject, actor);
    const fingerprint = contentHash({ action, request });
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, clientId, true);
      const thread = { ...target, clientId: client };
      const row = await lockStageRow(sql, thread, true);
      const { rows: saved } = await sql.query<{ fingerprint: string; receipt: StageReceipt }>(`select fingerprint,receipt
        from alpha_private.client_project_stage_events
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and actor_kind=$4 and actor_id=$5 and operation_id=$6`,
      [...threadParams(thread), actor, subject.userId, operationId]);
      if (saved[0]) {
        if (saved[0].fingerprint !== fingerprint) {
          throw new TicketWorkflowError(409, 'stage_operation_conflict', 'This operation was already used for something else.');
        }
        return { receipt: saved[0].receipt, stage: await loadStageSummary(sql, thread, actor) };
      }
      const change = await work({ sql, thread, stage: row.stage, subject, actor });
      if (change.moveTo && !canTransition(row.stage, change.moveTo)) stageMismatch('The project cannot move to that stage from here.');
      const version = row.version + 1;
      await sql.query(`update alpha_private.client_project_stages set version=$4,updated_at=now(),
          stage=coalesce($5,stage),stage_changed_at=case when $5::text is null then stage_changed_at else now() end
        where workspace_id=$1 and project_id=$2 and client_user_id=$3`, [...threadParams(thread), version, change.moveTo ?? null]);
      const receipt: StageReceipt = { operationId, action, refId: change.refId, version };
      await sql.query(`insert into alpha_private.client_project_stage_events(workspace_id,project_id,client_user_id,id,actor_kind,actor_id,
          action,ref_id,body,metadata,operation_id,fingerprint,receipt)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)`,
      [...threadParams(thread), randomUUID(), actor, subject.userId, action, change.refId, change.body ?? null,
        JSON.stringify(change.metadata ?? {}), operationId, fingerprint, JSON.stringify(receipt)]);
      return { receipt, stage: await loadStageSummary(sql, thread, actor) };
    });
  }
}

export function audience(subject: TicketSubject): 'client' | 'pm' { return subject.kind === 'client' ? 'client' : 'pm'; }
export function threadParams(thread: StageThread) { return [thread.workspaceId, thread.projectId, thread.clientId]; }
export function requireActor(subject: TicketSubject, actor: 'pm' | 'client') {
  if (audience(subject) !== actor) {
    throw new TicketWorkflowError(403, 'stage_action_not_allowed', actor === 'pm'
      ? 'Only the project manager can do this.' : 'Only the client can do this.');
  }
}
export async function bumpVersion(sql: Sql, thread: StageThread) {
  await sql.query(`update alpha_private.client_project_stages set version=version+1,updated_at=now()
    where workspace_id=$1 and project_id=$2 and client_user_id=$3`, threadParams(thread));
}

/** What a POC approval is a promise about: the version's own words, nothing else. */
export function pocHash(poc: { number: number; title: string; summary: string; features: unknown; screens: unknown; out_of_scope: string; note: string }) {
  return contentHash({ number: poc.number, title: poc.title, summary: poc.summary, features: poc.features,
    screens: poc.screens, outOfScope: poc.out_of_scope, note: poc.note });
}
