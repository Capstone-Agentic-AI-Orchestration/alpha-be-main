import type { ChatMessage, ChatThread } from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { supabaseService } from './supabaseService.js';

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
  void supabaseService.shareThread(thread);
  return thread;
}

/** For the routes that change one field of a thread: the row as it now stands. */
export function shareThread(thread: ChatThread | null): void {
  if (thread) void supabaseService.shareThread(thread);
}

export function saveChatMessageAndShare(message: ChatMessage): ChatMessage {
  sqliteService.saveChatMessage(message);
  const saved = message;
  void supabaseService.shareMessage(saved);
  /*
   * The thread carries the snippet and the time of its last message, which
   * `saveChatMessage` has just moved on. Published too, or the list on the web
   * would order conversations by a moment that is no longer the last one.
   */
  const thread = sqliteService.getChatThreads().find(candidate => candidate.id === saved.threadId);
  if (thread) void supabaseService.shareThread(thread);
  return saved;
}

export function deleteThreadAndShare(threadId: string): boolean {
  const deleted = sqliteService.deleteChatThread(threadId);
  if (deleted) void supabaseService.unshareThread(threadId);
  return deleted;
}

export function clearMessagesAndShare(threadId: string): number {
  const removed = sqliteService.clearChatMessages(threadId);
  if (removed >= 0) void supabaseService.unshareMessages(threadId);
  return removed;
}
