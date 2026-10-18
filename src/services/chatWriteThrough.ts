import type { ChatMessage, ChatThread } from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { supabaseService } from './supabaseService.js';
import { flushChatSyncOutbox } from './chatSyncService.js';

function enqueue(
  ownerId: string | undefined,
  threadId: string,
  operation: 'share_thread' | 'share_message' | 'delete_thread' | 'clear_messages',
  payload?: ChatThread | ChatMessage
): void {
  if (!supabaseService.sharesBoard() || !ownerId) return;
  sqliteService.enqueueChatSync({
    ownerId,
    threadId,
    operation,
    ...(payload ? { payload: payload as unknown as Record<string, unknown> } : {})
  });
  void flushChatSyncOutbox();
}

/**
 * Write a conversation locally and give it to this person's own cloud copy.
 *
 * A developer's conversations lived in one file on one machine: reinstall the
 * app, or open the web app, and they were gone. They belong to the person
 * rather than to the team, so they go to Postgres under their login, where the
 * policies in `0002_row_level_security.sql` keep them to that login -- no
 * project-manager bypass, deliberately.
 *
 * Wrapped here rather than inside `sqliteService` for the reason
 * `boardWriteThrough` gives: the data layer must stay local-only, or a future
 * pull would publish back everything it had just read.
 *
 * Publishing is not awaited. The local write has already happened and is what
 * the runner and the UI read; a slow network must not hold up a reply.
 */

export function createThreadAndShare(input: Partial<ChatThread> & { ownerId?: string }): ChatThread {
  const thread = sqliteService.createChatThread(input);
  enqueue(thread.ownerId, thread.id, 'share_thread', thread);
  return thread;
}

/** For the routes that change one field of a thread: the row as it now stands. */
export function shareThread(thread: ChatThread | null): void {
  if (thread) enqueue(thread.ownerId, thread.id, 'share_thread', thread);
}

export function saveChatMessageAndShare(message: ChatMessage): ChatMessage {
  sqliteService.saveChatMessage(message);
  const saved = message;
  const thread = sqliteService.getChatThreads().find(candidate => candidate.id === saved.threadId);
  enqueue(thread?.ownerId, saved.threadId, 'share_message', saved);
  /*
   * The thread carries the snippet and the time of its last message, which
   * `saveChatMessage` has just moved on. Published too, or the list on the web
   * would order conversations by a moment that is no longer the last one.
   */
  if (thread) enqueue(thread.ownerId, thread.id, 'share_thread', thread);
  return saved;
}

export function deleteThreadAndShare(threadId: string): boolean {
  const thread = sqliteService.getChatThreads().find(candidate => candidate.id === threadId);
  const deleted = sqliteService.deleteChatThread(threadId);
  if (deleted && thread) enqueue(thread.ownerId, threadId, 'delete_thread');
  return deleted;
}

export function clearMessagesAndShare(threadId: string): number {
  const before = sqliteService.getChatThreads().find(candidate => candidate.id === threadId);
  const removed = sqliteService.clearChatMessages(threadId);
  if (removed >= 0 && before) {
    enqueue(before.ownerId, threadId, 'clear_messages');
    const updated = sqliteService.getChatThreads().find(candidate => candidate.id === threadId);
    if (updated) enqueue(updated.ownerId, updated.id, 'share_thread', updated);
  }
  return removed;
}
