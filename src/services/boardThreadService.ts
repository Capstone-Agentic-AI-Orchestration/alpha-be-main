import type { ChatThread, Issue } from '../models/index.js';
import { projectAskThreadId, taskThreadId } from './boardThreads.js';
import { createThreadAndShare } from './chatWriteThrough.js';
import { sqliteService } from './sqliteService.js';
import { workspaceRegistry } from './workspaceRegistry.js';

/**
 * The caller's private board conversation, created on first use.
 *
 * With an issue it is that task's build thread; without one it is the
 * project's answer-only Ask Alpha thread. The id is derived, so repeating the
 * call returns the same thread.
 */
export function ensureBoardThread(input: {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  issue?: Pick<Issue, 'id' | 'identifier'>;
}): { thread: ChatThread; created: boolean } {
  const id = input.issue
    ? taskThreadId(input.workspaceId, input.ownerId, input.issue.id)
    : projectAskThreadId(input.workspaceId, input.ownerId, input.projectId);
  const existing = workspaceRegistry
    .scope('chat_threads', sqliteService.getChatThreads(input.ownerId), input.workspaceId)
    .find(thread => thread.id === id);
  if (existing) return { thread: existing, created: false };
  const thread = createThreadAndShare({
    id,
    title: input.issue ? `Build ${input.issue.identifier}` : 'Ask Alpha',
    projectId: input.projectId,
    ownerId: input.ownerId
  });
  workspaceRegistry.bind('chat_threads', thread.id, input.workspaceId);
  return { thread, created: true };
}

