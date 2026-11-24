import type { Sql } from './database.js';
import { ticketSqlIso } from './ticketPostgresCodec.js';
import {
  nextAction, revisionsUsed, STAGE_LABEL,
  type ContractStatus, type NextAction, type PocStatus, type ProjectStage, type QuoteStatus,
  type RevisionClassification, type RoundStatus, type StageState,
} from '../services/projectStageRules.js';

/**
 * Reads for a project's stage track (one per client and project). Writes live
 * in services/clientProjectStages.ts; the project list reads the badge here.
 */

export interface StageThread { workspaceId: string; projectId: string; clientId: string }
export interface PocFeature { title: string; detail: string }
export interface PocVersionView {
  id: string; number: number; status: PocStatus; title: string; summary: string; features: PocFeature[]; screens: string[];
  outOfScope: string; note: string; contentHash: string | null; createdAt: string; updatedAt: string; publishedAt: string | null;
  approvedAt: string | null; approvedName: string | null; changeRequest: { body: string; createdAt: string } | null;
}
export interface ContractClause { title: string; body: string }
export interface ContractTerms {
  projectName: string; clientName: string;
  scope: { pocNumber: number; title: string; summary: string; features: PocFeature[]; screens: string[]; outOfScope: string };
  deliverables: string[]; revisionLimit: number; clauses: ContractClause[]; notes: string;
}
export interface ContractView {
  id: string; pocVersionId: string; status: ContractStatus; terms: ContractTerms; contentHash: string | null;
  createdAt: string; updatedAt: string; issuedAt: string | null;
  clientSignedName: string | null; clientSignedAt: string | null; pmSignedName: string | null; pmSignedAt: string | null;
}
export interface RevisionItemView { id: string; position: number; body: string; classification: RevisionClassification | null; pmNote: string }
export interface RoundView {
  id: string; number: number; status: RoundStatus; buildNote: string; previewUrl: string | null; counts: boolean | null;
  paid: boolean; quoteId: string | null; openedAt: string; submittedAt: string | null; classifiedAt: string | null;
  items: RevisionItemView[];
}
export interface QuoteView {
  id: string; kind: 'paid_revision' | 'change_request'; roundId: string | null; title: string; description: string;
  amount: string | null; currency: string; status: QuoteStatus; requestedBy: 'pm' | 'client'; requestedAt: string;
  sentAt: string | null; decidedName: string | null; decidedAt: string | null;
}
export interface StageSummary {
  stage: ProjectStage; stageLabel: string; revisionLimit: number; revisionsUsed: number; version: number; stageChangedAt: string;
  nextAction: NextAction | null;
  poc: PocVersionView | null; pocDraft: PocVersionView | null;
  pocHistory: Array<{ id: string; number: number; status: PocStatus; publishedAt: string | null }>;
  contract: ContractView | null; rounds: RoundView[]; quotes: QuoteView[];
  final: { deliveredAt: string; note: string; acceptedAt: string | null; acceptedName: string | null } | null;
  clientId?: string;
}
export interface StageBadge { stage: ProjectStage; label: string; waitingOn: 'client' | 'pm' | null; actionLabel: string | null }

type Time = string | Date;
const iso = (value: Time | null) => (value === null ? null : ticketSqlIso(value));
interface StageRow {
  stage: ProjectStage; revision_limit: number; revisions_offset: number; version: number; stage_changed_at: Time;
  final_delivered_at: Time | null; final_delivered_note: string | null; final_accepted_at: Time | null; final_accepted_name: string | null;
}
interface PocRow {
  id: string; number: number; status: PocStatus; title: string; summary: string; features: PocFeature[]; screens: string[];
  out_of_scope: string; note: string; content_hash: string | null; created_at: Time; updated_at: Time; published_at: Time | null;
  approved_at: Time | null; approved_name: string | null; change_body: string | null; change_at: Time | null;
}
interface ContractRow {
  id: string; poc_version_id: string; status: ContractStatus; terms: ContractTerms; content_hash: string | null;
  created_at: Time; updated_at: Time; issued_at: Time | null; client_signed_name: string | null; client_signed_at: Time | null;
  pm_signed_name: string | null; pm_signed_at: Time | null;
}
interface RoundRow {
  id: string; number: number; status: RoundStatus; build_note: string; preview_url: string | null; counts: boolean | null; paid: boolean;
  quote_id: string | null; opened_at: Time; submitted_at: Time | null; classified_at: Time | null;
}
interface ItemRow { round_id: string; id: string; position: number; body: string; classification: RevisionClassification | null; pm_note: string }
interface QuoteRow {
  id: string; kind: 'paid_revision' | 'change_request'; round_id: string | null; title: string; description: string; amount: string | null;
  currency: string; status: QuoteStatus; requested_by_kind: 'pm' | 'client'; requested_at: Time; sent_at: Time | null;
  decided_name: string | null; decided_at: Time | null;
}

