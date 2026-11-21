import type { OrchestrationPlan } from './orchestrationContract.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { WorkspaceContext } from './workspaceRegistry.js';
import type { ChatBuildDecision } from './chatBuildDecision.js';

/**
 * What the Orchestrator can do about a build from the project chat.
 *
 * The chat used to put a narrow gate in front of every message while a build
 * waited on a decision: the only answers it understood were "yes", "a
 * question" and "unclear", so "add a backend task", "drop this plan" or
 * "change it" all got the same canned reply. Now the Orchestrator's own turn
 * chooses one of these actions, and each one checks its own rules here, on the
 * server: role, conversation, current revision, status, and for anything that
 * changes code or reaches GitHub, the person's own words authorising it.
 */
export const CHAT_ACTION_ROUTES = [
  'start_plan', 'revise_plan', 'replace_plan', 'cancel_plan', 'restore_plan',
  'publish', 'retry_publication', 'request_changes', 'merge_dev'
] as const;
export type ChatActionRoute = typeof CHAT_ACTION_ROUTES[number];

export function isChatActionRoute(route: string): route is ChatActionRoute {
  return (CHAT_ACTION_ROUTES as readonly string[]).includes(route);
}

/** Actions that change code or reach GitHub: they run only on the person's own words. */
const NEEDS_CONSENT = new Set<ChatActionRoute>(['start_plan', 'publish', 'retry_publication', 'request_changes', 'merge_dev']);

/** A plan set aside from the chat (replaced or cancelled) is kept and can be restored. */
export const SET_ASIDE_REASON = 'Set aside from the project chat. It can be restored.';

const MAX_INSTRUCTION_CHARS = 2_000;

export type ChatActionOutcome =
  | { kind: 'reply'; message: string }
  /** Plan a build from the chat: a replacement request, or a restored plan as it was. */
  | { kind: 'build'; request: string; repositories: string[]; presetPlan?: OrchestrationPlan; note: string };

export interface ChatActionInput {
  route: ChatActionRoute;
  context: WorkspaceContext;
  projectId: string;
  threadId: string;
  messageId: string;
  /** The person's current message, the only place consent can come from. */
  message: string;
  /** The words of the current message the Orchestrator says it is acting on. */
  evidence?: string;
  /** The change to make, for revise_plan and request_changes. */
  instruction?: string;
  /** The whole new request, for replace_plan. */
  goal?: string;
  /** The revision the person was looking at, when the app sent one. */
  buildDecision?: ChatBuildDecision;
  /** The message carried files: content the person did not type can never authorise an action. */
  hasAttachments?: boolean;
}

export interface ChatActionDeps {
  pending(projectId: string, threadId: string): OrchestrationSnapshot[];
  /** The most recent plan in this conversation that was set aside from the chat and never started. */
  setAside(threadId: string): OrchestrationSnapshot | undefined;
  can(role: WorkspaceContext['role'], capability: string): boolean;
  orchestrationEnabled: boolean;
  decide(input: { context: WorkspaceContext; projectId: string; runId: string; action: 'start' | 'approve' | 'retry_publication';
    expectedRevision?: number; threadId: string; planVersion?: number }): Promise<OrchestrationSnapshot>;
  revise(context: WorkspaceContext, runId: string, revision: number, instruction: string): Promise<OrchestrationSnapshot>;
  cancel(input: { workspaceId: string; runId: string; expectedRevision: number; actorId: string; reason: string }): Promise<OrchestrationSnapshot>;
  requestChanges(input: { context: WorkspaceContext; projectId: string; runId: string; expectedRunRevision: number; feedback: string }): Promise<OrchestrationSnapshot>;
  merge(input: { context: WorkspaceContext; projectId: string; threadId: string; messageId: string }): Promise<string>;
  /**
   * An isolated second look (no tools, repository, attachments or history) that must agree the
   * message asks for this action. Text planted in a file the main turn read cannot pass it.
   */
  confirmConsent(input: { message: string; route: ChatActionRoute; status: string }): Promise<boolean>;
}

/**
 * Whether the person's current message authorises the action: the Orchestrator
 * must quote the whole message. The model cannot make consent up, earlier
 * messages never count, and an approving fragment cannot be lifted out of a
 * refusal ("start" from "do not start").
 */
export function quotedConsent(message: string, evidence: string | undefined): boolean {
  const normalize = (value: string) => {
    let text = value.toLowerCase().replace(/\s+/g, ' ').trim();
    while (text.endsWith('.') || text.endsWith('!')) text = text.slice(0, -1).trimEnd();
    return text;
  };
  const quoted = normalize(evidence ?? '');
  return quoted.length > 0 && quoted === normalize(message);
}

const reply = (message: string): ChatActionOutcome => ({ kind: 'reply', message });

/**
 * Consent for an action that changes code or reaches GitHub. All must hold: the person typed
 * it (no attachments, no @-address or slash command), the main turn quoted the whole message,
 * and the isolated check, which saw nothing but the message and the build's state, agrees.
 */
