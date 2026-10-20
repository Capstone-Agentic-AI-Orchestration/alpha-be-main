import type { ChatMessage, ChatThread } from '../models/index.js';
import { chatBuildRequestKey } from '../services/chatBuildIdentity.js';
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
      const thread = sqliteService.getChatThreads(ownerId).find(item => item.id === threadId);
      if (!thread) return null;
      const messages = sqliteService.getChatMessages(threadId);
      if (!thread.projectId) return messages;
      return messages.map(message => {
        if (message.messageType !== 'build' || message.orchestrationRunId || !message.id.endsWith('-build')) return message;
        const sourceMessageId = message.id.slice(0, -'-build'.length);
        const requestKey = chatBuildRequestKey(workspaceId, threadId, sourceMessageId);
        const snapshot = sqliteService.getOrchestrationByRequestKey(requestKey);
        return snapshot && snapshot.run.projectId === thread.projectId
          ? { ...message, orchestrationRunId: snapshot.run.id }
          : message;
      });
    });
  }
}
