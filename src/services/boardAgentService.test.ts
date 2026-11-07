import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, IssueComment } from '../models/index.js';
import type { BoardAgentChangeRecord } from '../store/boardAgentChange.js';
import type { BoardGrant } from './boardGrant.js';

const state = vi.hoisted(() => ({
  issues: [] as Issue[],
  comments: [] as IssueComment[],
  changes: [] as BoardAgentChangeRecord[],
  refusal: null as string | null,
  clock: 0
}));

vi.mock('../config/env.js', async importOriginal => ({ ...(await importOriginal<object>()), IS_CLOUD: false }));
vi.mock('./workspaceContext.js', async importOriginal => ({ ...(await importOriginal<object>()), runWithWorkspace: (_id: string, fn: () => unknown) => fn() }));
vi.mock('./supabaseService.js', () => ({ supabaseService: { shareIssue: vi.fn(), shareComment: vi.fn(), unshareIssue: vi.fn() } }));
vi.mock('./githubBoardWrite.js', () => ({ needsPush: () => false, pushIssue: vi.fn(), publishNewIssue: async () => ({}), publishedFields: vi.fn() }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { bind: vi.fn(), unbind: vi.fn() } }));
vi.mock('./boardGrant.js', () => ({ boardAgentRefusal: () => state.refusal }));
vi.mock('./sqliteService.js', () => ({
  sqliteService: {
    listLatestIssueBuilds: () => [],
    insertBoardAgentChange: (change: BoardAgentChangeRecord) => { state.changes.push(change); return true; },
    updateBoardAgentChange: (change: BoardAgentChangeRecord) => { state.changes = state.changes.map(old => old.id === change.id ? change : old); },
    getBoardAgentChange: (_ws: string, id: string) => state.changes.find(change => change.id === id) ?? null,
    findBoardAgentChange: (_ws: string, runId: string, key: string) => state.changes.find(change => change.runId === runId && change.requestKey === key) ?? null,
    listBoardAgentChanges: (_ws: string, filter: { runId?: string }) => state.changes.filter(change => !filter.runId || change.runId === filter.runId)
  }
}));
const tick = () => new Date(Date.parse('2026-11-07T08:00:00Z') + (state.clock += 1000)).toISOString();
vi.mock('../store/stores.js', () => ({
  runStore: () => ({ listSummaries: async () => [] }),
  agentStore: () => ({ get: async () => null }),
  issueStore: () => ({
    list: async () => state.issues,
    get: async (_ws: string, id: string) => state.issues.find(issue => issue.id === id) ?? null,
    update: async (_ws: string, id: string, updates: Partial<Issue>) => {
      const index = state.issues.findIndex(issue => issue.id === id);
      state.issues[index] = { ...state.issues[index], ...updates, updatedAt: tick() };
      return state.issues[index];
    },
    create: async (_ws: string, input: Partial<Issue>) => {
      const issue = { ...input, id: 'new-' + state.issues.length, identifier: 'CAP-' + (100 + state.issues.length), comments: [], createdAt: tick(), updatedAt: tick() } as Issue;
      state.issues.push(issue);
      return issue;
    },
    addComment: async (_ws: string, comment: IssueComment) => {
      state.comments.push(comment);
      const issue = state.issues.find(item => item.id === comment.issueId);
      if (issue) issue.comments = [...(issue.comments ?? []), comment];
      return comment;
    }
  })
}));

import {
  approveAgentChange, archiveForAgent, commentForAgent, createCardForAgent, listCards, moveCardForAgent,
  rejectAgentChange, undoAgentChange, updateCardForAgent
} from './boardAgentService.js';

const card = (n: number, extra: Partial<Issue> = {}): Issue => ({
  id: 'issue-' + n, identifier: 'CAP-' + n, title: 'Card ' + n, description: '', status: 'todo', priority: 'medium',
  projectId: 'project-1', labels: [], subtasks: [], comments: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...extra
}) as Issue;

