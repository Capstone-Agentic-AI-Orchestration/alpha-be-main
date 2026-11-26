import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import type { PlanFitCheckEntry } from './orchestrationContract.js';
import type { PrerequisiteTaskProposal } from './blockerResolutionTurn.js';
import type { RiskTier } from './riskTier.js';
import type { VerifiedCitation } from './resolutionEvidence.js';

/**
 * What the Orchestrator did about one stuck task, kept on its recovery episode as
 * `evidence.resolution` (no new table). Read back for the recovery panel, the approval list, the
 * one-per-problem rule and measuring how the default autonomy performs.
 *
 * resolving: the Orchestrator is looking into it now.
 * retrying: its verified fix went to the same specialist (or the person applied a held-back fix).
 * retry_accepted / retry_failed: how that retry ended at the acceptance gate.
 * prerequisite_added: the plan was missing work the task needs; it was added and the task waits for
 *   it (saved in the same transaction as the amended plan, so the recovery closes with it).
 * escalated: it went to the person, with the reason in `escalation`.
 * interrupted: Alpha stopped mid-way (a restart); never retried automatically.
 * superseded: the person acted first.
 */
export type ResolutionOutcome =
  | 'resolving' | 'retrying' | 'retry_accepted' | 'retry_failed' | 'prerequisite_added' | 'escalated' | 'interrupted' | 'superseded';

/**
 * `out_of_bounds`: the Orchestrator's retry went beyond what it was cleared for (a sensitive area,
 * tests it was to put back that are not back word for word,
 * or beyond its expected files), so acceptance held the work for the person.
 * For missing work (prerequisiteTasks.ts): `too_large` over the task or dependency limits,
 * `fit_conflict` the work conflicts with the product, `plan_check` the amended plan failed the run's
 * plan check, `build_budget` the build's token, cost or time budget is spent.
 */
export type ResolutionEscalation =
  | 'product' | 'sensitive' | 'strict' | 'unverified' | 'outside_scope' | 'repeat' | 'budget' | 'unavailable' | 'retry_refused'
  | 'out_of_bounds' | 'too_large' | 'fit_conflict' | 'plan_check' | 'build_budget';

/** The acceptance check that holds an Orchestrator retry which went beyond what it was cleared to change. */
export const ORCHESTRATOR_FIX_REVIEW_CHECK = 'orchestrator_fix_review';

export interface ResolutionQuestion {
  text: string;
  options: Array<{ label: string; description?: string }>;
  why: string;
}

export interface ProposedFix {
  instructions: string;
  expectedFiles: Array<{ repository: string; path: string }>;
}

/**
 * Work the plan was missing, as the Orchestrator proposed it (checked, not yet re-keyed): applied
 * by rebuilding the amendment from the current plan (prerequisiteTasks.ts), so every check runs
 * again at that moment. `summary` is what the person and the approval list read.
 */
export interface ProposedPrerequisite {
  summary: string;
  tasks: PrerequisiteTaskProposal[];
  fitCheck: PlanFitCheckEntry[];
  /** The ids the tasks were saved under, once added. */
  addedTaskIds?: string[];
}

export interface ResolutionRecord {
  outcome: ResolutionOutcome;
  fingerprint: string;
  /** True when an Orchestrator turn ran (counts toward the per-build cap). */
  turn: boolean;
  /** What the Orchestrator answered: a fix, missing work, or a question for the person. */
  answer?: 'fix' | 'prerequisite' | 'needs_owner';
  tier?: RiskTier;
  escalation?: ResolutionEscalation;
  diagnosis?: string;
  question?: ResolutionQuestion;
  /** A verified fix held back for the person (sensitive area, or `strict` autonomy). */
  proposedFix?: ProposedFix;
  /** Missing work the Orchestrator added (prerequisite_added) or held back for the person. */
  proposedPrerequisite?: ProposedPrerequisite;
  citations?: VerifiedCitation[];
  refusedCitations?: Array<{ quote: string; reason: string }>;
  classifiedPaths?: Array<{ repository: string; path: string; tier: RiskTier; categories: string[] }>;
  /**
   * Files the task had already changed when the fix was cleared. With the fix's expected files, the
   * only files its retry may change before acceptance holds the work for the person.
   */
  priorChangedPaths?: string[];
  /**
   * Test files the stopped task weakened, which the fix must put back: acceptance holds its retry
   * for the person unless every test they had at the task's start is back word for word.
   */
  restoreTests?: string[];
  reasons?: string[];
  plannerAgentId?: string;
  appliedBy?: string;
  startedAt: string;
  finishedAt?: string;
}

