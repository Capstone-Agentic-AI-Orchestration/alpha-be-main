import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';

describe('durable chat sync outbox', () => {
  let folder: string;
  let store: SQLiteService;
  let dbPath: string;

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(process.cwd(), '.chat-sync-outbox-'));
    dbPath = path.join(folder, 'alpha.sqlite');
    store = new SQLiteService({ dbPath, seedDefaults: false });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('persists queued writes and keeps each thread in mutation order across retries', () => {
    const threadId = 'thread-offline-1';
    const thread = { id: threadId, title: 'Calculator', projectId: 'project-1' };
    const message = { id: 'message-1', threadId, content: 'Build a calculator' };

    runWithWorkspace('workspace-a', () => {
      store.enqueueChatSync({ ownerId: 'owner-a', threadId, operation: 'share_thread', payload: thread });
      store.enqueueChatSync({ ownerId: 'owner-a', threadId, operation: 'share_message', payload: message });
      store.enqueueChatSync({ ownerId: 'owner-b', threadId, operation: 'share_thread', payload: thread });
    });

    const first = store.getDueChatSyncItems(10, new Date(Date.now() + 1_000).toISOString(), 'owner-a');
    expect(first).toHaveLength(1);
    expect(first[0].operation).toBe('share_thread');

    store.markChatSyncDelivered(first[0].id);
    const second = store.getDueChatSyncItems(10, new Date(Date.now() + 1_000).toISOString(), 'owner-a')[0];
    expect(second.operation).toBe('share_message');
    store.scheduleChatSyncRetry(second.id, new Date(Date.now() + 60_000).toISOString());
    expect(store.getChatSyncStatus('workspace-a', 'owner-a', threadId)).toEqual({ pending: 1, failed: 1 });
    expect(store.getDueChatSyncItems(10, new Date(Date.now() + 1_000).toISOString(), 'owner-a')).toHaveLength(0);

    store.retryChatSyncForOwner('workspace-a', 'owner-a', threadId);
    store.close();
    store = new SQLiteService({ dbPath, seedDefaults: false });

    expect(store.getChatSyncStatus('workspace-a', 'owner-a', threadId)).toEqual({ pending: 1, failed: 0 });
    expect(store.getDueChatSyncItems(10, new Date(Date.now() + 1_000).toISOString(), 'owner-a')[0].operation).toBe('share_message');
    expect(store.getDueChatSyncItems(10, new Date(Date.now() + 1_000).toISOString(), 'owner-b')[0].operation).toBe('share_thread');
  });
});