const THREAD = 'workspace_id=$1 and project_id=$2 and client_user_id=$3';
const params = (thread: StageThread) => [thread.workspaceId, thread.projectId, thread.clientId];

/** The thread's stage row, created on first use. Threads that predate stages were backfilled as 'unset'. */
export async function lockStageRow(sql: Sql, thread: StageThread, write: boolean): Promise<StageRow> {
  await sql.query(`insert into alpha_private.client_project_stages(workspace_id,project_id,client_user_id,stage)
    values ($1,$2,$3,'poc') on conflict do nothing`, params(thread));
  const { rows } = await sql.query<StageRow>(`select stage,revision_limit,revisions_offset,version,stage_changed_at,
      final_delivered_at,final_delivered_note,final_accepted_at,final_accepted_name
    from alpha_private.client_project_stages where ${THREAD} for ${write ? 'update' : 'share'}`, params(thread));
  return rows[0]!;
}

function pocView(row: PocRow): PocVersionView {
  return {
    id: row.id, number: row.number, status: row.status, title: row.title, summary: row.summary,
    features: row.features, screens: row.screens, outOfScope: row.out_of_scope, note: row.note, contentHash: row.content_hash,
    createdAt: ticketSqlIso(row.created_at), updatedAt: ticketSqlIso(row.updated_at), publishedAt: iso(row.published_at),
    approvedAt: iso(row.approved_at), approvedName: row.approved_name,
    changeRequest: row.change_body && row.change_at ? { body: row.change_body, createdAt: ticketSqlIso(row.change_at) } : null,
  };
}

async function loadPocs(sql: Sql, thread: StageThread): Promise<PocRow[]> {
  const { rows } = await sql.query<PocRow>(`select v.id,v.number,v.status,v.title,v.summary,v.features,v.screens,v.out_of_scope,v.note,
      v.content_hash,v.created_at,v.updated_at,v.published_at,v.approved_at,v.approved_name,c.body as change_body,c.created_at as change_at
    from alpha_private.client_project_poc_versions v
    left join lateral (select e.body,e.created_at from alpha_private.client_project_stage_events e
      where e.workspace_id=v.workspace_id and e.project_id=v.project_id and e.client_user_id=v.client_user_id
        and e.action='poc_changes_requested' and e.ref_id=v.id order by e.created_at desc limit 1) c on true
    where v.workspace_id=$1 and v.project_id=$2 and v.client_user_id=$3 order by v.number desc`, params(thread));
  return rows;
}

async function loadContract(sql: Sql, thread: StageThread): Promise<ContractView | null> {
  const { rows } = await sql.query<ContractRow>(`select id,poc_version_id,status,terms,content_hash,created_at,updated_at,issued_at,
      client_signed_name,client_signed_at,pm_signed_name,pm_signed_at
    from alpha_private.client_project_contracts where ${THREAD} and status<>'void'`, params(thread));
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id, pocVersionId: row.poc_version_id, status: row.status, terms: row.terms, contentHash: row.content_hash,
    createdAt: ticketSqlIso(row.created_at), updatedAt: ticketSqlIso(row.updated_at), issuedAt: iso(row.issued_at),
    clientSignedName: row.client_signed_name, clientSignedAt: iso(row.client_signed_at),
    pmSignedName: row.pm_signed_name, pmSignedAt: iso(row.pm_signed_at),
  };
}

async function loadRounds(sql: Sql, thread: StageThread): Promise<RoundView[]> {
  const { rows } = await sql.query<RoundRow>(`select id,number,status,build_note,preview_url,counts,paid,quote_id,opened_at,submitted_at,classified_at
    from alpha_private.client_project_revision_rounds where ${THREAD} order by number desc`, params(thread));
  if (!rows.length) return [];
  const { rows: items } = await sql.query<ItemRow>(`select round_id,id,position,body,classification,pm_note
    from alpha_private.client_project_revision_items where ${THREAD} order by position`, params(thread));
  return rows.map(row => ({
    id: row.id, number: row.number, status: row.status, buildNote: row.build_note, previewUrl: row.preview_url,
    counts: row.counts, paid: row.paid, quoteId: row.quote_id, openedAt: ticketSqlIso(row.opened_at),
    submittedAt: iso(row.submitted_at), classifiedAt: iso(row.classified_at),
    items: items.filter(item => item.round_id === row.id).map(item => ({
      id: item.id, position: item.position, body: item.body, classification: item.classification, pmNote: item.pm_note })),
  }));
}