const OUTCOMES: ReadonlySet<string> = new Set(['resolving', 'retrying', 'retry_accepted', 'retry_failed', 'prerequisite_added', 'escalated', 'interrupted', 'superseded']);

/**
 * A verified proposal the Orchestrator held back for the person, still waiting to be applied in one
 * step (apply_proposed_fix): a fix for the same specialist, or the work the plan was missing.
 */
export function heldBackProposal(episode: OrchestrationRecoveryEpisode): ResolutionRecord | undefined {
  const record = resolutionOf(episode);
  return record?.outcome === 'escalated' && (record.proposedFix || record.proposedPrerequisite) && episode.phase !== 'repairing' ? record : undefined;
}

/** The words for what Alpha proposes or did: the fix's instructions, or the work it adds. */
export function proposalText(record: Pick<ResolutionRecord, 'proposedFix' | 'proposedPrerequisite'>): string | undefined {
  return record.proposedFix?.instructions ?? record.proposedPrerequisite?.summary;
}

/** The episode's resolution, or undefined when the Orchestrator never looked at it. */
export function resolutionOf(episode: Pick<OrchestrationRecoveryEpisode, 'evidence'> | undefined): ResolutionRecord | undefined {
  const value = episode?.evidence.resolution;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<ResolutionRecord>;
  if (typeof record.outcome !== 'string' || !OUTCOMES.has(record.outcome) || typeof record.fingerprint !== 'string') return undefined;
  return value as ResolutionRecord;
}

export function withResolution(episode: OrchestrationRecoveryEpisode, resolution: ResolutionRecord): OrchestrationRecoveryEpisode {
  return { ...episode, evidence: { ...episode.evidence, resolution } };
}

/**
 * Whether the open recovery is an Orchestrator fix that has not been through a person: its retries
 * are held to what the fix was cleared to change. A fix the person applied is theirs.
 */
export function unapprovedOrchestratorFix(episode: OrchestrationRecoveryEpisode | undefined, taskId: string): ResolutionRecord | undefined {
  const resolution = resolutionOf(episode);
  return episode?.taskId === taskId && resolution?.outcome === 'retrying' && !resolution.appliedBy ? resolution : undefined;
}

/**
 * The resolution that added this task to the plan without a person (prerequisite_added, not
 * applied by someone). Its work is held to the same risk gate as an Orchestrator fix: what it
 * actually changed is classified at acceptance, whatever its scope patterns looked like.
 */
export function unapprovedOrchestratorTask(episodes: readonly OrchestrationRecoveryEpisode[], taskId: string): ResolutionRecord | undefined {
  return episodes.map(episode => resolutionOf(episode)).find((record): record is ResolutionRecord => record?.outcome === 'prerequisite_added' &&
    !record.appliedBy && Boolean(record.proposedPrerequisite?.addedTaskIds?.includes(taskId)));
}

/** The guidance a specialist receives for an Orchestrator fix, within the guidance limit. */
export function fixGuidance(
  diagnosis: string | undefined,
  fix: ProposedFix,
  citations: readonly VerifiedCitation[] = [],
  restoreTests: ReadonlyArray<{ path: string; detail: string }> = []
): string {
  const evidence = citations.map(citation => citation.source === 'repository'
    ? `${citation.repository}:${citation.path}` : 'the project\'s product records');
  const restore = restoreTests.map(item => `${item.path} (${item.detail})`).join('; ');
  return [
    diagnosis ? `The Orchestrator looked into why this task stopped: ${diagnosis}` : 'The Orchestrator looked into why this task stopped.',
    `Do this: ${fix.instructions}`,
    restore ? `Put back every test these files had when the task started, with the same title and the same code, and keep the tests you added: ${restore}.` : '',
    evidence.length ? `Evidence: ${[...new Set(evidence)].join(', ')}.` : '',
    'Keep every test, assertion and check as it is and stay within the task scope.'
  ].filter(Boolean).join('\n');
}
