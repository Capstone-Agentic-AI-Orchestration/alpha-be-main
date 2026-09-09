import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A change the runner makes has to reach the board.
 *
 * The push was placed in the HTTP layer so the sync could never trigger it —
 * correct for the sync, wrong for everything else that writes. The runner
 * writes constantly and went through the data layer directly, so a finished
 * agent run moved the card to Review on one laptop and left it reading Todo
 * for the whole team, pull request already open.
 *
 * `pushIssue` itself is covered by githubBoardWrite.test.ts; what is under test
 * here is only whether the runner's writes are handed to it at all, and what
 * happens to the answer.
 */
let tmp: string;
let opened: { close(): void }[] = [];
/** Issues handed to the push, in order. */
let pushed: any[];
let pushResult: (issue: any) => any;

async function load() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  pushed = [];

  vi.doMock('./githubBoardWrite.js', () => ({
    pushIssue: async (issue: any) => {
      pushed.push(issue);
      return pushResult(issue);
    }
  }));

  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);
  const wt = await import('./boardWriteThrough.js');
  return { svc: sql.sqliteService as any, wt };
}

/** The push is fire-and-forget, so let its continuation run. */
const settle = () => new Promise(r => setTimeout(r, 0));

function plant(svc: any, over: Record<string, unknown> = {}) {
  svc.createProject({
    id: 'p1', name: 'Demo', key: 'DEMO',
    resources: [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/o/r' }]
  });
  return svc.createIssue({
    id: 'iss-1', projectId: 'p1', identifier: 'DEMO-101',
    title: 'Add a contact form', status: 'todo', priority: 'high',
    githubRepo: 'o/r', githubNumber: 1, labels: [], ...over
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bwt-'));
  opened = [];
  pushResult = () => ({ pushed: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  vi.restoreAllMocks();
  vi.doUnmock('./githubBoardWrite.js');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reclaim it */ }
});

describe('a runner status change', () => {
  /** The regression: agent opens a PR, teammates still see Todo. */
  it('reaches the board, not just the local database', async () => {
    const { svc, wt } = await load();
    plant(svc);

    wt.updateIssueAndPush('iss-1', { status: 'review', prUrl: 'https://github.com/o/r/pull/2' });
    await settle();

    expect(pushed).toHaveLength(1);
    expect(pushed[0].status).toBe('review');
    // The pushed copy must be the updated one, not the row as it was read.
    expect(pushed[0].prUrl).toBe('https://github.com/o/r/pull/2');
  });

  it('writes locally before pushing, so the UI is right either way', async () => {
    const { svc, wt } = await load();
    plant(svc);

    wt.updateIssueAndPush('iss-1', { status: 'agent_running' });

    // Synchronously, before the push has had any chance to settle.
    expect(svc.getIssues().find((i: any) => i.id === 'iss-1').status).toBe('agent_running');
  });

  it('does nothing for an issue that is not there', async () => {
    const { wt } = await load();
    wt.updateIssueAndPush('missing', { status: 'review' });
    await settle();
    expect(pushed).toHaveLength(0);
  });
});

describe('an issue the board has never seen', () => {
  /**
   * The case that would corrupt the board rather than merely lag it. A repo
   * attached after the issue was filed leaves it with no number, so the push
   * creates it — and dropping the number that comes back means the next status
   * change creates another one.
   */
  it('stores the number the push assigns it', async () => {
    const { svc, wt } = await load();
    plant(svc, { githubNumber: undefined, githubRepo: undefined });
    pushResult = () => ({
      pushed: true,
      patch: { githubRepo: 'o/r', githubNumber: 7, githubUrl: 'https://github.com/o/r/issues/7' }
    });

    wt.updateIssueAndPush('iss-1', { status: 'review' });
    await settle();

    const saved = svc.getIssues().find((i: any) => i.id === 'iss-1');
    expect(saved.githubNumber).toBe(7);
    expect(saved.githubRepo).toBe('o/r');
  });
});

describe('when the board cannot be reached', () => {
  it('keeps the local change and does not throw', async () => {
    const { svc, wt } = await load();
    plant(svc);
    pushResult = () => ({ pushed: false, error: 'gh: 403 Forbidden' });

    expect(() => wt.updateIssueAndPush('iss-1', { status: 'review' })).not.toThrow();
    await settle();

    expect(svc.getIssues().find((i: any) => i.id === 'iss-1').status).toBe('review');
  });

  /** A rejected promise here would be an unhandled rejection, which kills the daemon. */
  it('survives the push rejecting outright', async () => {
    const { svc, wt } = await load();
    plant(svc);
    pushResult = () => { throw new Error('socket hang up'); };

    wt.updateIssueAndPush('iss-1', { status: 'review' });
    await settle();

    expect(svc.getIssues().find((i: any) => i.id === 'iss-1').status).toBe('review');
  });
});
