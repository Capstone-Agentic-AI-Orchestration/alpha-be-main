import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../models/index.js';

const state = vi.hoisted(() => ({
  latest: [] as Array<{ issueId: string; status: string }>,
  runs: [] as Array<{ id: string; issueId: string; status: string }>,
  issues: [] as Issue[],
  comments: [] as unknown[]
}));

vi.mock('../config/env.js', async importOriginal => ({ ...(await importOriginal<object>()), IS_CLOUD: false }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { listLatestIssueBuilds: () => state.latest } }));
vi.mock('./supabaseService.js', () => ({ supabaseService: { shareIssue: vi.fn(), shareComment: vi.fn(), unshareIssue: vi.fn() } }));
vi.mock('./githubBoardWrite.js', () => ({ needsPush: () => false, pushIssue: vi.fn(), publishNewIssue: vi.fn(), publishedFields: vi.fn() }));
vi.mock('./workspaceContext.js', async importOriginal => ({ ...(await importOriginal<object>()), runWithWorkspace: (_id: string, fn: () => unknown) => fn() }));
vi.mock('../store/stores.js', () => ({
  runStore: () => ({ listSummaries: async () => state.runs }),
  issueStore: () => ({
    list: async () => state.issues,
    update: async (_ws: string, id: string, updates: Partial<Issue>) => {
      const index = state.issues.findIndex(issue => issue.id === id);
      state.issues[index] = { ...state.issues[index], ...updates };
      return state.issues[index];
    },
    get: async (_ws: string, id: string) => state.issues.find(issue => issue.id === id) ?? null,
    addComment: async (_ws: string, comment: unknown) => { state.comments.push(comment); return comment; }
  }),
  agentStore: () => ({ get: async () => null })
}));

import { BoardRuleError, archiveCard, cardRemovalBlocker, filterArchived, prepareCardCreate, prepareCardUpdate, restoreCard } from './boardService.js';

const card = { id: 'issue-1', identifier: 'CAP-1', projectId: 'project-1', status: 'todo', title: 'Card', description: '' } as Issue;

describe('board card rules', () => {
  beforeEach(() => { state.latest = []; state.runs = []; state.issues = [{ ...card }]; state.comments = []; });

  it('refuses to remove a card whose Orchestrator build is unfinished', async () => {
    state.latest = [{ issueId: 'issue-1', status: 'awaiting_approval' }];
    expect(await cardRemovalBlocker('ws', card)).toMatch(/unfinished build/);
  });

  it('allows removing a card whose last build was cancelled', async () => {
    state.latest = [{ issueId: 'issue-1', status: 'cancelled' }];
    expect(await cardRemovalBlocker('ws', card)).toBeNull();
  });

  it('refuses to remove a card with an active run', async () => {
    state.runs = [{ id: 'run-1', issueId: 'issue-1', status: 'running' }];
    expect(await cardRemovalBlocker('ws', card)).toMatch(/active agent run/);
  });

  it.each(['agent_running', 'done'])('refuses a direct move to %s', async status => {
    await expect(prepareCardUpdate('ws', card, { status })).rejects.toMatchObject({ status: 409 });
  });

  it('allows an ordinary planning move', async () => {
    await expect(prepareCardUpdate('ws', card, { status: 'in_progress' })).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('refuses status changes while a build is unfinished', async () => {
    state.latest = [{ issueId: 'issue-1', status: 'executing' }];
    await expect(prepareCardUpdate('ws', card, { status: 'backlog' })).rejects.toBeInstanceOf(BoardRuleError);
  });

  it('refuses a new card that starts in Building, and drops a caller-supplied identifier', async () => {
    await expect(prepareCardCreate('ws', { projectId: 'project-1', title: 'New', status: 'agent_running' })).rejects.toMatchObject({ status: 409 });
    const rest = await prepareCardCreate('ws', { projectId: 'project-1', title: 'New', identifier: 'CAP-999', comments: [] });
    expect(rest).not.toHaveProperty('identifier');
    expect(rest).not.toHaveProperty('comments');
  });

  it('archives a card with who did it, keeps it, and restores it', async () => {
    const { saved } = await archiveCard('ws', card, 'Manager Agent for lloyd');
    expect(saved.archivedAt).toBeTruthy();
    expect(saved.archivedBy).toBe('Manager Agent for lloyd');
    expect(state.comments).toEqual([expect.objectContaining({ content: 'Archived by Manager Agent for lloyd.', authorType: 'system' })]);
    const restored = await restoreCard('ws', saved, 'lloyd');
    expect(restored.saved.archivedAt).toBeUndefined();
    expect(state.comments).toHaveLength(2);
  });

  it('refuses to archive a card whose build is unfinished', async () => {
    state.latest = [{ issueId: 'issue-1', status: 'executing' }];
    await expect(archiveCard('ws', card, 'lloyd')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('before archiving') });
  });

  it('leaves archived cards out of board reads unless asked', () => {
    const cards = [{ id: 'a' }, { id: 'b', archivedAt: '2026-11-07T00:00:00Z' }];
    expect(filterArchived(cards, undefined).map(c => c.id)).toEqual(['a']);
    expect(filterArchived(cards, 'only').map(c => c.id)).toEqual(['b']);
    expect(filterArchived(cards, 'include')).toHaveLength(2);
  });
});

