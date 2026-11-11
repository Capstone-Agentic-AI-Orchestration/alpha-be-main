import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SQLiteService } from './sqliteService.js';
import type { UsageEntry } from './chatUsage.js';

let store: SQLiteService;
let root: string;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-chat-usage-'));
  vi.stubEnv('ALPHA_HOME', root); vi.resetModules();
  store = (await import('./sqliteService.js')).sqliteService;
  store.createChatThread({ id: 'a', ownerId: 'alice', title: 'A' });
  store.createChatThread({ id: 'b', ownerId: 'bob', title: 'B' });
});
afterEach(() => { store?.close(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { force: true, recursive: true }); });
const entry = (id: string, threadId: string): UsageEntry => ({ id, threadId, agentId: 'agent', provider: 'codex', startedAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:00:02Z', status: 'completed', usage: { totalTokens: 100 } });

describe('private durable usage', () => {
  it('aggregates only the owner’s usage in the active workspace and requested period', async () => {
    store.saveChatUsage(entry('alice-in-range', 'a'));
    store.saveChatUsage(entry('bob-in-range', 'b'));
    store.saveChatUsage({ ...entry('alice-outside', 'a'), startedAt: '2026-10-27T01:00:00Z' });
    const from = '2026-10-25T00:00:00.000Z';
    const to = '2026-10-26T00:00:00.000Z';
    expect(store.getAiUsageForOwner('alice', from, to).map(row => row.id)).toEqual(['alice-in-range']);
    expect(store.getAiUsageForOwner('bob', from, to).map(row => row.id)).toEqual(['bob-in-range']);
    expect(store.getAiUsageForOwner('', from, to)).toEqual([]);
    const { runWithWorkspace } = await import('./workspaceContext.js');
    const workspace = store.createWorkspace({ name: 'Other workspace' });
    runWithWorkspace(workspace.id, () => expect(store.getAiUsageForOwner('alice', from, to)).toEqual([]));
  });
  it('updates the same invocation instead of appending totals and enforces thread ownership', () => {
    store.saveChatUsage(entry('one', 'a'));
    store.saveChatUsage({ ...entry('one', 'a'), usage: { totalTokens: 150 } });
    store.saveChatUsage(entry('two', 'b'));
    expect(store.getChatUsage('a', 'alice')).toHaveLength(1);
    expect(store.getChatUsage('a', 'alice')[0].usage.totalTokens).toBe(150);
    expect(store.getChatUsage('a', 'bob')).toEqual([]);
    expect(store.getChatUsage('b', 'alice')).toEqual([]);
  });
  it('does not expose another workspace even when the owner is the same', async () => {
    store.saveChatUsage(entry('one', 'a'));
    const { runWithWorkspace } = await import('./workspaceContext.js');
    const workspace = store.createWorkspace({ name: 'Other workspace' });
    runWithWorkspace(workspace.id, () => expect(store.getChatUsage('a', 'alice')).toEqual([]));
  });
  it('attributes background specialist work to the originating chat, not the currently viewed one', () => {
    store.createOrchestrationSnapshot({ id: 'build', workspaceId: 'ws-default', projectId: 'project', issueId: 'issue',
      repository: 'acme/shop', requestKey: 'request', requestFingerprint: 'hash', createdBy: 'alice', executorId: 'desktop',
      ownershipEpoch: 1, workflowVersion: 1, planVersion: 1, plan: { schemaVersion: 1, goal: 'Fixture', exclusions: [], requirements: [], tasks: [] },
      originChatThreadId: 'a', status: 'planning', revision: 0, createdAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:00:00Z' }, [], 'model');
    store.saveChatUsage({ ...entry('specialist', 'a'), threadId: undefined, orchestrationRunId: 'build' });
    expect(store.getChatUsage('a', 'alice').map(row => row.id)).toEqual(['specialist']);
    expect(store.getChatUsage('b', 'bob')).toEqual([]);
  });
  it('survives reopening the database and removes usage when a conversation is cleared', async () => {
    store.saveChatUsage(entry('one', 'a')); store.close();
    const { SQLiteService } = await import('./sqliteService.js');
    store = new SQLiteService({ seedDefaults: false });
    expect(store.getChatUsage('a', 'alice')[0].usage.totalTokens).toBe(100);
    store.clearChatMessages('a');
    expect(store.getChatUsage('a', 'alice')).toEqual([]);
    store.saveChatUsage({ ...entry('one', 'a'), status: 'completed' });
    expect(store.getChatUsage('a', 'alice')).toEqual([]);
  });
  it('does not reinsert late usage after a thread is deleted', () => {
    store.saveChatUsage(entry('one', 'a'));
    store.deleteChatThread('a');
    store.saveChatUsage(entry('one', 'a'));
    store.createChatThread({ id: 'a', ownerId: 'bob', title: 'Recreated' });
    expect(store.getChatUsage('a', 'bob')).toEqual([]);
  });
});