const developer = { userId: 'u-lloyd', workspaceId: 'ws', role: 'dev' } as BoardGrant['context'];
const grant = (over: Partial<BoardGrant> = {}): BoardGrant => ({
  runId: 'turn-1', agentId: 'agent-manager', agentName: 'Manager Agent', context: developer, actorLogin: 'lloyd',
  projectId: 'project-1', access: 'write', touched: new Set(), writes: 0, ...over
});

beforeEach(() => {
  state.issues = Array.from({ length: 8 }, (_, i) => card(i + 1));
  state.comments = [];
  state.changes = [];
  state.refusal = null;
  state.clock = 0;
});

describe('reading the board', () => {
  it('lists this project\'s cards compactly, without comments', async () => {
    state.issues.push(card(50, { projectId: 'other' }));
    const result = await listCards(grant({ access: 'read' })) as { total: number; cards: Array<Record<string, unknown>> };
    expect(result.total).toBe(8);
    expect(result.cards[0]).toEqual({ card: 'CAP-1', title: 'Card 1', column: 'Todo', priority: 'medium', updated_at: '2026-11-01T00:00:00.000Z' });
  });
});

describe('agent changes', () => {
  it('moves a card as the developer, records before and after, and notes it on the card once per turn', async () => {
    const g = grant();
    const result = await moveCardForAgent(g, { card: 'CAP-1', column: 'in_progress', expected_updated_at: '2026-11-01T00:00:00.000Z' });
    expect(result).toMatchObject({ status: 'done', summary: 'Moved CAP-1 to In progress.' });
    expect(state.issues[0].status).toBe('in_progress');
    expect(state.changes[0]).toMatchObject({ action: 'move', status: 'applied', actorLogin: 'lloyd', before: { status: 'todo' }, after: { status: 'in_progress' } });
    expect(state.comments).toEqual([expect.objectContaining({ id: expect.stringMatching(/^comm-activity-/), content: 'Changed by Manager Agent for lloyd: Moved CAP-1 to In progress.' })]);
    await updateCardForAgent(g, { card: 'CAP-1', title: 'Renamed', expected_updated_at: state.issues[0].updatedAt });
    expect(state.comments).toHaveLength(1);
  });

  it.each([['done', /Only a person marks a card Done/], ['agent_running', /only when a developer starts a build/]])('never moves a card to %s', async (column, message) => {
    await expect(moveCardForAgent(grant(), { card: 'CAP-1', column, expected_updated_at: '2026-11-01T00:00:00.000Z' })).rejects.toThrow(message);
  });

  it('refuses a change to a card that changed since the agent read it', async () => {
    await expect(moveCardForAgent(grant(), { card: 'CAP-1', column: 'backlog', expected_updated_at: '2026-10-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 409 });
    expect(state.changes).toHaveLength(0);
  });

  it('does not change the board twice for a repeated call', async () => {
    const g = grant();
    const args = { title: 'Login page', checklist: ['Shows an error for a wrong password.'] };
    const first = await createCardForAgent(g, args);
    const second = await createCardForAgent(g, args);
    expect(second.changeId).toBe(first.changeId);
    expect(state.issues.filter(issue => issue.title === 'Login page')).toHaveLength(1);
    expect(state.issues.at(-1)?.subtasks?.[0]).toMatchObject({ title: 'Shows an error for a wrong password.', completed: false });
  });

  it('refuses writes from an agent without write access, and comments outside its own card', async () => {
    await expect(moveCardForAgent(grant({ access: 'read' }), { card: 'CAP-1', column: 'backlog', expected_updated_at: 'x' }))
      .rejects.toThrow(/Only the Manager Agent changes cards/);
    const specialist = grant({ access: 'comment', ownIssueId: 'issue-2' });
    await expect(commentForAgent(specialist, { card: 'CAP-1', text: 'Done here.' })).rejects.toMatchObject({ status: 403 });
    await expect(commentForAgent(specialist, { card: 'CAP-2', text: 'Done here.' })).resolves.toMatchObject({ status: 'done' });
  });

  it('refuses everything once the person may not use agents on this board', async () => {
    state.refusal = 'Agents work on the board only for developers.';
    await expect(createCardForAgent(grant(), { title: 'Anything' })).rejects.toThrow(state.refusal);
  });
});

describe('changes that wait for the developer', () => {
  it('holds an archive until the developer who asked confirms it', async () => {
    const result = await archiveForAgent(grant(), { card: 'CAP-3', expected_updated_at: '2026-11-01T00:00:00.000Z', reason: 'Duplicate' });
    expect(result.status).toBe('held');
    expect(state.issues[2].archivedAt).toBeUndefined();
    await expect(approveAgentChange({ ...developer, userId: 'u-someone' }, result.changeId!)).rejects.toMatchObject({ status: 403 });
    const applied = await approveAgentChange(developer, result.changeId!);
    expect(applied.status).toBe('applied');
    expect(state.issues[2].archivedAt).toBeTruthy();
    expect(state.issues[2].archivedBy).toBe('Manager Agent for lloyd');
  });

  it('holds a change to a card assigned to someone else, and can be rejected', async () => {
    state.issues[3] = card(4, { assignedHuman: 'maria' });
    const result = await moveCardForAgent(grant(), { card: 'CAP-4', column: 'backlog', expected_updated_at: '2026-11-01T00:00:00.000Z' });
    expect(result).toMatchObject({ status: 'held', summary: expect.stringContaining('assigned to maria') });
    expect(rejectAgentChange(developer, result.changeId!).status).toBe('rejected');
    expect(state.issues[3].status).toBe('todo');
  });

  it('holds changes beyond five cards in one turn', async () => {
    const g = grant();
    for (let n = 1; n <= 5; n++) {
      await expect(moveCardForAgent(g, { card: 'CAP-' + n, column: 'backlog', expected_updated_at: '2026-11-01T00:00:00.000Z' })).resolves.toMatchObject({ status: 'done' });
    }
    await expect(moveCardForAgent(g, { card: 'CAP-6', column: 'backlog', expected_updated_at: '2026-11-01T00:00:00.000Z' })).resolves.toMatchObject({ status: 'held' });
    await expect(updateCardForAgent(g, { card: 'CAP-1', priority: 'high', expected_updated_at: state.issues[0].updatedAt })).resolves.toMatchObject({ status: 'done' });
  });

  it('does not apply a confirmed change to a card a person edited meanwhile', async () => {
    const held = await archiveForAgent(grant(), { card: 'CAP-3', expected_updated_at: '2026-11-01T00:00:00.000Z' });
    state.issues[2] = { ...state.issues[2], title: 'Edited by a person', updatedAt: '2026-11-07T09:00:00.000Z' };
    await expect(approveAgentChange(developer, held.changeId!)).rejects.toMatchObject({ status: 409 });
    expect(state.changes[0].status).toBe('failed');
  });
});

describe('undo', () => {
  it('puts a moved card back, and refuses once someone changed it since', async () => {
    const first = await moveCardForAgent(grant(), { card: 'CAP-1', column: 'review', expected_updated_at: '2026-11-01T00:00:00.000Z' });
    await undoAgentChange(developer, first.changeId!);
    expect(state.issues[0].status).toBe('todo');

    const second = await moveCardForAgent(grant({ runId: 'turn-2' }), { card: 'CAP-2', column: 'review', expected_updated_at: '2026-11-01T00:00:00.000Z' });
    state.issues[1] = { ...state.issues[1], updatedAt: '2026-11-07T10:00:00.000Z' };
    await expect(undoAgentChange(developer, second.changeId!)).rejects.toMatchObject({ status: 409 });
  });

  it('archives a created card rather than deleting it', async () => {
    const created = await createCardForAgent(grant(), { title: 'Temporary' });
    await undoAgentChange(developer, created.changeId!);
    expect(state.issues.find(issue => issue.title === 'Temporary')?.archivedAt).toBeTruthy();
  });
});