async function loadQuotes(sql: Sql, thread: StageThread): Promise<QuoteView[]> {
  const { rows } = await sql.query<QuoteRow>(`select id,kind,round_id,title,description,amount::text as amount,currency,status,
      requested_by_kind,requested_at,sent_at,decided_name,decided_at
    from alpha_private.client_project_quotes where ${THREAD} and status<>'withdrawn' order by requested_at desc,id collate "C"`, params(thread));
  return rows.map(row => ({
    id: row.id, kind: row.kind, roundId: row.round_id, title: row.title, description: row.description, amount: row.amount,
    currency: row.currency, status: row.status, requestedBy: row.requested_by_kind, requestedAt: ticketSqlIso(row.requested_at),
    sentAt: iso(row.sent_at), decidedName: row.decided_name, decidedAt: iso(row.decided_at),
  }));
}

function stageState(row: StageRow, pocs: PocVersionView[], contract: ContractView | null, rounds: RoundView[], quotes: QuoteView[]): StageState {
  const latest = pocs.find(poc => poc.status !== 'draft') ?? null;
  const active = rounds.find(round => round.status !== 'classified') ?? null;
  return {
    stage: row.stage,
    poc: latest ? { status: latest.status, number: latest.number } : null,
    contract: contract ? { status: contract.status } : null,
    round: active ? { status: active.status, number: active.number } : null,
    finalDelivered: row.final_delivered_at !== null && row.final_accepted_at === null,
    quotes: quotes.map(quote => ({ status: quote.status })),
  };
}

/** Everything both sides need to show the stage. Drafts and unsent quote amounts stay with the PM. */
export async function loadStageSummary(sql: Sql, thread: StageThread, audience: 'client' | 'pm'): Promise<StageSummary> {
  const row = await lockStageRow(sql, thread, false);
  // One connection per transaction: read in turn.
  const pocRows = await loadPocs(sql, thread);
  const contract = await loadContract(sql, thread);
  const rounds = await loadRounds(sql, thread);
  const quotes = await loadQuotes(sql, thread);
  const pocs = pocRows.map(pocView);
  const published = pocs.filter(poc => poc.status !== 'draft');
  const forClient = audience === 'client';
  const visibleContract = forClient && contract?.status === 'draft' ? null : contract;
  const visibleQuotes = forClient ? quotes.map(quote => quote.status === 'requested' ? { ...quote, amount: null } : quote) : quotes;
  return {
    stage: row.stage, stageLabel: STAGE_LABEL[row.stage], revisionLimit: row.revision_limit,
    revisionsUsed: revisionsUsed(rounds, row.revisions_offset), version: row.version, stageChangedAt: ticketSqlIso(row.stage_changed_at),
    nextAction: nextAction(stageState(row, pocs, contract, rounds, quotes)),
    poc: published[0] ?? null,
    pocDraft: forClient ? null : pocs.find(poc => poc.status === 'draft') ?? null,
    pocHistory: published.map(poc => ({ id: poc.id, number: poc.number, status: poc.status, publishedAt: poc.publishedAt })),
    contract: visibleContract, rounds, quotes: visibleQuotes,
    final: row.final_delivered_at ? {
      deliveredAt: ticketSqlIso(row.final_delivered_at), note: row.final_delivered_note ?? '',
      acceptedAt: iso(row.final_accepted_at), acceptedName: row.final_accepted_name,
    } : null,
    ...(forClient ? {} : { clientId: thread.clientId }),
  };
}

/** A project card's stage chip: the stage, and whether the reader is the one being waited on. */
export async function loadStageBadge(sql: Sql, thread: StageThread): Promise<StageBadge> {
  const summary = await loadStageSummary(sql, thread, 'client');
  return {
    stage: summary.stage, label: summary.stageLabel, waitingOn: summary.nextAction?.who ?? null,
    actionLabel: summary.nextAction?.label ?? null,
  };
}