async function hasConsent(input: ChatActionInput, deps: ChatActionDeps): Promise<boolean> {
  if (input.hasAttachments || /^\s*[@/]/.test(input.message)) return false;
  if (!quotedConsent(input.message, input.evidence)) return false;
  const status = deps.pending(input.projectId, input.threadId)[0]?.run.status ?? 'completed';
  try {
    return await deps.confirmConsent({ message: input.message, route: input.route, status });
  } catch {
    return false;
  }
}

/** Run one chat action after its own checks. Never throws: every outcome is something to say. */
export async function runChatAction(input: ChatActionInput, deps: ChatActionDeps): Promise<ChatActionOutcome> {
  try {
    if (NEEDS_CONSENT.has(input.route) && !await hasConsent(input, deps)) return askForConsent(input, deps);
    switch (input.route) {
      case 'start_plan': return await startPlan(input, deps);
      case 'publish': return await publish(input, deps, 'approve');
      case 'retry_publication': return await publish(input, deps, 'retry_publication');
      case 'request_changes': return await requestChanges(input, deps);
      case 'revise_plan': return await revisePlan(input, deps);
      case 'replace_plan': return await replacePlan(input, deps);
      case 'cancel_plan': return await cancelPlan(input, deps);
      case 'restore_plan': return await restorePlan(input, deps);
      case 'merge_dev': return reply(await deps.merge({ context: input.context, projectId: input.projectId, threadId: input.threadId, messageId: input.messageId }));
    }
  } catch (error) {
    return reply(`I couldn't do that: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One waiting build in this conversation with one of the given statuses, or what to say instead. */
function onePending(input: ChatActionInput, deps: ChatActionDeps, statuses: readonly string[], noun: string): OrchestrationSnapshot | ChatActionOutcome {
  const pending = deps.pending(input.projectId, input.threadId);
  if (pending.length > 1) return reply('More than one build is waiting on you in this conversation. Tell me which one you mean, or finish one first.');
  const snapshot = pending.find(item => statuses.includes(item.run.status));
  if (!snapshot) return reply(`There is no ${noun} waiting in this conversation right now.`);
  return snapshot;
}

function isOutcome(value: OrchestrationSnapshot | ChatActionOutcome): value is ChatActionOutcome {
  return 'kind' in value;
}

function askForConsent(input: ChatActionInput, deps: ChatActionDeps): ChatActionOutcome {
  const plan = deps.pending(input.projectId, input.threadId).find(item => item.run.status === 'awaiting_plan_approval');
  switch (input.route) {
    case 'start_plan': return reply(plan
      ? `Plan v${plan.run.planVersion} is ready on the right. I'll start it as soon as you tell me to, or use Start plan on the card.`
      : 'There is no plan waiting to start in this conversation.');
    case 'publish': return reply('The reviewed changes are ready. Tell me to push them and open the pull request when you want that.');
    case 'retry_publication': return reply('Publishing stopped. Tell me to retry it when you want to.');
    case 'request_changes': return reply('Tell me what should change in the finished work, and I\'ll send it back to the specialists.');
    case 'merge_dev': return reply('Tell me to merge the pull request into dev when you want it merged.');
    default: return reply('Tell me what you would like me to do.');
  }
}

function revisionFor(input: ChatActionInput, snapshot: OrchestrationSnapshot): { expectedRevision: number; planVersion: number } {
  const viewed = input.buildDecision?.runId === snapshot.run.id ? input.buildDecision : undefined;
  return { expectedRevision: viewed?.expectedRevision ?? snapshot.run.revision, planVersion: viewed?.planVersion ?? snapshot.run.planVersion };
}

async function startPlan(input: ChatActionInput, deps: ChatActionDeps): Promise<ChatActionOutcome> {
  const snapshot = onePending(input, deps, ['awaiting_plan_approval'], 'plan');
  if (isOutcome(snapshot)) return snapshot;
  if (input.buildDecision?.runId === snapshot.run.id && !input.buildDecision.evidenceReady) {
    return reply('The plan is still loading on the right. Read it, then tell me to start it.');
  }
  const next = await deps.decide({ context: input.context, projectId: input.projectId, runId: snapshot.run.id, action: 'start',
    threadId: input.threadId, ...revisionFor(input, snapshot) });
  return reply(next.run.status === 'executing'
    ? `Plan v${next.run.planVersion} started. Follow the agents and instructions in the right panel.`
    : `The start request returned build status: ${next.run.status}. Check the right panel for its current outcome.`);
}

async function publish(input: ChatActionInput, deps: ChatActionDeps, action: 'approve' | 'retry_publication'): Promise<ChatActionOutcome> {
  const snapshot = onePending(input, deps, action === 'approve' ? ['awaiting_approval'] : ['publishing'],
    action === 'approve' ? 'reviewed build' : 'stopped publication');
  if (isOutcome(snapshot)) return snapshot;
  const next = await deps.decide({ context: input.context, projectId: input.projectId, runId: snapshot.run.id, action,
    threadId: input.threadId, ...revisionFor(input, snapshot) });
  if (next.run.status === 'completed') return reply('Publication completed. The pull request and review details are in the right panel.');
  if (next.run.status === 'publishing') return reply('Publication is in progress. Its review details are in the right panel.');
  return reply(`Publication has not completed. The build reports: ${next.run.status}.`);
}

