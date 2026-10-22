/**
 * Alpha decides how a chat message is handled.
 *
 * The chat used to ask the user to pick a mode (Auto, Build, Ask) and then
 * guessed "Auto" from a keyword regex that saw one message in isolation. Alpha
 * now answers every unaddressed message as the Orchestrator: it answers
 * questions itself, and when the user wants a product change it returns one
 * structured decision line. The server parses that line and still owns every
 * check that matters — permission, project, codebases — before a build starts.
 */

export const ALPHA_ROUTE_MARKER = 'ALPHA_ROUTE';

export type AlphaRoute = 'build' | 'confirm_build' | 'need_project';

export interface AlphaRouteDecision {
  route: AlphaRoute;
  /** Alpha's restatement of the requested change, used as the planning brief. */
  goal: string;
  /** Codebases Alpha believes the change touches. Validated by the server. */
  repositories: string[];
}

export interface ParsedAlphaReply {
  decision?: AlphaRouteDecision;
  /** The reply with the decision line removed, for display. */
  message: string;
  /** A decision line was present but could not be read. */
  malformed: boolean;
}

const ROUTES = new Set<AlphaRoute>(['build', 'confirm_build', 'need_project']);
const MAX_GOAL_CHARS = 4_000;
const MARKER_LINE = new RegExp(`^\\s*\`?\\s*${ALPHA_ROUTE_MARKER}\\b\\s*(.*?)\\s*\`?\\s*$`);

/**
 * Read Alpha's decision line, if it wrote one.
 *
 * Accepts the marker on any line outside a fenced code block, because models
 * sometimes add a sentence before it. A marker inside a code block is example
 * text, never a decision. Only the first marker counts.
 */
export function parseAlphaRoute(reply: string): ParsedAlphaReply {
  const lines = reply.split(/\r?\n/);
  let inFence = false;
  let markerIndex = -1;
  let payload = '';
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = MARKER_LINE.exec(line);
    if (match) {
      markerIndex = index;
      payload = match[1] ?? '';
      break;
    }
  }
  if (markerIndex < 0) return { message: reply.trim(), malformed: false };

  const message = lines
    .filter((_, index) => index !== markerIndex)
    .join('\n')
    .trim();
  const decision = readDecision(payload);
  return decision ? { decision, message, malformed: false } : { message, malformed: true };
}

function readDecision(payload: string): AlphaRouteDecision | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.route !== 'string' || !ROUTES.has(record.route as AlphaRoute)) return undefined;
  const goal = typeof record.goal === 'string' ? record.goal.trim().slice(0, MAX_GOAL_CHARS) : '';
  const repositories = Array.isArray(record.repositories)
    ? [...new Set(record.repositories
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean))].slice(0, 30)
    : [];
  return { route: record.route as AlphaRoute, goal, repositories };
}

/** Hidden overrides that replace the old mode buttons for people who want certainty. */
export function parseChatOverride(content: string): { override?: 'build' | 'ask'; content: string } {
  const trimmed = content.trim();
  const match = /^\/(build|ask)(?:\s+|$)/i.exec(trimmed);
  if (!match) return { content: trimmed };
  return {
    override: match[1].toLowerCase() as 'build' | 'ask',
    content: trimmed.slice(match[0].length).trim()
  };
}

/**
 * Keep only codebases that belong to this build.
 *
 * The composer's codebase picker is the user's explicit scope. Alpha may narrow
 * it (a frontend-only change) but never widen it. With no picker selection,
 * Alpha's choice stands and the build path rejects anything not attached.
 */
export function chooseBuildRepositories(selected: readonly string[] | undefined, proposed: readonly string[]): string[] {
  const picked = (selected ?? []).map(item => item.trim()).filter(Boolean);
  if (!picked.length) return [...proposed];
  const narrowed = proposed.filter(repo => picked.some(item => item.toLowerCase() === repo.toLowerCase()));
  return narrowed.length ? narrowed : picked;
}

export interface OrchestratorPromptContext {
  projectName?: string;
  repositories: readonly string[];
  selectedRepositories?: readonly string[];
  /** Projects this user can open, so Alpha can list them and suggest one. */
  workspaceProjects?: readonly string[];
  canBuild: boolean;
  /** The user asked for an answer only; no decision line is allowed. */
  answerOnly?: boolean;
}

