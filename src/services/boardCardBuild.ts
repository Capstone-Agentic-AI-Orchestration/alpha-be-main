import { createHash } from 'node:crypto';
import type { Issue } from '../models/index.js';
import type { OrchestrationPlan } from './orchestrationContract.js';
import { plannerRequirementsFromSpec, type FeatureSpec } from './featureSpecContract.js';
import { manualChecklistRequirements } from './issueChecklist.js';

/**
 * Board cards a chat build request asks for.
 *
 * The planner and its specialists cannot read the board, so a chat request such
 * as "do all the tasks" or "build PRO-103 and PRO-104" used to reach them as a
 * sentence pointing at cards they could not open, and the build stopped to ask
 * for details the cards already held. Alpha resolves the cards itself and hands
 * their checklists to the planner as approved requirements.
 */
export interface BoardCardSelection {
  /** Cards to build, in dependency order. */
  cards: Issue[];
  /** Archived cards the request named; they are left out. */
  archived: string[];
}

const CARD_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
// "do all the tasks", "complete all remaining Project A expense tasks", "build every card".
const ALL_CARDS_START = /\b(?:do|build|complete|finish|implement|start|tackle|work\s+on)\s+(?:all|every|remaining|the\s+remaining|the\s+rest\s+of)\b/gi;
const CARD_NOUN_SOON = /^(?:\s+[\w-]+){0,5}?\s+(?:tasks?|cards?|tickets?)\b/i;
const OPEN_STATUSES = new Set<Issue['status']>(['backlog', 'todo', 'in_progress']);
const MAX_CARD_TEXT = 600;

const isBuildRecord = (issue: Issue) => issue.labels.includes('alpha:chat-build');
const cardNumber = (issue: Issue) => Number(issue.identifier.split('-').pop()) || 0;
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const asksForAllCards = (request: string) => [...request.matchAll(ALL_CARDS_START)]
  .some(match => CARD_NOUN_SOON.test(request.slice(match.index + match[0].length)));

export function selectBoardCards(request: string, projectIssues: readonly Issue[]): BoardCardSelection {
  const byKey = new Map(projectIssues.map(issue => [issue.identifier.toUpperCase(), issue]));
  const named = [...new Set([...request.matchAll(CARD_KEY)].map(match => match[1].toUpperCase()))]
    .map(key => byKey.get(key))
    .filter((issue): issue is Issue => Boolean(issue) && !isBuildRecord(issue!));
  const archived = named.filter(issue => issue.archivedAt).map(issue => issue.identifier);
  const chosen = new Map(named.filter(issue => !issue.archivedAt).map(issue => [issue.id, issue]));
  if (asksForAllCards(request)) {
    for (const issue of projectIssues) {
      if (!issue.archivedAt && !isBuildRecord(issue) && OPEN_STATUSES.has(issue.status)) chosen.set(issue.id, issue);
    }
  }
  return { cards: dependencyOrder([...chosen.values()]), archived };
}

/** Cards a card depends on come first, otherwise board number order. A cycle keeps number order. */
function dependencyOrder(cards: Issue[]): Issue[] {
  const pending = cards.slice().sort((a, b) => cardNumber(a) - cardNumber(b));
  const ids = new Set(pending.map(card => card.id));
  const ordered: Issue[] = [];
  while (pending.length) {
    const placed = new Set(ordered.map(card => card.id));
    const index = pending.findIndex(card => (card.dependsOnIssueIds ?? []).every(id => !ids.has(id) || placed.has(id)));
    ordered.push(...pending.splice(Math.max(index, 0), 1));
  }
  return ordered;
}

/**
 * The cards as an approved spec: each card's approved feature spec and open
 * checklist items, or the card itself when it has neither. The brief carries
 * each card's description and the build order.
 */
export function boardCardSpec(
  cards: readonly Issue[],
  approvedSpecFor: (card: Issue) => FeatureSpec | undefined
): { requirements: OrchestrationPlan['requirements']; exclusions: string[]; brief: string } {
  const requirements: OrchestrationPlan['requirements'] = [];
  const exclusions: string[] = [];
  for (const card of cards) {
    const spec = approvedSpecFor(card);
    const own = [
      ...(spec ? plannerRequirementsFromSpec(spec).map(item => ({ ...item, id: `${card.identifier}-${item.id}` })) : []),
      ...manualChecklistRequirements(card.subtasks ?? [])
    ];
    if (spec) exclusions.push(...spec.exclusions);
    if (!own.length) {
      own.push({
        id: 'CARD-' + createHash('sha256').update(JSON.stringify([card.id, card.title, card.description ?? ''])).digest('hex').slice(0, 24),
        description: [card.title, card.description?.trim()].filter(Boolean).join(': ')
      });
    }
    requirements.push(...own.map(item => ({ ...item, description: clip(`${clip(card.title, 120)}: ${item.description}`, 4_000) })));
  }
  const describe = (card: Issue, index: number) => {
    const detail = card.description?.trim();
    const extra = detail && detail !== card.title.trim() ? ` — ${clip(detail, MAX_CARD_TEXT)}` : '';
    return `${index + 1}. ${clip(card.title, 160)} (priority: ${card.priority})${extra}`;
  };
  const brief = [
    'The person asked Alpha to build these board tasks. Each task\'s checklist items are its requirements, and every requirement starts with its task\'s title. Build them in this order; a later task may rely on an earlier one:',
    ...cards.map(describe),
    'These tasks are the current product scope. Where projectContext describes the product differently, follow these tasks.'
  ].join('\n');
  return { requirements, exclusions: [...new Set(exclusions)], brief: clip(brief, 3_000) };
}
