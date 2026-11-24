import { MAX_PLAN_DECISIONS, type OrchestrationPlan } from './orchestrationContract.js';

type Decision = NonNullable<OrchestrationPlan['decisions']>[number];

const MAX_ABOUT_CHARS = 240;
const normal = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** A milestone decision's topic, named by its milestone, as saved and shown. */
export function milestoneDecisionAbout(milestoneTitle: string, about: string): string {
  return `${milestoneTitle}: ${about}`.slice(0, MAX_ABOUT_CHARS).trim();
}

/**
 * A later milestone's decisions joined to the saved plan's. Nobody approves a milestone's plan, so
 * saving them is the only record of what the Orchestrator decided there (the plan document, and the
 * product picture once the build's plan was approved). Each is named by its milestone ("Client
 * contract: Data storage") so it reads apart from the approved plan's. The decisions already saved,
 * which the person approved, stay first; those beyond the plan's limit come back as `unsaved` for the
 * build's chat, where they still reach the person.
 */
export function milestoneDecisions(saved: readonly Decision[], milestoneTitle: string, decisions: readonly Decision[]): {
  saved: Decision[]; added: Decision[]; unsaved: Decision[];
} {
  const known = new Set(saved.map(item => `${normal(item.about)}\n${normal(item.decision)}`));
  const named = decisions.map(item => ({ ...item, about: milestoneDecisionAbout(milestoneTitle, item.about) }))
    .filter(item => !known.has(`${normal(item.about)}\n${normal(item.decision)}`));
  const room = Math.max(0, MAX_PLAN_DECISIONS - saved.length);
  const added = named.slice(0, room);
  return { saved: [...saved, ...added], added, unsaved: named.slice(room) };
}
