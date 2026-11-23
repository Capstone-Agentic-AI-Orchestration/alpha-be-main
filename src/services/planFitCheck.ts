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

/** A board card the build was asked to build. Its key is what the plan's fit check names it by. */
export interface FitCheckCard { key: string; title?: string }

export interface FitCheckScope {
  /** Board cards this plan builds; each needs a fitCheck entry. */
  cards: readonly FitCheckCard[];
  /** Planning questions the person already answered for this request; a conflict may cite one. */
  settledQuestions: readonly string[];
}

const normal = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
const MAX_NAMED = 8;
const named = (items: readonly string[]) => items.length > MAX_NAMED
  ? `${items.slice(0, MAX_NAMED).join(', ')} and ${items.length - MAX_NAMED} more` : items.join(', ');

/**
 * What is wrong with a plan's fit check, one sentence per problem, written for the planner's one
 * correction. Empty when every task and card has an entry and every conflict cites a plan decision
 * (by its `about`) or a settled planning question.
 */
export function fitCheckProblems(plan: OrchestrationPlan, scope: FitCheckScope): string[] {
  const entries = plan.fitCheck ?? [];
  if (!plan.fitCheck) {
    return ['The plan has no fitCheck. Check every task and every board card the plan builds against the brief, chat requests and recorded decisions in productPicture, and add one fitCheck entry for each.'];
  }
  const problems: string[] = [];
  const subjects = new Set(entries.map(entry => entry.subject));
  const cardSubjects = new Set(entries.map(entry => entry.subject.toUpperCase()));
  const missingTasks = plan.tasks.map(task => task.id).filter(id => !subjects.has(id));
  const missingCards = scope.cards.map(card => card.key).filter(key => !cardSubjects.has(key.toUpperCase()));
  if (missingTasks.length) problems.push(`fitCheck has no entry for task ${named(missingTasks)}; add one per task (subjectType "task").`);
  if (missingCards.length) problems.push(`fitCheck has no entry for board card ${named(missingCards)}, which this build was asked to build; add one per card (subjectType "card").`);

  const decisions = new Set((plan.decisions ?? []).map(item => normal(item.about)));
  const settled = new Set(scope.settledQuestions.map(normal));
  const unsurfaced = entries.filter(entry => entry.verdict === 'conflicts' &&
    !(entry.surfacedIn && (decisions.has(normal(entry.surfacedIn)) || settled.has(normal(entry.surfacedIn)))));
  if (unsurfaced.length) {
    problems.push(`fitCheck lists a conflict for ${named(unsurfaced.map(entry => entry.subject))} that is not surfaced to the person. For each conflict either add a decisions entry that records it (what you chose and how the person can change it) and set surfacedIn to that entry's "about" exactly, or set surfacedIn to the settled question that decided it; when no reasonable choice fits, ask one planning question (needsDecision) instead of returning a plan.`);
  }
  return problems;
}

/** The board cards a saved plan's fit check covered, so a revision of it covers them again. */
export function fitCheckCards(plan: Pick<OrchestrationPlan, 'fitCheck'>): FitCheckCard[] {
  return (plan.fitCheck ?? []).filter(entry => entry.subjectType === 'card').map(entry => ({ key: entry.subject }));
}
