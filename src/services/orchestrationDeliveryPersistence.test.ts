import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import type { DeliveryRecord } from './orchestrationDelivery.js';

describe('durable delivery storage', () => {
  it('retains state, actor and commit evidence across a restart, and isolates workspaces', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-delivery-'));
    const dbPath = path.join(directory, 'delivery.db');
    let store = new SQLiteService({ dbPath, seedDefaults: false });
    const initial: DeliveryRecord = { runId: 'build', workspaceId: 'ws', projectId: 'project', ownerId: 'person', revision: 0,
      stage: 'dev_approval', reason: 'Checks passed', repositories: [], history: [], repairAttempts: 0, createdAt: 'now', updatedAt: 'now' };
    try {
      runWithWorkspace('ws', () => {
        store.saveOrchestrationDelivery(initial);
        store.saveOrchestrationDelivery({ ...initial, revision: 1, history: [{ at: 'now', actorId: 'pm', action: 'approval:done',
          detail: 'Authorized merge', commits: [{ repository: 'acme/shop', source: 'a'.repeat(40), devBase: 'b'.repeat(40) }] }] }, 0);
        expect(() => store.saveOrchestrationDelivery({ ...initial, revision: 1 }, 0)).toThrow(/changed/);
        expect(() => store.saveOrchestrationDelivery({ ...initial, revision: 9 }, 1)).toThrow(/exactly once/);
      });
      store.close(); store = new SQLiteService({ dbPath, seedDefaults: false });
      runWithWorkspace('ws', () => {
        expect(store.getOrchestrationDelivery('build')?.revision).toBe(1);
        expect(store.hasOrchestrationDeliveryAction('build', 'approval:done')).toBe(true);
        expect(store.listOrchestrationDeliveryEvents('build')[0]).toMatchObject({ actorId: 'pm', commits: [{ source: 'a'.repeat(40) }] });
        expect(store.listOrchestrationDeliveryEvents('build', 1)).toEqual([]);
      });
      runWithWorkspace('other', () => {
        expect(store.getOrchestrationDelivery('build')).toBeUndefined();
        expect(store.hasOrchestrationDeliveryAction('build', 'approval:done')).toBe(false);
        expect(store.listOrchestrationDeliveryEvents('build')).toEqual([]);
        expect(() => store.saveOrchestrationDelivery(initial)).toThrow(/outside this workspace/);
      });
    } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
