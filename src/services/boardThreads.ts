import { createHash } from 'node:crypto';

/**
 * Private conversations the project board owns.
 *
 * A build started from a task card runs through the same chat path as a build
 * started in project chat, because the engine relies on a conversation for CI
 * repair, milestone notices, previews, recovery, attachments, and usage. The
 * board gives each person one private thread per task, plus one answer-only
 * thread per project for general questions.
 *
 * The id is derived from workspace, owner, and task, so every desktop finds the
 * same thread without a lookup table, and the prefix lets the Chat tab leave
 * these threads out of its list in every store, including the cloud copy that
 * has no column for it.
 */
export const BOARD_THREAD_PREFIX = 'task-';
const ASK_THREAD_PREFIX = `${BOARD_THREAD_PREFIX}ask-`;

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/** One person's private build conversation for one task. */
export function taskThreadId(workspaceId: string, ownerId: string, issueId: string): string {
  return `${BOARD_THREAD_PREFIX}${digest(workspaceId, ownerId, 'issue', issueId)}`;
}

/** One person's answer-only "Ask Alpha" conversation for one project. */
export function projectAskThreadId(workspaceId: string, ownerId: string, projectId: string): string {
  return `${ASK_THREAD_PREFIX}${digest(workspaceId, ownerId, 'project', projectId)}`;
}

/** True for every thread the board owns; the Chat tab does not list these. */
export function isBoardThreadId(threadId: string): boolean {
  return threadId.startsWith(BOARD_THREAD_PREFIX);
}

/** True for a project's answer-only thread, which may never start a build. */
export function isAskThreadId(threadId: string): boolean {
  return threadId.startsWith(ASK_THREAD_PREFIX);
}
