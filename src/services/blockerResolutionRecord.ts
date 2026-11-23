import type { OrchestrationRecoveryEpisode } from '../models/index.js';
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
 * escalated: it went to the person, with the reason in `escalation`.
 * interrupted: Alpha stopped mid-way (a restart); never retried automatically.
 * superseded: the person acted first.
 */
export type ResolutionOutcome =
  | 'resolving' | 'retrying' | 'retry_accepted' | 'retry_failed' | 'escalated' | 'interrupted' | 'superseded';

/**
 * `out_of_bounds`: the Orchestrator's retry changed files it was not cleared for (a sensitive area,
 * or beyond its expected files), so acceptance held the work for the person.
 */
export type ResolutionEscalation =
  | 'product' | 'sensitive' | 'strict' | 'unverified' | 'outside_scope' | 'repeat' | 'budget' | 'unavailable' | 'retry_refused'
  | 'out_of_bounds';

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

export interface ResolutionRecord {
  outcome: ResolutionOutcome;
  fingerprint: string;
  /** True when an Orchestrator turn ran (counts toward the per-build cap). */
  turn: boolean;
  tier?: RiskTier;
  escalation?: ResolutionEscalation;
  diagnosis?: string;
  question?: ResolutionQuestion;
  /** A verified fix held back for the person (sensitive area, or `strict` autonomy). */
  proposedFix?: ProposedFix;
  citations?: VerifiedCitation[];
  refusedCitations?: Array<{ quote: string; reason: string }>;
  classifiedPaths?: Array<{ repository: string; path: string; tier: RiskTier; categories: string[] }>;
  /**
   * Files the task had already changed when the fix was cleared. With the fix's expected files, the
   * only files its retry may change before acceptance holds the work for the person.
   */
  priorChangedPaths?: string[];
  reasons?: string[];
  plannerAgentId?: string;
  appliedBy?: string;
  startedAt: string;
  finishedAt?: string;
}

const OUTCOMES: ReadonlySet<string> = new Set(['resolving', 'retrying', 'retry_accepted', 'retry_failed', 'escalated', 'interrupted', 'superseded']);

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

/** The guidance a specialist receives for an Orchestrator fix, within the guidance limit. */
export function fixGuidance(diagnosis: string | undefined, fix: ProposedFix, citations: readonly VerifiedCitation[] = []): string {
  const evidence = citations.map(citation => citation.source === 'repository'
    ? `${citation.repository}:${citation.path}` : 'the recorded product decision');
  return [
    diagnosis ? `The Orchestrator looked into why this task stopped: ${diagnosis}` : 'The Orchestrator looked into why this task stopped.',
    `Do this: ${fix.instructions}`,
    evidence.length ? `Evidence: ${[...new Set(evidence)].join(', ')}.` : '',
    'Keep every test, assertion and check as it is and stay within the task scope.'
  ].filter(Boolean).join('\n');
}
