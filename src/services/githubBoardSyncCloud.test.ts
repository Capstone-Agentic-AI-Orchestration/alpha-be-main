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
    createdBy: 'PM1',
    name: 'Checkout',
    key: 'CHK',
    resources: [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }]
  });

  const { syncBoardFromGitHub } = await import('./githubBoardSync.js');
  return (workspaceId: string) =>
    syncBoardFromGitHub(workspaceId, 'PM1', { importUntrackedRepositories: true });
}

/** The public route's behavior: update the catalogue, never discover repos implicitly. */
async function loadDefaultCloudSync(org?: string) {
  await loadCloudSync(org);
  const { syncBoardFromGitHub } = await import('./githubBoardSync.js');
  return (workspaceId: string) => syncBoardFromGitHub(workspaceId, 'PM1');
}

describe('the board sync, in the cloud', () => {
  it('does not turn every organization repository into a project', async () => {
    const sync = await loadDefaultCloudSync('acme');

    const report = await sync('ws-default');

    expect(report.projectsImported).toBe(0);
    expect((await pg.query('select id from projects')).rows).toHaveLength(1);
  });

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
});

describe('the organisation’s repositories are its projects', () => {
  const projectRows = async () =>
    (
      await pg.query<{ id: string; key: string; name: string; workspace_id: string; github_org: string; resources: any }>(
        'select id, key, name, workspace_id, github_org, resources from projects order by id'
      )
    ).rows;

  const resourcesOf = (row: { resources: any }) =>
    typeof row.resources === 'string' ? JSON.parse(row.resources) : row.resources;

  it('makes a project for each repository, under GitHub’s id', async () => {
    const sync = await loadCloudSync('acme');

    const report = await sync('ws-default');

    expect(report.projectsImported).toBe(1);
    const payments = (await projectRows()).find(p => p.name === 'payments')!;
    expect(payments).toMatchObject({ id: 'gh-repo-101', key: 'PAYM', workspace_id: 'ws-default', github_org: 'acme' });
    expect(resourcesOf(payments)[0]).toMatchObject({ type: 'github_repo', pathOrUrl: 'https://github.com/acme/payments' });
  });

  /** A repository new since the last sync should not wait for the next one. */
  it('reads the new project’s issues in the same sync', async () => {
    const sync = await loadCloudSync('acme');
    await sync('ws-default');

    const { rows } = await pg.query<{ id: string; identifier: string; project_id: string }>(
      `select id, identifier, project_id from issues where project_id = 'gh-repo-101'`
    );
    expect(rows).toEqual([{ id: 'gh-issue-9002', identifier: 'PAYM-3', project_id: 'gh-repo-101' }]);
  });

  /** A second project for checkout would split its issues across two cards. */
  it('keeps the project someone attached by hand', async () => {
    const sync = await loadCloudSync('acme');
    await sync('ws-default');

    const checkout = (await projectRows()).filter(p => JSON.stringify(resourcesOf(p)).includes('acme/checkout'));
    expect(checkout.map(p => p.id)).toEqual(['p1']);
  });

  it('says why a repository was left out', async () => {
    const sync = await loadCloudSync('acme');

    const report = await sync('ws-default');

    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { project: 'old-site', reason: 'archived on GitHub' },
        { project: 'wiki', reason: 'issues are turned off on GitHub' }
      ])
    );
    expect((await projectRows()).map(p => p.name)).not.toContain('old-site');
  });

  it('imports each repository once', async () => {
    const sync = await loadCloudSync('acme');
    await sync('ws-default');

    const second = await sync('ws-default');

    expect(second.projectsImported).toBe(0);
    expect(await projectRows()).toHaveLength(2);
  });

  /**
   * Ids and keys are unique across workspaces, so a repository can be a
   * project in only one of them. It is the organisation's.
   */
  it('leaves every other workspace alone', async () => {
    await pg.exec(`insert into workspaces (id, name, slug) values ('ws-side', 'Side', 'side')`);
    const sync = await loadCloudSync('acme');

    const report = await sync('ws-side');

    expect(report.projectsImported).toBe(0);
    expect((await projectRows()).map(p => p.id)).toEqual(['p1']);
  });

  /** A key held in a workspace this one cannot see is found out from the database. */
  it('takes the next key when another workspace holds it', async () => {
    await pg.exec(`insert into workspaces (id, name, slug) values ('ws-side', 'Side', 'side')`);
    await pg.exec(`insert into projects (id, workspace_id, name, key) values ('side-1', 'ws-side', 'Mine', 'PAYM')`);
    const sync = await loadCloudSync('acme');

    await sync('ws-default');

    expect((await projectRows()).find(p => p.id === 'gh-repo-101')?.key).toBe('PAYM2');
  });

  it('still syncs the existing projects when the organisation cannot be listed', async () => {
    const sync = await loadCloudSync('acme');
    responder = p => {
      if (p.startsWith('/orgs/')) throw new Error('GitHub 403 on GET /orgs/acme/repos: Forbidden');
      return defaultResponder(p);
    };

    const report = await sync('ws-default');

    expect(report.errors).toEqual([expect.objectContaining({ project: 'acme' })]);
    expect(report.created).toBe(1);
  });
});
