import type { ChatMessage, ChatThread } from '../models/index.js';
import { sqliteService } from '../services/sqliteService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import type { ChatStore } from './chatStore.js';

/**
 * Conversations on a developer's machine.
 *
 * A thin adapter over `sqliteService`, which still owns the SQL: the runner
 * reads a thread mid-run, synchronously, from the same file the rest of the
 * desktop's state is in.
 */
export class SqliteChatStore implements ChatStore {
  async listThreads(workspaceId: string, ownerId: string): Promise<ChatThread[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getChatThreads(ownerId));
  }

  async messages(workspaceId: string, threadId: string, ownerId: string): Promise<ChatMessage[] | null> {
    return runWithWorkspace(workspaceId, () => {
      const mine = sqliteService.getChatThreads(ownerId).some(thread => thread.id === threadId);
      return mine ? sqliteService.getChatMessages(threadId) : null;
    });
  }
}
