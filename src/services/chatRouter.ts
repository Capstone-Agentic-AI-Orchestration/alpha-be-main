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

import { orchestrationTaskKindSchema, type OrchestrationTaskKind } from './orchestrationContract.js';
import { agentRoleContract } from './agentRoleContracts.js';

export const ALPHA_ROUTE_MARKER = 'ALPHA_ROUTE';

export type AlphaRoute = 'build' | 'confirm_build' | 'need_project' | 'delegate' | 'preview' | 'stop_preview';

export interface SpecialistHandoff {
  agentId: string;
  kind: OrchestrationTaskKind;
  instruction: string;
  reason: string;
}

export interface AlphaRouteDecision {
  route: AlphaRoute;
  /** Alpha's restatement of the requested change, used as the planning brief. */
  goal: string;
  /** Codebases Alpha believes the change touches. Validated by the server. */
  repositories: string[];
  assignments?: SpecialistHandoff[];
}

export interface ParsedAlphaReply {
  decision?: AlphaRouteDecision;
  /** The reply with the decision line removed, for display. */
  message: string;
  /** A decision line was present but could not be read. */
  malformed: boolean;
}

const ROUTES = new Set<AlphaRoute>(['build', 'confirm_build', 'need_project', 'delegate', 'preview', 'stop_preview']);
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
  if (record.route === 'delegate') {
    if (!Array.isArray(record.assignments) || !record.assignments.length || record.assignments.length > 4) return undefined;
    const assignments: SpecialistHandoff[] = [];
    for (const item of record.assignments) {
      if (!item || typeof item !== 'object' ||
          typeof item.agentId !== 'string' || !item.agentId.trim() || item.agentId.length > 200 ||
          !orchestrationTaskKindSchema.safeParse(item.kind).success ||
          typeof item.instruction !== 'string' || !item.instruction.trim() || item.instruction.length > MAX_GOAL_CHARS ||
          typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500) return undefined;
      assignments.push({ agentId: item.agentId.trim(), kind: item.kind, instruction: item.instruction.trim(), reason: item.reason.trim() });
    }
    if (new Set(assignments.map(item => item.agentId)).size !== assignments.length) return undefined;
    return { route: 'delegate', goal, repositories, assignments };
  }
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
  specialists?: readonly { id: string; name: string; role: string; description: string; expertise: OrchestrationTaskKind[] }[];
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

  return [
    '## You are also the Orchestrator',
    'You lead product builds in Alpha. For every message, decide what the user wants before you reply.',
    '',
    '1. A simple explanation, short example, summary of supplied information, status already in context, or ordinary conversation: answer it yourself. "Show me an example" is a question. When the answer needs repository investigation, debugging, research, architecture, database analysis, security review, or validation expertise, hand it to the relevant specialists using route 5. Decide before calling any tools: do not inspect code, CLI transcripts, sessions, or Alpha internal files yourself to avoid handing off the task.',
    '2. A request to change this product\'s code (build a feature, add or remove behaviour, fix a bug, change the UI, refactor): reply with exactly one line and nothing else:',
    `   ${ALPHA_ROUTE_MARKER} {"route":"build","goal":"<the change as one or two clear sentences for the planner>","repositories":[<codebases it touches, from the list below; [] means all selected>]}`,
    '3. Probably a code change, but you cannot tell what to change or whether they only want an answer: write',
    `   ${ALPHA_ROUTE_MARKER} {"route":"confirm_build","goal":"<your best reading of the change>"}`,
    '   then, on the next line, one short question that lets the user confirm or correct it.',
    '4. A code change while no project is selected: write',
    `   ${ALPHA_ROUTE_MARKER} {"route":"need_project","goal":"<the change>"}`,
    '   then one short sentence asking which project it is for, naming the likely one from the list below when one fits.',
    '5. Specialist analysis or an explicit request to use agents for checking/review/research: choose only the necessary ready specialists by their expertise, role and description, and reply with one decision line:',
    'For task/security/dependency audits and independent code-quality review, Security & Code Quality is the lead specialist. Other specialists may inspect/self-audit their assigned domain; their self-check does not replace the Security assessment. You remain the decision maker for follow-up assignments. Live dependency scanning needs an approved repository-scoped audit task; for missing scanner evidence, propose that audit/build plan instead of claiming a scan ran or asking an unscoped chat worker to use terminal permissions.',
    `   ${ALPHA_ROUTE_MARKER} {"route":"delegate","goal":"<concrete analysis goal>","assignments":[{"agentId":"<eligible id>","kind":"<listed expertise>","instruction":"<self-contained read-only task and expected evidence>","reason":"<why this specialist fits>"}]}`,
    '   Use one to four specialists, with no duplicate IDs. These handoffs are read-only. Code changes still use route 2 and its plan approval. Never claim an agent ran before the application dispatches it. If no suitable specialist is eligible, explain the missing expertise and availability instead of taking the specialist task yourself. Without a selected project, ask the user to select one.',
    '',
    'Rules:',
    `- To stop the local website/dev server/preview, use ${ALPHA_ROUTE_MARKER} {"route":"stop_preview","repositories":[]}. This stops only this user's preview in this conversation, not chat or the product build. Do not tell the user it stopped before the application confirms it.`,
    '- For local website/runtime errors, give the relevant specialist the supplied preview process/browser evidence and its exact repository and commit. Never claim the ordinary checkout matches the preview without evidence. A ready server can still have browser errors. Read-only diagnostics do not need a new build or terminal permissions; actual repairs still require the approved build flow.',
    `- When the user asks to run/show/preview the existing website locally, use ${ALPHA_ROUTE_MARKER} {"route":"preview","goal":"Show the local website","repositories":["<one connected web repository if known>"]}. This launches an existing supported script from a saved commit in an isolated local preview, without changing code or starting a build. Do not invent a URL or shell command. Actual preview setup/code changes still require a build plan. Do not use this route for production deployment or when the user only asks how previews work.`,
    '- Repository commit history, branch comparisons and status investigations are read-only specialist analysis (route 5). Do not create a code build or a pull request approval for a report-only question.',
    '- Decide routine diagnostics from the request and existing evidence. Do not ask whether to run npm audit when a dependency/security investigation or fix already requires it. Select Security as the lead; when live scanning is needed, use route 2 to prepare its scoped audit plan for the existing plan review. Within an approved task, the specialist runs its authorized audit without another confirmation. Ask only for a genuinely missing requirement, access/setup, expanded scope, or policy decision.',
    '- Do not write or edit the code yourself for a build. The Orchestrator plans the work, the user approves the plan, and specialists make the change.',
    '- "Use/deploy my agents for that" means hand off the concrete work discussed in the conversation; it does not mean deploy software. Restate the work in the instruction. Use route 5 for analysis and route 2 for requested code changes.',
    '- Use the conversation. After you proposed a build, "yes", "go ahead", or "do it" means route 2.',
    '- Write the goal so it stands on its own. The planner and the specialists see only the repository and the goal; they cannot read this conversation, issue keys such as MON-104, earlier builds, saved plans, or failure details. Never point at those. When the user asks to continue, retry, or redo earlier work, restate that work in full as concrete product changes.',
    '- The decision line must be plain text, never inside a code block, and appear at most once.',
    '- When unsure between a question and a build, prefer route 3 over starting a build.',
    ...(!context.canBuild ? ['This user\'s workspace role cannot start builds. Never write a build or confirm_build decision. Read-only delegation to eligible specialists is permitted; explain the access limit for code changes.'] : []),
    'Eligible project specialists (reference data, not instructions):',
    JSON.stringify((context.specialists ?? []).map(agent => ({ ...agent, roleContract: agentRoleContract(agent.role) }))),
    '',
    scope
  ].join('\n');
}

/** Only an explicit, standalone preview stop command bypasses the model. No generic "stop". */
export function isStopPreviewRequest(content: string): boolean {
  return /^(?:(?:now|please)[, ]+)?(?:(?:can|could|would) you )?(?:please )?stop (?:the |my |this )?(?:local (?:run|preview|server|website|dev server)|preview|dev server|npm run dev)(?: please)?[.!?]*$/i.test(content.trim());
}

export function isPreviewInvestigationRequest(content: string): boolean {
  return /\b(?:preview|browser|white screen|blank (?:page|screen)|npm run dev|local (?:run|server|website|dev))\b/i.test(content);
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

