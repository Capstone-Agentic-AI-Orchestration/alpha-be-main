import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql, TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { loadStageSummary, lockStageRow, type StageSummary, type StageThread } from '../store/clientProjectStageStore.js';
import { canTransition, contentHash, revisionsUsed, roundCounts, roundIsExtra, type ProjectStage } from './projectStageRules.js';
import type { PostgresClientProjectPortal, ProjectTarget } from './clientProjectPortal.js';

/**
 * A project's stages in the PM–client conversation: POC → Development →
 * Completed (see projectStageRules.ts and the migrations
 * 20261125120000_client_project_stages.sql, 20261126180000_client_project_poc_marker.sql
 * and 20261126200000_client_project_contract_in_person.sql).
 *
 * The POC stage is a marker: nothing is written or approved in it, and the
 * features live as tasks on the project's board. The development contract is
 * drafted and signed in person, outside Alpha; once it is signed, the PM starts
 * development and records the revision rounds it includes. Projects that
 * reached the old in-app Contract stage start development the same way;
 * contracts already signed in Alpha are kept and shown read-only.
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
const startingStageSchema = command.extend({
  stage: z.enum(['poc', 'development', 'completed']),
  revisionsUsed: z.number().int().min(0).max(20).default(0),
  revisionLimit: z.number().int().min(0).max(20).default(3),
}).strict();
const startDevelopmentSchema = command.extend({ revisionLimit: z.number().int().min(0).max(20) }).strict();
const shareBuildSchema = command.extend({ note: text(4000).default('') }).strict();
const roundItemsSchema = z.object({ items: z.array(z.string().trim().min(1).max(4000)).max(50) }).strict();
const submitRoundSchema = command.extend({ acknowledgeExtra: z.boolean().default(false) }).strict();
const classifySchema = command.extend({
  items: z.array(z.object({ id, classification: z.enum(['revision', 'fix', 'out_of_scope']), pmNote: text(2000).default('') }).strict()).min(1).max(50),
}).strict();
const acceptFinalSchema = command.extend({ fullName, consent: z.literal(true) }).strict();
const changeRequestSchema = command.extend({ title: z.string().trim().min(1).max(300), description: text(8000).default('') }).strict();
const answerRequestSchema = command.extend({ decision: z.enum(['will_do', 'wont_do']), reply: text(4000).default('') }).strict();
const shortTitle = (body: string) => { const line = body.split(/\s+/).join(' '); return line.length > 120 ? line.slice(0, 119) + '…' : line; };

function invalid(): never { throw new TicketWorkflowError(400, 'invalid_stage_input', 'Check the details and try again.'); }
function missing(): never { throw new TicketWorkflowError(404, 'client_conversation_unavailable', 'This conversation is unavailable.'); }
/** The stages a project starts development from: the POC, or the in-app Contract stage some projects reached before it was removed. */
const BEFORE_DEVELOPMENT: readonly ProjectStage[] = ['poc', 'contract'];
export function parseStageInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}
function stageMismatch(message: string): never { throw new TicketWorkflowError(409, 'stage_mismatch', message); }

