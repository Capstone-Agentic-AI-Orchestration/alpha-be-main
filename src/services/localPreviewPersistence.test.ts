import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SQLiteService } from './sqliteService.js';
let store: SQLiteService;
let root: string;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-preview-store-'));
  vi.stubEnv('ALPHA_HOME', root); vi.resetModules();
  store = (await import('./sqliteService.js')).sqliteService;
  store.createChatThread({ id: 'thread', title: 'Preview', ownerId: 'alice' });
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true }); });
it('persists private descriptors with workspace, owner and thread boundaries and clears them with chat', async () => {
  const record = { id: 'preview', workspaceId: 'ws-default', ownerId: 'alice', threadId: 'thread', state: 'ready' };
  store.saveLocalPreview(record);
  expect(store.listLocalPreviews('ws-default', 'bob', 'thread')).toEqual([]);
  expect(store.listLocalPreviews('other', 'alice', 'thread')).toEqual([]);
  expect(store.listLocalPreviews('ws-default', 'alice', 'other')).toEqual([]);
  store.close(); const { SQLiteService } = await import('./sqliteService.js'); store = new SQLiteService({ seedDefaults: false });
  expect(store.listLocalPreviews('ws-default', 'alice', 'thread')).toEqual([record]);
  store.clearChatMessages('thread');
  expect(store.listLocalPreviews('ws-default', 'alice', 'thread')).toEqual([]);
});
