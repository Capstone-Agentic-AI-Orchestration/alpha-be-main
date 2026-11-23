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

export type ResolutionEscalation =
  | 'product' | 'sensitive' | 'strict' | 'unverified' | 'outside_scope' | 'repeat' | 'budget' | 'unavailable' | 'retry_refused';

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