export type StageAction =
  | 'stage_set' | 'development_started'
  | 'build_shared' | 'round_submitted' | 'round_classified'
  | 'request_made' | 'request_answered'
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

  /**
   * PM: the contract was signed in person; development starts. Records the
   * revision rounds that contract includes, which feedback rounds count against.
   */
  async startDevelopment(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown) {
    const value = parseStageInput(startDevelopmentSchema, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'development_started', { revisionLimit: value.revisionLimit },
      async ({ sql, thread, stage }) => {
        if (!BEFORE_DEVELOPMENT.includes(stage)) stageMismatch('Development has already started for this project.');
        await sql.query(`update alpha_private.client_project_stages set revision_limit=$4
          where workspace_id=$1 and project_id=$2 and client_user_id=$3`, [...threadParams(thread), value.revisionLimit]);
        return { refId: null, metadata: { revisionLimit: value.revisionLimit }, moveTo: 'development' };
      });
  }

  /**
   * PM: share a build for feedback. Opens the next feedback round, with the
   * client-visible preview link of the moment. Sharing a build while a final
   * delivery waits for acceptance takes that delivery back.
   */
  async shareBuild(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown) {
    const value = parseStageInput(shareBuildSchema, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'build_shared', { note: value.note }, async ({ sql, thread, stage, subject: pm }) => {
      if (stage !== 'development') stageMismatch('Builds are shared during development.');
      if (await this.activeRound(sql, thread)) stageMismatch('The client is still working on the last feedback round.');
      const { rows: preview } = await sql.query<{ url: string | null }>(`select url from alpha_private.client_project_previews
        where workspace_id=$1 and project_id=$2`, [thread.workspaceId, thread.projectId]);
      const roundId = randomUUID();
      const { rows } = await sql.query<{ number: number }>(`insert into alpha_private.client_project_revision_rounds
          (workspace_id,project_id,client_user_id,id,number,status,build_note,preview_url,opened_by)
        select $1,$2,$3,$4,coalesce(max(number),0)+1,'open',$5,$6,$7 from alpha_private.client_project_revision_rounds
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 returning number`,
      [...threadParams(thread), roundId, value.note, preview[0]?.url ?? null, pm.userId]);
      await sql.query(`update alpha_private.client_project_stages set final_delivered_at=null,final_delivered_note=null
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and final_accepted_at is null`, threadParams(thread));
      return { refId: roundId, metadata: { number: rows[0]!.number } };
    });
  }

  /** Client: replace the open round's notes (a draft; nothing is sent until the round is submitted). */
  async saveRoundItems(target: ProjectTarget, subject: TicketSubject, roundId: unknown, input: unknown): Promise<StageSummary> {
    requireActor(subject, 'client');
    const round = parseStageInput(id, roundId);
    const value = parseStageInput(roundItemsSchema, input);
    return this.db.transaction(async sql => {
      const client = await this.portal.authorizeThread(sql, target, subject, undefined, true);
      const thread = { ...target, clientId: client };
      const row = await lockStageRow(sql, thread, true);
      if (row.stage !== 'development') stageMismatch('Feedback rounds are part of development.');
      await this.roundIn(sql, thread, round, ['open'], 'This round was already sent. Refresh to see it.');
      await sql.query(`delete from alpha_private.client_project_revision_items
        where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4`, [...threadParams(thread), round]);
      for (const [position, body] of value.items.entries()) {
        await sql.query(`insert into alpha_private.client_project_revision_items(workspace_id,project_id,client_user_id,round_id,id,position,body)
          values ($1,$2,$3,$4,$5,$6,$7)`, [...threadParams(thread), round, randomUUID(), position, body]);
      }
      await bumpVersion(sql, thread);
      return loadStageSummary(sql, thread, 'client');
    });
  }

  /**
   * Client: send the round to the PM. Once the included rounds are used, the
   * round is extra: the client must confirm (`acknowledgeExtra`) that it costs
   * additional. Nothing is charged in Alpha.
   */
  async submitRound(target: ProjectTarget, subject: TicketSubject, roundId: unknown, input: unknown) {
    const round = parseStageInput(id, roundId);
    const value = parseStageInput(submitRoundSchema, input);
    return this.mutate(target, subject, undefined, 'client', value.operationId, 'round_submitted', { round, acknowledgeExtra: value.acknowledgeExtra },
      async ({ sql, thread, stage }) => {
        if (stage !== 'development') stageMismatch('Feedback rounds are part of development.');
        const current = await this.roundIn(sql, thread, round, ['open'], 'This round was already sent. Refresh to see it.');
        const { rows: items } = await sql.query<{ body: string }>(`select body from alpha_private.client_project_revision_items
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 order by position`, [...threadParams(thread), round]);
        if (!items.length) throw new TicketWorkflowError(400, 'round_empty', 'Add at least one change before sending the round.');
        const row = await lockStageRow(sql, thread, true);
        const { rows: rounds } = await sql.query<{ counts: boolean | null }>(`select counts from alpha_private.client_project_revision_rounds
          where workspace_id=$1 and project_id=$2 and client_user_id=$3`, threadParams(thread));
        const extra = roundIsExtra(revisionsUsed(rounds, row.revisions_offset), row.revision_limit);
        if (extra && !value.acknowledgeExtra) {
          throw new TicketWorkflowError(409, 'extra_round_unconfirmed',
            `Your ${row.revision_limit} included revision rounds are used. This round costs additional; confirm to send it.`);
        }
        await sql.query(`update alpha_private.client_project_revision_rounds set status='submitted',submitted_at=now(),extra=$5
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), round, extra]);
        return { refId: round, metadata: extra ? { number: current.number, extra: true } : { number: current.number } };
      });
  }

  /**
   * PM: label each note of a submitted round. The round counts against the
   * included rounds only if a note is a revision; each out-of-scope note
   * becomes a change request for the PM to answer.
   */
  async classifyRound(target: ProjectTarget, subject: TicketSubject, roundId: unknown, input: unknown, clientId?: unknown) {
    const round = parseStageInput(id, roundId);
    const value = parseStageInput(classifySchema, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'round_classified', { round, items: value.items },
      async ({ sql, thread, stage }) => {
        if (stage !== 'development') stageMismatch('Feedback rounds are part of development.');
        const current = await this.roundIn(sql, thread, round, ['submitted'], 'This round is not waiting for review.');
        const { rows: items } = await sql.query<{ id: string; body: string }>(`select id,body from alpha_private.client_project_revision_items
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 order by position for update`, [...threadParams(thread), round]);
        const labels = new Map(value.items.map(item => [item.id, item]));
        if (labels.size !== value.items.length || items.length !== labels.size || items.some(item => !labels.has(item.id))) {
          throw new TicketWorkflowError(400, 'round_classification_incomplete', 'Label every change in the round.');
        }
        for (const item of items) {
          const label = labels.get(item.id)!;
          await sql.query(`update alpha_private.client_project_revision_items set classification=$6,pm_note=$7
            where workspace_id=$1 and project_id=$2 and client_user_id=$3 and round_id=$4 and id=$5`,
          [...threadParams(thread), round, item.id, label.classification, label.pmNote]);
          if (label.classification === 'out_of_scope') {
            await sql.query(`insert into alpha_private.client_project_requests(workspace_id,project_id,client_user_id,id,round_id,title,description,
                status,requested_by_kind) values ($1,$2,$3,$4,$5,$6,$7,'open','pm')`,
            [...threadParams(thread), randomUUID(), round, shortTitle(item.body), item.body]);
          }
        }
        const counts = roundCounts(value.items.map(item => item.classification));
        await sql.query(`update alpha_private.client_project_revision_rounds set status='classified',classified_at=now(),counts=$5
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`, [...threadParams(thread), round, counts]);
        return { refId: round, metadata: { number: current.number, counts } };
      });
  }

  /** PM: the agreed deliverables are done; the client is asked to accept them. */
  async markFinalDelivery(target: ProjectTarget, subject: TicketSubject, input: unknown, clientId?: unknown) {
    const value = parseStageInput(shareBuildSchema, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'final_delivered', { note: value.note }, async ({ sql, thread, stage }) => {
      if (stage !== 'development') stageMismatch('The final delivery is part of development.');
      if (await this.activeRound(sql, thread)) stageMismatch('Finish the open feedback round first.');
      const row = await lockStageRow(sql, thread, true);
      if (row.final_delivered_at) stageMismatch('The final delivery is already waiting for the client.');
      await sql.query(`update alpha_private.client_project_stages set final_delivered_at=now(),final_delivered_note=$4
        where workspace_id=$1 and project_id=$2 and client_user_id=$3`, [...threadParams(thread), value.note]);
      return { refId: null };
    });
  }

  /** Client: accept the final delivery. The contract closes. */
  async acceptFinal(target: ProjectTarget, subject: TicketSubject, input: unknown) {
    const value = parseStageInput(acceptFinalSchema, input);
    return this.mutate(target, subject, undefined, 'client', value.operationId, 'final_accepted', { fullName: value.fullName },
      async ({ sql, thread, stage }) => {
        if (stage !== 'development') stageMismatch('There is no final delivery waiting for you.');
        const row = await lockStageRow(sql, thread, true);
        if (!row.final_delivered_at || row.final_accepted_at) stageMismatch('There is no final delivery waiting for you.');
        await sql.query(`update alpha_private.client_project_stages set final_accepted_at=now(),final_accepted_name=$4
          where workspace_id=$1 and project_id=$2 and client_user_id=$3`, [...threadParams(thread), value.fullName]);
        return { refId: null, metadata: { name: value.fullName }, moveTo: 'completed' };
      });
  }

  /** Client: ask for new work outside the contract. The client is told it costs additional; the PM answers. */
  async requestChange(target: ProjectTarget, subject: TicketSubject, input: unknown) {
    const value = parseStageInput(changeRequestSchema, input);
    return this.mutate(target, subject, undefined, 'client', value.operationId, 'request_made', { title: value.title, description: value.description },
      async ({ sql, thread, stage }) => {
        if (stage !== 'development' && stage !== 'completed') stageMismatch('Change requests start once development has begun.');
        const request = randomUUID();
        await sql.query(`insert into alpha_private.client_project_requests(workspace_id,project_id,client_user_id,id,title,description,status,requested_by_kind)
          values ($1,$2,$3,$4,$5,$6,'open','client')`, [...threadParams(thread), request, value.title, value.description]);
        // The conversation shows what was asked; the full description stays on the request.
        return { refId: request, body: (value.description ? `${value.title}\n\n${value.description}` : value.title).slice(0, 4000) };
      });
  }

  /** PM: answer a change request with "will do" or "won't do", and an optional reply the client sees. */
  async answerRequest(target: ProjectTarget, subject: TicketSubject, requestId: unknown, input: unknown, clientId?: unknown) {
    const request = parseStageInput(id, requestId);
    const value = parseStageInput(answerRequestSchema, input);
    return this.mutate(target, subject, clientId, 'pm', value.operationId, 'request_answered', { request, decision: value.decision, reply: value.reply },
      async ({ sql, thread, subject: pm }) => {
        const { rows } = await sql.query<{ title: string; status: string }>(`select title,status from alpha_private.client_project_requests
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4 for update`, [...threadParams(thread), request]);
        if (!rows[0] || rows[0].status !== 'open') stageMismatch('This request was already answered.');
        await sql.query(`update alpha_private.client_project_requests set status=$5,reply=$6,answered_by=$7,answered_at=now()
          where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4`,
        [...threadParams(thread), request, value.decision, value.reply, pm.userId]);
        return { refId: request, body: value.reply || null, metadata: { decision: value.decision, title: rows[0].title } };
      });
  }

  /** The thread's round that is not yet classified, if any. */
  protected async activeRound(sql: Sql, thread: StageThread): Promise<boolean> {
    const { rows } = await sql.query(`select id from alpha_private.client_project_revision_rounds
      where workspace_id=$1 and project_id=$2 and client_user_id=$3 and status<>'classified' for update`, threadParams(thread));
    return rows.length > 0;
  }

  /** Round `round`, locked, when its status is one of `statuses`; otherwise a stage mismatch. */
  protected async roundIn(sql: Sql, thread: StageThread, round: string, statuses: string[], message: string) {
    const { rows } = await sql.query<{ number: number; status: string }>(`select number,status from alpha_private.client_project_revision_rounds
      where workspace_id=$1 and project_id=$2 and client_user_id=$3 and id=$4 for update`, [...threadParams(thread), round]);
    if (!rows[0] || !statuses.includes(rows[0].status)) stageMismatch(message);
    return rows[0];
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

