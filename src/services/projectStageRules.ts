import { createHash } from 'node:crypto';

/**
 * The rules of a project's stages, with no database: which moves are allowed,
 * how revision rounds are counted, and whose turn it is. The stage service
 * (clientProjectStages.ts) applies them inside its transactions.
 */

export type ProjectStage = 'unset' | 'poc' | 'contract' | 'development' | 'completed';
export type ContractStatus = 'draft' | 'issued' | 'client_signed' | 'countersigned' | 'void';
export type RoundStatus = 'open' | 'submitted' | 'classified';
export type RevisionClassification = 'revision' | 'fix' | 'out_of_scope';
/** A change request outside the contract. Alpha takes no payments: the client is reminded it costs extra, and the PM answers. */
export type RequestStatus = 'open' | 'will_do' | 'wont_do';

export const STAGE_LABEL: Record<ProjectStage, string> = {
  unset: 'Stage not set', poc: 'Proof of concept', contract: 'Contract', development: 'Development', completed: 'Completed',
};

const MOVES: Record<ProjectStage, readonly ProjectStage[]> = {
  unset: ['poc', 'development', 'completed'],
  poc: ['contract'],
  contract: ['development'],
  development: ['completed'],
  completed: [],
};

/** Stages only move forward, one step at a time; a legacy project picks where it starts. */
export function canTransition(from: ProjectStage, to: ProjectStage): boolean {
  return MOVES[from].includes(to);
}

/** A round counts against the included revisions when at least one of its notes is a revision. */
export function roundCounts(classifications: readonly RevisionClassification[]): boolean {
  return classifications.includes('revision');
}

/**
 * Rounds used: rounds used before stages existed, plus rounds that held a
 * revision. It can pass the limit; the rounds past it are extra.
 */
export function revisionsUsed(rounds: ReadonlyArray<{ counts: boolean | null }>, offset: number): number {
  return offset + rounds.filter(round => round.counts === true).length;
}

/**
 * Once the included rounds are used, the next round is extra: the client is
 * reminded it costs additional and confirms before sending it. Nothing is
 * charged in Alpha.
 */
export function roundIsExtra(used: number, limit: number): boolean {
  return used >= limit;
}

export interface StageState {
  stage: ProjectStage;
  contract: { status: ContractStatus } | null;
  round: { status: RoundStatus; number: number } | null;
  finalDelivered: boolean;
  requests: ReadonlyArray<{ status: RequestStatus }>;
}

export type NextActionKind =
  | 'set_stage' | 'complete_poc' | 'issue_contract' | 'sign_contract' | 'countersign_contract'
  | 'answer_request' | 'share_build' | 'submit_round' | 'classify_round' | 'accept_final';
export interface NextAction { who: 'client' | 'pm'; kind: NextActionKind; label: string }

function requestAction(requests: StageState['requests']): NextAction | null {
  return requests.some(request => request.status === 'open') ? { who: 'pm', kind: 'answer_request', label: 'Answer a change request' } : null;
}

/** The POC stage is a marker: the PM moves the project to the contract once the client is happy with the concept. */
const POC_ACTION: NextAction = { who: 'pm', kind: 'complete_poc', label: 'Move to the contract when the client is ready' };

function contractAction(contract: StageState['contract']): NextAction {
  if (contract?.status === 'issued') return { who: 'client', kind: 'sign_contract', label: 'Sign the contract' };
  if (contract?.status === 'client_signed') return { who: 'pm', kind: 'countersign_contract', label: 'Countersign the contract' };
  return { who: 'pm', kind: 'issue_contract', label: 'Issue the contract' };
}

function developmentAction(state: StageState): NextAction {
  if (state.round?.status === 'open') return { who: 'client', kind: 'submit_round', label: `Send your feedback on build ${state.round.number}` };
  if (state.round?.status === 'submitted') return { who: 'pm', kind: 'classify_round', label: `Review feedback round ${state.round.number}` };
  const request = requestAction(state.requests);
  if (request) return request;
  if (state.finalDelivered) return { who: 'client', kind: 'accept_final', label: 'Review the final delivery' };
  return { who: 'pm', kind: 'share_build', label: 'Share the next build' };
}

/** Whose turn it is, and for what. Null when nothing is waiting. */
export function nextAction(state: StageState): NextAction | null {
  switch (state.stage) {
    case 'unset': return { who: 'pm', kind: 'set_stage', label: 'Choose this project’s stage' };
    case 'poc': return POC_ACTION;
    case 'contract': return contractAction(state.contract);
    case 'development': return developmentAction(state);
    case 'completed': return requestAction(state.requests);
  }
}

/** JSON with sorted keys, so the same content always hashes the same way. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

/** sha256 of the canonical JSON: what a sign-off records as "exactly this content". */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
