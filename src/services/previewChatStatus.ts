import type { ChatMessage } from '../models/index.js';
import type { LocalPreview } from './localPreviewService.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { saveChatMessageAndShare } from './chatWriteThrough.js';
import { hasPreviewErrors } from './previewDiagnostics.js';

/** State messages contain no surface capability or raw logs. Detailed evidence stays in the preview tab. */
export function recordPreviewChatStatus(record: LocalPreview): ChatMessage | undefined {
  if (!record.messageId || !['starting', 'ready', 'failed', 'stopped'].includes(record.state)) return;
  return runWithWorkspace(record.workspaceId, () => {
    const thread = sqliteService.getChatThreads(record.ownerId).find(thread => thread.id === record.threadId && thread.projectId === record.projectId && thread.ownerId === record.ownerId);
    if (!thread) return;
    const browserErrors = record.state === 'ready' && hasPreviewErrors(record);
    const id = `${record.id}-preview-${browserErrors ? 'browser-errors' : record.state}`;
    if (sqliteService.getChatMessages(record.threadId).some(message => message.id === id)) return;
    const content = record.state === 'starting' ? 'The agents are preparing the website preview. Details are in the right panel.'
      : browserErrors ? 'The website preview reported browser errors. Read the captured diagnostics on the right and reply here for the agents to investigate.'
        : record.state === 'ready' ? `The website preview is ready on the right (${record.commit.slice(0, 8)}). Browser verification is separate from server readiness.`
        : record.state === 'failed' ? 'The website preview encountered an error. Read the startup output and diagnostics on the right, and reply here for the agents to investigate.'
          : 'The website preview has stopped.';
    return saveChatMessageAndShare({ id, threadId: record.threadId, senderType: 'agent', senderName: 'Alpha', content, timestamp: new Date().toISOString() });
  });
}
