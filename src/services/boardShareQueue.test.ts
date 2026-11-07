import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../models/index.js';

const state = vi.hoisted(() => ({
  queue: new Map<string, { workspaceId: string; issueId: string; attempts: number; nextAttemptAt: string; lastError: string }>(),
  issues: new Map<string, any>(),
  refusals: [] as Array<string | null>,
  boardCopy: null as string | null,
  shared: [] as string[],
  workspace: 'ws-1'
}));

vi.mock('./sqliteService.js', () => ({
  sqliteService: {
    queueBoardShare: (workspaceId: string, issueId: string, lastError: string, nextAttemptAt: string) => {
      const key = `${workspaceId}:${issueId}`;
      const existing = state.queue.get(key);
      state.queue.set(key, existing ? { ...existing, lastError } : { workspaceId, issueId, attempts: 0, nextAttemptAt, lastError });
    },
    getDueBoardShares: (_limit: number, now: string) => [...state.queue.values()].filter(entry => entry.nextAttemptAt <= now),
    scheduleBoardShareRetry: (workspaceId: string, issueId: string, nextAttemptAt: string, lastError: string) => {
      const entry = state.queue.get(`${workspaceId}:${issueId}`)!;
      state.queue.set(`${workspaceId}:${issueId}`, { ...entry, attempts: entry.attempts + 1, nextAttemptAt, lastError });
    },
    clearBoardShare: (workspaceId: string, issueId: string) => { state.queue.delete(`${workspaceId}:${issueId}`); },
    nextBoardShareAt: () => null
  }
}));
vi.mock('./supabaseService.js', () => ({
  supabaseService: {
    shareIssue: async (issue: Issue) => {
      const refused = state.refusals.length ? state.refusals.shift()! : null;
      if (!refused) state.shared.push(`${issue.id}:${issue.status}`);
      return refused;
    },
    sharedIssueUpdatedAt: async () => state.boardCopy
  }
}));
vi.mock('./workspaceContext.js', () => ({ currentWorkspaceId: () => state.workspace }));
vi.mock('../store/stores.js', () => ({ issueStore: () => ({ get: async (_ws: string, id: string) => state.issues.get(id) ?? null }) }));

import { BOARD_SHARE_WARNING, boardShareRetryDelayMs, resetBoardShareQueue, retryBoardShares, shareCard, shareCardForReply } from './boardShareQueue.js';

const card = (status = 'todo', updatedAt = '2026-11-07T15:04:00.000Z') =>
  ({ id: 'card-1', identifier: 'MON-106', status, updatedAt }) as Issue;
const DUE = Date.parse('2030-01-01T00:00:00.000Z');

describe('getting a card onto the team board', () => {
  beforeEach(() => {
    state.queue.clear(); state.issues.clear(); state.refusals = []; state.boardCopy = null; state.shared = []; state.workspace = 'ws-1';
  });
  afterEach(() => resetBoardShareQueue());

  it('sends a card and remembers nothing when the board accepts it', async () => {
    expect(await shareCard(card(), 'ws-1')).toBe(true);
    expect(state.shared).toEqual(['card-1:todo']);
    expect(state.queue.size).toBe(0);
  });

  it('keeps a refused card and tells the person it is not on the team board yet', async () => {
    state.refusals = ['new row violates row-level security policy'];
    expect(await shareCardForReply(card(), 'ws-1')).toBe(BOARD_SHARE_WARNING);
    expect([...state.queue.values()]).toMatchObject([{ issueId: 'card-1', lastError: expect.stringContaining('row-level security') }]);
  });

  it('retries with the card as it is now, then forgets it once the board accepts it', async () => {
    state.refusals = ['offline'];
    await shareCard(card('todo'), 'ws-1');
    state.issues.set('card-1', card('in_review', '2026-11-07T15:10:00.000Z'));
    await retryBoardShares(DUE);
    expect(state.shared).toEqual(['card-1:in_review']);
    expect(state.queue.size).toBe(0);
  });

  it('never overwrites a newer change a teammate made on the board meanwhile', async () => {
    state.refusals = ['offline'];
    await shareCard(card('todo'), 'ws-1');
    state.issues.set('card-1', card('todo', '2026-11-07T15:04:00.000Z'));
    state.boardCopy = '2026-11-07T16:00:00.000+00:00';
    await retryBoardShares(DUE);
    expect(state.shared).toEqual([]);
    expect(state.queue.size).toBe(0);
  });

  it('backs off further after each refusal, up to fifteen minutes', async () => {
    state.refusals = ['offline', 'still offline'];
    await shareCard(card(), 'ws-1');
    state.issues.set('card-1', card());
    await retryBoardShares(DUE);
    expect([...state.queue.values()][0]).toMatchObject({ attempts: 1, lastError: 'still offline' });
    expect(boardShareRetryDelayMs(1)).toBe(60_000);
    expect(boardShareRetryDelayMs(20)).toBe(15 * 60_000);
  });

  it('waits to send a card from another workspace until the desktop is in it', async () => {
    state.refusals = ['offline'];
    await shareCard(card(), 'ws-1');
    state.workspace = 'ws-2';
    state.issues.set('card-1', card());
    await retryBoardShares(DUE);
    expect(state.shared).toEqual([]);
    expect([...state.queue.values()][0]).toMatchObject({ attempts: 1 });
  });
});
