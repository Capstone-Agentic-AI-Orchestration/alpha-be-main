import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { resolutionOf } from './blockerResolutionRecord.js';
import { safeRecoveryGuidance, safeRecoverySummary } from './orchestrationRecoveryPolicy.js';

/**
 * One file or product record the Orchestrator cited for its fix, verified by Alpha before it acted.
 * `commit` is the checkpoint the quote was found at, so a link shows the file as it was checked.
 */
export type ResolvedWithoutYouEvidence =
  | { source: 'repository'; repository: string; path: string; quote: string; commit?: string }
  | { source: 'product_picture'; quote: string };

/**
 * A problem the Orchestrator fixed on its own during a build, listed for the person at approval.
 * Team only: it travels on the build snapshot, which needs `squad.read` (clients have none).
 */
export interface ResolvedWithoutYouItem {
  recoveryId: string;
  taskId?: string;
  taskTitle?: string;
  /** `retry_accepted`: the fix passed acceptance. `retrying`: the specialist is applying it now. */
  status: 'retry_accepted' | 'retrying';
  /** 0 mechanical, 1 structural (changes earlier accepted work). */
  tier: number;
  problem: string;
  fix: string;
  evidence: ResolvedWithoutYouEvidence[];
  resolvedAt: string;
}

const MAX_QUOTE = 300;
const COMMIT = /^[0-9a-f]{40,64}$/i;
const MAX_EVIDENCE = 12;

function shortQuote(value: string): string {
  const text = safeRecoverySummary(value);
  return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 1)}…` : text;
}

/**
 * Every fix the Orchestrator made without the person in this run, oldest first. A fix the person
 * applied themselves (`appliedBy`) is theirs, not "without you", and a fix that failed, was
 * overtaken or went to the person is not a resolution.
 */
export function resolvedWithoutYou(
  snapshot: Pick<OrchestrationSnapshot, 'tasks'>,
  episodes: readonly OrchestrationRecoveryEpisode[]
): ResolvedWithoutYouItem[] {
  const titles = new Map(snapshot.tasks.map(task => [task.id, task.title]));
  return episodes.flatMap(episode => {
    const record = resolutionOf(episode);
    if (!record || record.appliedBy || !record.proposedFix) return [];
    if (record.outcome !== 'retry_accepted' && record.outcome !== 'retrying') return [];
    const evidence: ResolvedWithoutYouEvidence[] = (record.citations ?? []).slice(0, MAX_EVIDENCE).map(citation =>
      citation.source === 'repository'
        ? { source: 'repository', repository: safeRecoverySummary(citation.repository), path: safeRecoverySummary(citation.path),
          quote: shortQuote(citation.quote), ...(COMMIT.test(citation.commit ?? '') ? { commit: citation.commit } : {}) }
        : { source: 'product_picture', quote: shortQuote(citation.quote) });
    const taskTitle = episode.taskId ? titles.get(episode.taskId) : undefined;
    return [{
      recoveryId: episode.id,
      ...(episode.taskId ? { taskId: episode.taskId } : {}),
      ...(taskTitle ? { taskTitle: safeRecoverySummary(taskTitle) } : {}),
      status: record.outcome,
      tier: record.tier ?? 0,
      problem: safeRecoverySummary(record.diagnosis ?? episode.summary),
      fix: safeRecoveryGuidance(record.proposedFix.instructions),
      evidence,
      resolvedAt: record.finishedAt ?? episode.updatedAt
    }];
  }).sort((left, right) => left.resolvedAt.localeCompare(right.resolvedAt));
}