async function requestChanges(input: ChatActionInput, deps: ChatActionDeps): Promise<ChatActionOutcome> {
  const snapshot = onePending(input, deps, ['awaiting_approval'], 'finished build to review');
  if (isOutcome(snapshot)) return snapshot;
  const feedback = (input.instruction ?? '').trim();
  if (!feedback) return reply('What should change in the finished work?');
  if (feedback.length > MAX_INSTRUCTION_CHARS) return reply(`Keep the requested change under ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`);
  if (!['build.publish', 'agent.run', 'chat.write'].every(capability => deps.can(input.context.role, capability))) {
    return reply('Your workspace role cannot send finished work back. A project manager or developer can.');
  }
  if (!deps.orchestrationEnabled) return reply('The Orchestrator is unavailable in this desktop version. Update the app before sending work back.');
  await deps.requestChanges({ context: input.context, projectId: input.projectId, runId: snapshot.run.id,
    expectedRunRevision: snapshot.run.revision, feedback });
  return reply('I sent the work back to its specialists with your change. They correct it on the same branch, then it is reviewed and validated again before it comes back to you.');
}

async function revisePlan(input: ChatActionInput, deps: ChatActionDeps): Promise<ChatActionOutcome> {
  const snapshot = onePending(input, deps, ['awaiting_plan_approval'], 'plan');
  if (isOutcome(snapshot)) return snapshot;
  const instruction = (input.instruction ?? '').trim();
  if (!instruction) return reply('How should the plan change?');
  if (instruction.length > MAX_INSTRUCTION_CHARS) return reply(`Keep the requested change under ${MAX_INSTRUCTION_CHARS.toLocaleString()} characters.`);
  if (!deps.can(input.context.role, 'agent.run') || !deps.can(input.context.role, 'chat.write')) {
    return reply('Your workspace role cannot change a build plan. A developer can.');
  }
  try {
    const next = await deps.revise(input.context, snapshot.run.id, snapshot.run.revision, instruction);
    return reply(`I revised the plan; it is now plan v${next.run.planVersion}. Review it on the right and tell me to start it when it looks right.`);
  } catch (error) {
    return reply(`I couldn't revise the plan in place: ${error instanceof Error ? error.message : String(error)} If you want different or extra work, I can replace the plan with a new one; the current plan is kept and can be restored.`);
  }
}

async function replacePlan(input: ChatActionInput, deps: ChatActionDeps): Promise<ChatActionOutcome> {
  const snapshot = onePending(input, deps, ['awaiting_plan_approval'], 'plan');
  if (isOutcome(snapshot)) return snapshot;
  const goal = (input.goal ?? '').trim();
  if (!goal) return reply('What should the new plan cover?');
  if (!deps.can(input.context.role, 'agent.run')) return reply('Your workspace role cannot start builds. A developer can.');
  await setAside(input, deps, snapshot);
  return { kind: 'build', request: goal, repositories: [],
    note: `I set aside plan v${snapshot.run.planVersion} and planned the new request instead. Say "restore the previous plan" to bring it back.` };
}

async function cancelPlan(input: ChatActionInput, deps: ChatActionDeps): Promise<ChatActionOutcome> {
  const snapshot = onePending(input, deps, ['awaiting_plan_approval'], 'plan');
  if (isOutcome(snapshot)) return snapshot;
  if (!deps.can(input.context.role, 'agent.run')) return reply('Your workspace role cannot change builds. A developer can.');
  await setAside(input, deps, snapshot);
  return reply(`I set aside plan v${snapshot.run.planVersion}; nothing was started. Say "restore the previous plan" if you want it back.`);
}

async function restorePlan(input: ChatActionInput, deps: ChatActionDeps): Promise<ChatActionOutcome> {
  const previous = deps.setAside(input.threadId);
  if (!previous?.run.plan) return reply('There is no set-aside plan in this conversation to restore.');
  if (!deps.can(input.context.role, 'agent.run')) return reply('Your workspace role cannot start builds. A developer can.');
  const pending = deps.pending(input.projectId, input.threadId);
  if (pending.some(item => item.run.status !== 'awaiting_plan_approval')) {
    return reply('A build is already under way in this conversation. Restore the earlier plan once it finishes, or stop it first.');
  }
  // The plan waiting now gives way to the restored one, and can itself be restored later.
  for (const current of pending) await setAside(input, deps, current);
  return { kind: 'build', request: previous.run.plan.goal, presetPlan: previous.run.plan,
    repositories: (previous.run.repositoryWorkspaces ?? []).map(item => item.repository),
    note: 'I restored the plan you set aside, exactly as it was. Review it on the right and tell me to start it when you are ready.' };
}

async function setAside(input: ChatActionInput, deps: ChatActionDeps, snapshot: OrchestrationSnapshot): Promise<void> {
  await deps.cancel({ workspaceId: input.context.workspaceId, runId: snapshot.run.id, expectedRevision: snapshot.run.revision,
    actorId: input.context.userId, reason: SET_ASIDE_REASON });
}
