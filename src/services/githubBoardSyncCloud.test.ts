import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase } from '../store/testDatabase.js';

/**
 * How a project manager's board fills up.
 *
 * Nobody creates cards on Render: the issues are on GitHub, and the sync is
 * what puts them on the board. Which makes this the path that decides whether
 * a hosted board has anything on it at all — and it wrote to SQLite on an
 * ephemeral disk, so everything it pulled was gone by the next deploy.
 *
 * Here it runs in cloud mode against a real Postgres, with `gh` answered by a
 * stub, and the assertions are about rows in the database rather than about
 * what the function returned.
 */

let pg: PGlite;
let tmp: string;
let opened: { close(): void }[] = [];
let responder: (args: string[]) => string;

const ISSUE = {
  number: 7,
  title: 'Cart loses items',
  body: 'Steps to reproduce…',
  state: 'open',
  labels: [{ name: 'alpha:todo' }],
  user: { login: 'octocat' },
  assignee: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z'
};

/** `gh` answering for one repository with one issue and one comment. */
const defaultResponder = (args: string[]): string => {
  const joined = args.join(' ');
  if (joined.includes('/comments')) {
    return JSON.stringify([
      { id: 555, body: 'Reproduced on staging.', user: { login: 'octocat' }, created_at: '2026-09-02T10:00:00Z' }
    ]);
  }
  if (joined.includes('/issues')) return JSON.stringify([ISSUE]);
  return '[]';
};

beforeAll(async () => {
  pg = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-sync-'));
  opened = [];
  responder = defaultResponder;
  await pg.exec('truncate issues, issue_comments, projects, workspaces cascade');
  await pg.exec(`insert into workspaces (id, name, slug) values ('ws-default', 'Alpha', 'alpha')`);
});

afterEach(() => {
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.ALPHA_MODE;
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.resetModules();
});

async function loadCloudSync() {
  process.env.ALPHA_MODE = 'cloud';
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
      ...actual,
      execFile: (_cmd: string, args: string[], _options: unknown, cb: Function) =>
        cb(null, { stdout: responder(args) }, '')
    };
  });

  const { PostgresIssueStore } = await import('../store/postgresIssueStore.js');
  const { PostgresProjectStore } = await import('../store/postgresProjectStore.js');
  const { useIssueStore, useProjectStore } = await import('../store/stores.js');
  const { sqlFor } = await import('../store/testDatabase.js');
  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);

  const projects = new PostgresProjectStore(sqlFor(pg));
  useProjectStore(projects);
  useIssueStore(new PostgresIssueStore(sqlFor(pg)));

  await projects.create('ws-default', {
    id: 'p1',
    name: 'Checkout',
    key: 'CHK',
    resources: [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }]
  });

  const { syncBoardFromGitHub } = await import('./githubBoardSync.js');
  return syncBoardFromGitHub;
}

describe('the board sync, in the cloud', () => {
  it('writes the pulled issues into Postgres', async () => {
    const sync = await loadCloudSync();

    const report = await sync('ws-default');
    expect(report.projects).toBe(1);
    expect(report.created).toBe(1);

    const { rows } = await pg.query<{ identifier: string; title: string; workspace_id: string; github_number: number }>(
      'select identifier, title, workspace_id, github_number from issues'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identifier: 'CHK-7',
      title: 'Cart loses items',
      workspace_id: 'ws-default',
      github_number: 7
    });
  });

  it('brings the conversation with it', async () => {
    const sync = await loadCloudSync();
    await sync('ws-default');

    const { rows } = await pg.query<{ content: string; github_id: string }>(
      'select content, github_id from issue_comments'
    );
    expect(rows.map(r => r.content)).toContain('Reproduced on staging.');
    expect(Number(rows[0].github_id)).toBe(555);
  });

  /** Syncing twice must not make a second card, or a second copy of a comment. */
  it('is idempotent', async () => {
    const sync = await loadCloudSync();
    await sync('ws-default');
    const second = await sync('ws-default');

    expect(second.created).toBe(0);
    expect((await pg.query('select id from issues')).rows).toHaveLength(1);
    expect((await pg.query('select id from issue_comments')).rows).toHaveLength(1);
  });

  it('leaves the board alone when a repository cannot be read', async () => {
    const sync = await loadCloudSync();
    responder = () => {
      throw new Error('gh: could not resolve repository');
    };

    const report = await sync('ws-default');
    expect(report.errors).toHaveLength(1);
    expect((await pg.query('select id from issues')).rows).toEqual([]);
  });
});
