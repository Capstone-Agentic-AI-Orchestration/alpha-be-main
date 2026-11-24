import type { OrchestrationPlan } from './orchestrationContract.js';

/**
 * The required fit check (PRODUCT_EXPLANATION_PLAN phase 4). Before a plan is accepted, the planner
 * checks every task it plans and every board card it builds against the brief, the chat requests
 * and the recorded decisions, and surfaces each conflict to the person: as a planning question
 * (the planner returns needsDecision instead of a plan, and the answer comes back as a settled
 * question) or as a plan decision the person sees when approving.
 *
 * This code only enforces that the check was done and that every conflict it lists was surfaced.
 * What counts as a conflict is the planner's judgement and the approving person's, never a rule here.
 */

/** The `about` of the planner's general note on how the plan fits; never a decision on one conflict. */
export const FIT_DECISION_ABOUT = 'Fit with the product';

/** A board card the build was asked to build. Its key is what the plan's fit check names it by. */
export interface FitCheckCard { key: string; title?: string }

export interface FitCheckScope {
  /** Board cards this plan builds; each needs a fitCheck entry. */
  cards: readonly FitCheckCard[];
  /** Planning questions the person already answered for this request; a conflict may cite one. */
  settledQuestions: readonly string[];
  /**
   * Whether the person sees this plan's decisions before work starts. A later milestone's plan is
   * not approved by anyone, so there a conflict can only be surfaced by asking.
   */
  decisionsVisible: boolean;
}

type PlanDecision = NonNullable<OrchestrationPlan['decisions']>[number];

const normal = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
const MAX_NAMED = 8;
const named = (items: readonly string[]) => items.length > MAX_NAMED
  ? `${items.slice(0, MAX_NAMED).join(', ')} and ${items.length - MAX_NAMED} more` : items.join(', ');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether text names a task id or card key as a whole word (so `ui` does not match "build"). */
function names(text: string, subject: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escape(subject)}(?:$|[^A-Za-z0-9_-])`, 'i').test(text);
}

/**
 * A decision that surfaces one conflict: written by the planner (not added by Alpha), not the
 * general fit note, naming the conflicting task or card, and saying how the person can choose the
 * other way. Anything less would let a conflict pass without the person being able to act on it.
 */
function surfacesConflict(decision: PlanDecision, subject: string): boolean {
  const text = `${decision.about} ${decision.decision}`;
  // A task Alpha split after planning (`id-part-2`, orchestrationPlanSize) is the task the planner named.
  const unsplit = subject.replace(/-part-\d+$/, '');
  return !decision.by && normal(decision.about) !== normal(FIT_DECISION_ABOUT) && Boolean(decision.toChange?.trim()) &&
    (names(text, subject) || names(text, unsplit));
}

/**
 * What is wrong with a plan's fit check, one sentence per problem, written for the planner's one
 * correction. Empty when every task has a task entry, every card a card entry, and every conflict
 * cites a settled planning question or (where the person sees the plan) a decision that surfaces it.
 */
export function fitCheckProblems(plan: OrchestrationPlan, scope: FitCheckScope): string[] {
  const entries = plan.fitCheck ?? [];
  if (!plan.fitCheck) {
    return ['The plan has no fitCheck. Check every task and every board card the plan builds against the brief, chat requests and recorded decisions in productPicture, and add one fitCheck entry for each.'];
  }
  const problems: string[] = [];
  const taskSubjects = new Set(entries.filter(entry => entry.subjectType === 'task').map(entry => entry.subject));
  const cardSubjects = new Set(entries.filter(entry => entry.subjectType === 'card').map(entry => entry.subject.toUpperCase()));
  const missingTasks = plan.tasks.map(task => task.id).filter(id => !taskSubjects.has(id));
  const missingCards = scope.cards.map(card => card.key).filter(key => !cardSubjects.has(key.toUpperCase()));
  if (missingTasks.length) problems.push(`fitCheck has no task entry for ${named(missingTasks)}; add one per task with subjectType "task" and the exact task id.`);
  if (missingCards.length) problems.push(`fitCheck has no card entry for board card ${named(missingCards)}, which this build was asked to build; add one per card with subjectType "card".`);

  const settled = new Set(scope.settledQuestions.map(normal));
  const decisions = scope.decisionsVisible ? plan.decisions ?? [] : [];
  const unsurfaced = entries.filter(entry => {
    if (entry.verdict !== 'conflicts') return false;
    const cited = normal(entry.surfacedIn ?? '');
    if (cited && settled.has(cited)) return false;
    return !decisions.some(decision => normal(decision.about) === cited && surfacesConflict(decision, entry.subject));
  });
  if (unsurfaced.length) {
    problems.push(scope.decisionsVisible
      ? `fitCheck lists a conflict for ${named(unsurfaced.map(entry => entry.subject))} that is not surfaced to the person. For each conflict add your own decisions entry (not "${FIT_DECISION_ABOUT}") whose about or decision names the conflicting task id or card key, says what you chose, and has a toChange saying how to choose the other way; set surfacedIn to that entry's about exactly. Or set surfacedIn to the settled question that decided it; or, when no reasonable choice fits, ask one planning question (needsDecision) instead of returning a plan.`
      : `fitCheck lists a conflict for ${named(unsurfaced.map(entry => entry.subject))}. Nobody approves a later milestone's plan, so its decisions are not shown to the person: plan this milestone without the conflicting work if its requirements allow, or ask one planning question (needsDecision) instead of returning a plan.`);
  }
  return problems;
}

/** The board cards a saved plan's fit check covered, so a revision of it covers them again. */
export function fitCheckCards(plan: Pick<OrchestrationPlan, 'fitCheck'>): FitCheckCard[] {
  return (plan.fitCheck ?? []).filter(entry => entry.subjectType === 'card').map(entry => ({ key: entry.subject }));
}

/** The conflicts a plan's fit check lists, as the person sees them where they approve the plan. */
export function fitCheckConflicts(plan: Pick<OrchestrationPlan, 'fitCheck'>): Array<{ subject: string; reason: string; surfacedIn?: string }> {
  return (plan.fitCheck ?? []).filter(entry => entry.verdict === 'conflicts')
    .map(entry => ({ subject: entry.subject, reason: entry.reason, ...(entry.surfacedIn ? { surfacedIn: entry.surfacedIn } : {}) }));
}