/** Instructions that make the default assistant act as the Orchestrator. */
export function orchestratorRoutingPrompt(context: OrchestratorPromptContext): string {
  const projectScope = context.projectName
    ? [
        `Project: ${context.projectName}`,
        `Codebases: ${context.repositories.length ? context.repositories.join(', ') : 'none connected yet'}`,
        context.selectedRepositories?.length
          ? `Codebases the user selected for builds: ${context.selectedRepositories.join(', ')}`
          : undefined
      ].filter(Boolean).join('\n')
    : 'Project: none selected in this conversation. The user picks one with the project selector in the chat header.';
  const scope = [
    projectScope,
    context.workspaceProjects?.length
      ? `Projects this user can work in: ${context.workspaceProjects.join(', ')}`
      : 'Projects this user can work in: none yet.'
  ].join('\n');

  if (context.answerOnly) {
    return [
      '## You are also the Orchestrator',
      'The user asked for an answer only. Answer the message directly. Do not start, propose, or plan a build, and do not write the ' + ALPHA_ROUTE_MARKER + ' line.',
      '',
      scope
    ].join('\n');
  }

  if (!context.canBuild) {
    return [
      '## You are also the Orchestrator',
      'You normally lead product builds, but this user\'s workspace role cannot start them.',
      'Answer questions normally. If the user asks you to change the product\'s code, explain that their role cannot start builds and that a project manager can update their access. Never write the ' + ALPHA_ROUTE_MARKER + ' line.',
      '',
      scope
    ].join('\n');
  }

  return [
    '## You are also the Orchestrator',
    'You lead product builds in Alpha. For every message, decide what the user wants before you reply.',
    '',
    '1. A question, explanation, example, code snippet to read, review, summary, status check, opinion, or ordinary conversation: answer it yourself. Never start a build for these, even when the wording uses verbs like "add", "create", or "make". "Can you add some context on how login works?" is a question. "Create an issue for this bug" is a tracking request, not a code change. "Show me an example" is a question.',
    '2. A request to change this product\'s code (build a feature, add or remove behaviour, fix a bug, change the UI, refactor): reply with exactly one line and nothing else:',
    `   ${ALPHA_ROUTE_MARKER} {"route":"build","goal":"<the change as one or two clear sentences for the planner>","repositories":[<codebases it touches, from the list below; [] means all selected>]}`,
    '3. Probably a code change, but you cannot tell what to change or whether they only want an answer: write',
    `   ${ALPHA_ROUTE_MARKER} {"route":"confirm_build","goal":"<your best reading of the change>"}`,
    '   then, on the next line, one short question that lets the user confirm or correct it.',
    '4. A code change while no project is selected: write',
    `   ${ALPHA_ROUTE_MARKER} {"route":"need_project","goal":"<the change>"}`,
    '   then one short sentence asking which project it is for, naming the likely one from the list below when one fits.',
    '',
    'Rules:',
    '- Do not write or edit the code yourself for a build. The Orchestrator plans the work, the user approves the plan, and specialists make the change.',
    '- Use the conversation. After you proposed a build, "yes", "go ahead", or "do it" means route 2.',
    '- Write the goal so it stands on its own. The planner and the specialists see only the repository and the goal; they cannot read this conversation, issue keys such as MON-104, earlier builds, saved plans, or failure details. Never point at those. When the user asks to continue, retry, or redo earlier work, restate that work in full as concrete product changes.',
    '- The decision line must be plain text, never inside a code block, and appear at most once.',
    '- When unsure between a question and a build, prefer route 3 over starting a build.',
    '',
    scope
  ].join('\n');
}

/**
 * "continue", "go ahead", "try again": a request to carry on with earlier
 * work that names no change of its own. Only short messages count, so "continue
 * and also add dark mode" is still read as a request in its own right.
 */
export function isBareContinueRequest(message: string): boolean {
  const text = message.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!text || text.length > 80) return false;
  return /^(?:(?:ok(?:ay)?|yes|yeah|sure|please)[, ]+)?(?:can you |could you |please )?(?:continue|carry on|keep going|go ahead|proceed|resume|retry|try again|run (?:it )?again|start again|do it again|pick (?:it|this) (?:back )?up)(?: (?:with |on )?(?:the |that |this )?(?:plan|build|work|task|redesign|change))?(?: please)?$/.test(text);
}

/**
 * Words a specialist cannot act on: they point at Alpha's own records (issue
 * keys, earlier builds, saved plans, failure details) that are never in the
 * repository a specialist works in.
 */
export function referencesAlphaRecords(goal: string): boolean {
  return /\b[A-Z][A-Z0-9]{1,9}-\d+\b/.test(goal)
    || /\b(?:saved|previous|prior|earlier|last|stopped|failed)\s+(?:build|plan|run|attempt|failure|work)\b/i.test(goal)
    || /\bpreserved work\b/i.test(goal);
}

