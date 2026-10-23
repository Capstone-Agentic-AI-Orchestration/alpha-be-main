import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';

let dir = '';
let store: SQLiteService | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });

const call = (id: string, origin: 'chat_turn' | 'agent_call', status: string) => ({
  id, workspaceId: 'ws', projectId: 'project', threadId: 'thread', messageId: 'message-' + id, squadId: 'direct',
  agentId: 'agent', requestedBy: 'user', operationMode: 'ask', origin, status, instruction: 'Review the lockfiles.',
  createdAt: '2026-10-24T00:00:00.000Z', activities: [], artifacts: []
}) as any;

describe('startup reconciliation of agent calls', () => {
  it('closes chat replies a restart interrupted, so the composer is not stuck steering a dead turn', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-calls-'));
    store = new SQLiteService({ dbPath: path.join(dir, 'alpha.db'), seedDefaults: false });
    // The rows stand alone here; the project and squad they point at are not under test.
    (store as any).db.pragma('foreign_keys = OFF');
    runWithWorkspace('ws', () => {
      store!.saveAgentCall(call('turn-running', 'chat_turn', 'running'));
      store!.saveAgentCall(call('call-running', 'agent_call', 'running'));
      store!.saveAgentCall(call('turn-done', 'chat_turn', 'completed'));
    });

    const closed = store.reconcileInterruptedAgentCalls('2026-10-24T01:00:00.000Z');

    expect(closed.sort()).toEqual(['call-running', 'turn-running']);
    runWithWorkspace('ws', () => {
      expect(store!.getAgentCall('turn-running')).toMatchObject({ status: 'failed', error: expect.stringContaining('Send the message again') });
      expect(store!.getAgentCall('call-running')?.status).toBe('failed');
      expect(store!.getAgentCall('turn-done')?.status).toBe('completed');
    });
  });
});

