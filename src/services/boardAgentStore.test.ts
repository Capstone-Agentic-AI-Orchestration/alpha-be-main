import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import type { BoardAgentChangeRecord } from '../store/boardAgentChange.js';

describe('board agent change log and assistant setting (SQLite)', () => {
  let dir = '';
  let store: SQLiteService | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const open = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-board-agent-'));
    store = new SQLiteService({ dbPath: path.join(dir, 'alpha.db'), seedDefaults: false });
    return store;
  };
  const change = (over: Partial<BoardAgentChangeRecord> = {}): BoardAgentChangeRecord => ({
    id: 'bac-1', workspaceId: 'ws', projectId: 'p', issueId: 'i', runId: 'turn', requestKey: 'key', agentName: 'Manager Agent',
    actorUserId: 'u', actorLogin: 'lloyd', action: 'move', status: 'held', summary: 'Moved CAP-1 to Todo', input: { updates: { status: 'todo' } },
    before: { status: 'backlog', updatedAt: 't0' }, createdAt: '2026-11-07T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z', ...over
  });

  it('records a change once per turn and request, and reads it back', () => {
    const db = open();
    expect(db.insertBoardAgentChange(change())).toBe(true);
    expect(db.insertBoardAgentChange(change({ id: 'bac-2' }))).toBe(false);
    expect(db.findBoardAgentChange('ws', 'turn', 'key')).toEqual(change());
    db.updateBoardAgentChange({ ...change(), status: 'applied', after: { status: 'todo' }, decidedAt: 'later', decidedBy: 'u' });
    expect(db.getBoardAgentChange('ws', 'bac-1')).toMatchObject({ status: 'applied', after: { status: 'todo' }, decidedBy: 'u' });
    expect(db.getBoardAgentChange('other-ws', 'bac-1')).toBeNull();
    expect(db.listBoardAgentChanges('ws', { projectId: 'p', status: 'applied' })).toHaveLength(1);
  });

  it('keeps the assistant on by default, and lets a project setting override the workspace one', () => {
    const db = open();
    expect(db.boardAssistantEnabled('ws', 'p')).toBe(true);
    db.setBoardAssistantEnabled('ws', '', false, 'admin');
    expect(db.boardAssistantEnabled('ws', 'p')).toBe(false);
    db.setBoardAssistantEnabled('ws', 'p', true, 'admin');
    expect(db.boardAssistantEnabled('ws', 'p')).toBe(true);
    expect(db.boardAssistantEnabled('ws', 'q')).toBe(false);
  });
});

