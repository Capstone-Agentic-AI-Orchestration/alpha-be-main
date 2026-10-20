import crypto from 'node:crypto';

/** Stable request identity shared by chat build creation and chat history. */
export function chatBuildRequestKey(workspaceId: string, threadId: string, messageId: string): string {
  return crypto.createHash('sha256').update(`${workspaceId}:${threadId}:${messageId}`).digest('hex').slice(0, 16);
}
