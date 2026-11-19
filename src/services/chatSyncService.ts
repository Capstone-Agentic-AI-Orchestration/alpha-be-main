import type { ChatMessage, ChatThread } from '../models/index.js';
import { knownIdentity } from './identityService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { sqliteService } from './sqliteService.js';
import { supabaseService, type ChatSyncOutcome } from './supabaseService.js';
import { logInfo } from '../utils/logger.js';

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 30 * 60_000;
const FLUSH_LIMIT = 100;

let activeFlush: Promise<void> | null = null;
let retryTimer: NodeJS.Timeout | null = null;

function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 9), RETRY_MAX_MS);
}

async function deliver(item: ReturnType<typeof sqliteService.getDueChatSyncItems>[number]): Promise<ChatSyncOutcome> {
  return runWithWorkspace(item.workspaceId, async () => {
    switch (item.operation) {
      case 'share_thread':
        return supabaseService.shareThread(item.payload as unknown as ChatThread, item.workspaceId, item.ownerId);
      case 'share_message':
        return supabaseService.shareMessage(item.payload as unknown as ChatMessage, item.workspaceId);
      case 'delete_thread':
        return supabaseService.unshareThread(item.threadId, item.workspaceId);
      case 'clear_messages':
        return supabaseService.unshareMessages(item.threadId, item.workspaceId);
    }
  });
}

/** Publish durable chat changes in order, keeping each thread's mutations serialized. */
export function flushChatSyncOutbox(): Promise<void> {
  if (activeFlush) return activeFlush;
  activeFlush = flush().finally(() => { activeFlush = null; });
  return activeFlush;
}

async function flush(): Promise<void> {
  if (!supabaseService.sharesBoard()) return;
  const identity = knownIdentity();
  if (!identity?.login) return;

  for (let deliveredCount = 0; deliveredCount < FLUSH_LIMIT; deliveredCount += 1) {
    const item = sqliteService.getDueChatSyncItems(1, new Date().toISOString(), identity.login)[0];
    if (!item) return;
    let outcome: ChatSyncOutcome = 'retry';
    try {
      outcome = await deliver(item);
    } catch {
      outcome = 'retry';
    }
    if (outcome === 'delivered') {
      sqliteService.markChatSyncDelivered(item.id);
      continue;
    }
    // Refused for good (the reason is logged where it was refused): stop retrying it, so it
    // no longer holds back the thread's later changes. It used to be retried every half hour, for ever.
    if (outcome === 'rejected') {
      sqliteService.discardChatSyncItem(item.id);
      continue;
    }
    sqliteService.scheduleChatSyncRetry(
      item.id,
      new Date(Date.now() + retryDelay(item.attempts)).toISOString()
    );
  }
}

/** Retry any saved changes when connectivity returns or the app resumes. */
export function startChatSyncRetryLoop(): () => void {
  if (retryTimer) return () => undefined;
  // Shares queued for threads deleted before deleting cleared them can never matter; drop them once.
  const orphaned = sqliteService.purgeOrphanedChatSync();
  if (orphaned) logInfo(`Dropped ${orphaned} queued chat change(s) for conversations that no longer exist on this computer.`);
  retryTimer = setInterval(() => { void flushChatSyncOutbox(); }, 15_000);
  retryTimer.unref?.();
  return () => {
    if (!retryTimer) return;
    clearInterval(retryTimer);
    retryTimer = null;
  };
}

export function retryChatSync(workspaceId: string, ownerId: string, threadId?: string): number {
  const count = sqliteService.retryChatSyncForOwner(workspaceId, ownerId, threadId);
  void flushChatSyncOutbox();
  return count;
}
