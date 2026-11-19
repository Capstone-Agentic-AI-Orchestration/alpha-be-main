import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPermanentRefusal } from './supabaseService.js';

/**
 * The chat sync queue against a real local database, with the cloud faked. The bug this
 * guards: a message the cloud refused for good (row-level security) was treated like a
 * network blip and retried every half hour, for ever, holding back everything queued after
 * it in that conversation -- including the delete of the conversation itself.
 */
describe('which cloud failures are permanent', () => {
  it('treats refusals no retry can change as permanent, and everything else as worth retrying', () => {
    for (const code of ['42501', '23503', '23514', '22001', '22P02']) expect(isPermanentRefusal({ code })).toBe(true);
    for (const value of [{ code: 'PGRST301' }, { code: '08006' }, { code: '57014' }, new TypeError('fetch failed'), null, { message: 'timeout' }]) {
      expect(isPermanentRefusal(value)).toBe(false);
    }
  });
});

describe('publishing queued chat changes', () => {
  let tmp: string;
  let refuse: Set<string>;
  let unreachable: boolean;
  let shared: string[];
  const opened: Array<{ close(): void }> = [];

  async function load() {
    process.env.ALPHA_HOME = tmp;
    vi.resetModules();
    vi.doMock('./identityService.js', () => ({ knownIdentity: () => ({ login: 'owner-a', source: 'github' }) }));
    vi.doMock('./supabaseService.js', async importOriginal => ({
      ...(await importOriginal<typeof import('./supabaseService.js')>()),
      supabaseService: {
        sharesBoard: () => true,
        shareThread: async (thread: { id: string }) => { shared.push(`thread ${thread.id}`); return 'delivered' as const; },
        shareMessage: async (message: { id: string }) => {
          if (unreachable) return 'retry' as const;
          if (refuse.has(message.id)) return 'rejected' as const;
          shared.push(`message ${message.id}`); return 'delivered' as const;
        },
        unshareThread: async (id: string) => { shared.push(`delete ${id}`); return 'delivered' as const; },
        unshareMessages: async (id: string) => { shared.push(`clear ${id}`); return 'delivered' as const; },
      },
    }));
    const { sqliteService } = await import('./sqliteService.js');
    opened.push(sqliteService);
    const { runWithWorkspace } = await import('./workspaceContext.js');
    const sync = await import('./chatSyncService.js');
    const writeThrough = await import('./chatWriteThrough.js');
    const queue = (threadId: string, operation: 'share_thread' | 'share_message', payload: Record<string, unknown>) =>
      runWithWorkspace('ws-a', () => sqliteService.enqueueChatSync({ ownerId: 'owner-a', threadId, operation, payload }));
    const pending = () => sqliteService.getDueChatSyncItems(100, new Date(Date.now() + 86_400_000).toISOString(), 'owner-a');
    return { sqliteService, runWithWorkspace, sync, writeThrough, queue, pending };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-chat-sync-'));
    refuse = new Set(); unreachable = false; shared = [];
  });
  afterEach(() => {
    for (const handle of opened.splice(0)) { try { handle.close(); } catch { /* already closed */ } }
    vi.doUnmock('./identityService.js'); vi.doUnmock('./supabaseService.js');
    delete process.env.ALPHA_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('gives up on a refused message so the rest of its conversation still goes through', async () => {
    const { sync, queue, pending } = await load();
    queue('t1', 'share_thread', { id: 't1' });
    queue('t1', 'share_message', { id: 'refused', threadId: 't1' });
    queue('t1', 'share_message', { id: 'next', threadId: 't1' });
    refuse.add('refused');
    await sync.flushChatSyncOutbox();
    expect(shared).toEqual(['thread t1', 'message next']);
    expect(pending()).toEqual([]);
  });

  it('keeps retrying when the cloud cannot be reached, in order', async () => {
    const { sync, queue, sqliteService } = await load();
    queue('t1', 'share_message', { id: 'm1', threadId: 't1' });
    unreachable = true;
    await sync.flushChatSyncOutbox();
    expect(shared).toEqual([]);
    const [waiting] = sqliteService.getDueChatSyncItems(10, new Date(Date.now() + 86_400_000).toISOString(), 'owner-a');
    expect(waiting).toMatchObject({ attempts: 1, payload: { id: 'm1' } });
  });

  it('drops a deleted conversation\'s pending sends so its delete is not stuck behind them', async () => {
    const { sqliteService, runWithWorkspace, writeThrough, pending } = await load();
    runWithWorkspace('ws-a', () => {
      sqliteService.createChatThread({ id: 't-del', title: 'hello', ownerId: 'owner-a' });
      sqliteService.enqueueChatSync({ ownerId: 'owner-a', threadId: 't-del', operation: 'share_message', payload: { id: 'stuck', threadId: 't-del' } });
      writeThrough.deleteThreadAndShare('t-del');
    });
    expect(pending().map(item => item.operation)).toEqual(['delete_thread']);
  });

  it('clears queued sends for conversations that no longer exist when it starts, keeping deletes', async () => {
    const { sqliteService, runWithWorkspace, sync, queue, pending } = await load();
    runWithWorkspace('ws-a', () => sqliteService.createChatThread({ id: 'kept', title: 'still here', ownerId: 'owner-a' }));
    queue('kept', 'share_message', { id: 'live', threadId: 'kept' });
    queue('gone', 'share_message', { id: 'orphan', threadId: 'gone' });
    runWithWorkspace('ws-a', () => sqliteService.enqueueChatSync({ ownerId: 'owner-a', threadId: 'gone-too', operation: 'delete_thread' }));
    const stop = sync.startChatSyncRetryLoop();
    stop();
    expect(pending().map(item => [item.threadId, item.operation])).toEqual([['kept', 'share_message'], ['gone-too', 'delete_thread']]);
  });
});
