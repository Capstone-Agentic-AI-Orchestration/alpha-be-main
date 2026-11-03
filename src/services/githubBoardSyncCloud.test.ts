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
 * Here it runs in cloud mode against a real Postgres, with GitHub answered by
 * a stub, and the assertions are about rows in the database rather than about
 * what the function returned.
 */

let pg: PGlite;
let tmp: string;
let opened: { close(): void }[] = [];
let responder: (path: string) => unknown;

const ISSUE = {
  id: 9001,
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

const PAYMENTS_ISSUE = { ...ISSUE, id: 9002, number: 3, title: 'Refunds double-charge' };

const repo = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  full_name: `acme/${name}`,
  html_url: `https://github.com/acme/${name}`,
  description: `The ${name} service`,
  archived: false,
  has_issues: true,
  default_branch: 'main',
  ...over
});

/** The organisation: one repository already a project, one new, two that should not be. */
const ORG_REPOS = [
  repo(101, 'payments'),
  repo(100, 'checkout'),
  repo(102, 'old-site', { archived: true }),
  repo(103, 'wiki', { has_issues: false })
];

/**
 * GitHub answering for the organisation and its repositories: checkout has
 * one issue with one comment, payments one issue and no comments.
 */
const defaultResponder = (p: string): unknown => {
  if (p.startsWith('/orgs/acme/repos')) return ORG_REPOS;
  if (p.startsWith('/repos/acme/checkout/issues/7/comments')) {
    return [{ id: 555, body: 'Reproduced on staging.', user: { login: 'octocat' }, created_at: '2026-09-02T10:00:00Z' }];
  }
  if (p.includes('/comments')) return [];
  if (p.startsWith('/repos/acme/checkout/issues')) return [ISSUE];
  if (p.startsWith('/repos/acme/payments/issues')) return [PAYMENTS_ISSUE];
  return [];
};

/** Reads only: nothing on this board is unpublished, so the sync should write nothing. */
const fakeGitHub = {
  get: async (p: string) => responder(p) as any,
  getAll: async (p: string) => responder(p) as any,
  post: async (p: string) => {
    throw new Error(`unexpected POST ${p}`);
  },
  patch: async (p: string) => {
    throw new Error(`unexpected PATCH ${p}`);
  },
  put: async (p: string) => {
    throw new Error(`unexpected PUT ${p}`);
  },
  delete: async (p: string) => {
    throw new Error(`unexpected DELETE ${p}`);
  }
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
  delete process.env.ALPHA_ORG;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.resetModules();
});

/**
 * The sync in cloud mode, with `acme/checkout` already attached to a project.
 *
 * `org` switches on repository discovery, which only runs for a configured
 * organisation.
 */
async function loadCloudSync(org?: string) {
  process.env.ALPHA_MODE = 'cloud';
  process.env.ALPHA_HOME = tmp;
  // Empty rather than deleted: dotenv refills a missing key from the local
  // .env, which on a developer's machine names the real organisation.
  process.env.ALPHA_ORG = org ?? '';
  vi.resetModules();

  (await import('./githubApi.js')).useGitHubApi(fakeGitHub);

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

    const { rows } = await pg.query<{ id: string; identifier: string; title: string; workspace_id: string; github_number: number }>(
      'select id, identifier, title, workspace_id, github_number from issues'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // GitHub's own id for the issue, so every copy of the board agrees.
      id: 'gh-issue-9001',
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
      throw new Error('GitHub 404 on GET /repos/acme/checkout/issues: Not Found');
    };

    const report = await sync('ws-default');
    expect(report.errors).toHaveLength(1);
    expect((await pg.query('select id from issues')).rows).toEqual([]);
  });

  /**
   * A workspace's catalogue is what its PMs started. A sync that turned every
   * organisation repository into a project is how Alpha Workspace came to list
   * the whole organisation.
   */
  it('does not turn the organisation’s repositories into projects', async () => {
    const sync = await loadCloudSync('acme');

    const report = await sync('ws-default');

    expect(report.projectsImported).toBe(0);
    expect((await pg.query<{ id: string }>('select id from projects order by id')).rows.map(r => r.id)).toEqual(['p1']);
  });
});
