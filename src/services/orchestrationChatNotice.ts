import { createHash } from 'node:crypto';

import type { ChatMessage } from '../models/index.js';
import type { OrchestrationPublicationRecord, OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { runWithWorkspace } from './workspaceContext.js';

/**
 * The Orchestrator telling the build's own chat what happened to its pull request.
 *
 * Publishing used to report only to whoever pressed Approve, and to the right panel.
 * When it failed, the chat (and the agent in it) kept saying "opening the pull request"
 * with no reason. The conversation is where the person and the agent decide what next,
 * so the outcome goes there.
 */

/** The one thing a notice reads: the build chat's messages, to post each notice once. */
export interface NoticeStore { getChatMessages(threadId: string): ChatMessage[] }

async function post(store: NoticeStore, snapshot: OrchestrationSnapshot, id: string, content: string,
  messageType: ChatMessage['messageType'] = 'build_milestone'): Promise<void> {
  const threadId = snapshot.run.originChatThreadId;
  if (!threadId) return;
  await runWithWorkspace(snapshot.run.workspaceId, async () => {
    if (store.getChatMessages(threadId).some(message => message.id === id)) return;
    const message: ChatMessage = {
      id, threadId, senderType: 'agent', senderName: 'Alpha Orchestrator', content,
      messageType, orchestrationRunId: snapshot.run.id, timestamp: new Date().toISOString()
    };
    const { saveChatMessageAndShare } = await import('./chatWriteThrough.js');
    saveChatMessageAndShare(message);
    const { chatService } = await import('./chatService.js');
    chatService.emit('chat_message', message);
  });
}

const repoName = (repository: string | undefined) => (repository ?? '').split('/').pop() || 'the repository';

/** The words for a finished publication: each pull request, and what had nothing to publish. */
export function publishedNotice(publications: OrchestrationPublicationRecord[]): string {
  const opened = publications.filter(item => !item.unchanged && item.pullRequestUrl);
  const unchanged = publications.filter(item => item.unchanged);
  const lines = opened.length
    ? [`Opened the pull ${opened.length === 1 ? 'request' : 'requests'}:`, ...opened.map(item => `- ${repoName(item.repository)}: ${item.pullRequestUrl}`)]
    : ['Nothing to publish: the build changed no repository, so there is no pull request.'];
  if (opened.length && unchanged.length) {
    lines.push(`${unchanged.map(item => repoName(item.repository)).join(', ')} had no changes, so ${unchanged.length === 1 ? 'it has' : 'they have'} no pull request.`);
  }
  if (opened.length) lines.push('Merge on GitHub when you are happy with it.');
  return lines.join('\n');
}

/**
 * A started plan, at the bottom of its conversation. It is a build message, so the chat shows the
 * agents' live progress under it, where the person is reading, instead of only in the pinned card.
 */
export async function postStartedNotice(store: NoticeStore, snapshot: OrchestrationSnapshot): Promise<void> {
  const required = snapshot.tasks.filter(task => task.required).length || snapshot.tasks.length;
  await post(store, snapshot, `${snapshot.run.id}-started-v${snapshot.run.planVersion}`,
    `**Plan v${snapshot.run.planVersion} started.** The agents are working on ${required} ${required === 1 ? 'task' : 'tasks'}; their progress follows here. You can stop the build at any time; work already on the build branch stays available.`,
    'build').catch(() => undefined);
}

/** A plan the Orchestrator corrected before it could start: what failed, what changed, and that it waits for Start. */
export async function postPlanCorrectedNotice(store: NoticeStore, snapshot: OrchestrationSnapshot, reason: string, changes: string[]): Promise<void> {
  await post(store, snapshot, `${snapshot.run.id}-corrected-v${snapshot.run.planVersion}`, [
    `**The plan needed a fix before it could start.** ${reason}`,
    `I made plan v${snapshot.run.planVersion}:`,
    ...changes.map(line => `- ${line}`),
    'Read it on the right, then press Start plan when you are happy with it.'
  ].join('\n'), 'build').catch(() => undefined);
}

/**
 * What the Orchestrator decided for a later milestone, and any conflict its fit check settled. Nobody
 * approves a milestone's plan, so this is where the person learns of them while the build runs.
 * Nothing is posted when there was nothing to decide.
 */
export function milestoneDecisionsNotice(input: {
  milestoneTitle: string;
  decisions: ReadonlyArray<{ about: string; decision: string; toChange?: string }>;
  conflicts: ReadonlyArray<{ subject: string; reason: string; surfacedIn?: string }>;
}): string | undefined {
  if (!input.decisions.length && !input.conflicts.length) return undefined;
  const lines = [`**Alpha planned the next milestone: ${input.milestoneTitle}.**`];
  const toChange = (value?: string) => value ? ' To change this: ' + value : '';
  const settledBy = (value?: string) => value ? ' (settled by: ' + value + ')' : '';
  if (input.decisions.length) {
    lines.push('What the Orchestrator decided:', ...input.decisions.map(item => `- **${item.about}**: ${item.decision}${toChange(item.toChange)}`));
  }
  if (input.conflicts.length) {
    lines.push('Where the work conflicts with the product, and how that was settled:',
      ...input.conflicts.map(item => `- ${item.subject}: ${item.reason}${settledBy(item.surfacedIn)}`));
  }
  lines.push('Tell me here if you want any of it done differently.');
  return lines.join('\n');
}

export async function postMilestoneDecisionsNotice(store: NoticeStore, snapshot: OrchestrationSnapshot, milestoneId: string,
  input: Parameters<typeof milestoneDecisionsNotice>[0]): Promise<void> {
  const content = milestoneDecisionsNotice(input);
  if (content) await post(store, snapshot, `${snapshot.run.id}-milestone-${milestoneId}-decisions`, content).catch(() => undefined);
}

export async function postPublishedNotice(store: NoticeStore, snapshot: OrchestrationSnapshot, publications: OrchestrationPublicationRecord[]): Promise<void> {
  await post(store, snapshot, `${snapshot.run.id}-published`, publishedNotice(publications)).catch(() => undefined);
}

/** Once per distinct reason, so a retry that fails the same way does not repeat itself. */
export async function postPublicationFailedNotice(store: NoticeStore, snapshot: OrchestrationSnapshot, reason: string): Promise<void> {
  const key = createHash('sha256').update(reason).digest('hex').slice(0, 12);
  await post(store, snapshot, `${snapshot.run.id}-publish-failed-${key}`,
    `I couldn't open the pull request: ${reason}\nNothing was merged. Reply "retry" and I'll try again.`).catch(() => undefined);
}
