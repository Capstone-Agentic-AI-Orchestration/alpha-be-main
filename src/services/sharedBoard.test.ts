import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Issue, IssueComment, Project } from '../models/index.js';
import { createTestDatabase } from '../store/testDatabase.js';
import { withProjectDefaults } from '../store/projectStore.js';

/**
 * A desktop on a team's board.
 *
 * The desktop's SQLite is real; the team's board is a stub standing in for
 * Postgres behind the Data API, since what is under test is what the pull does
 * to this machine's copy. The rows it would send back are checked against the
 * real migration separately, at the bottom.
 */

let tmp: string;
let opened: { close(): void }[] = [];

const now = '2026-09-22T10:00:00.000Z';

const cloudProject = (over: Partial<Project> = {}): Project =>
  withProjectDefaults({
    id: 'gh-repo-100',
    name: 'checkout',
    key: 'CHK',
    githubOrg: 'acme',
    resources: [{ id: 'gh-repo-100-repo', type: 'github_repo', name: 'acme/checkout', pathOrUrl: 'https://github.com/acme/checkout' }],
    createdAt: now,
    // Pinned: the default is the time of the call, which a real row does not change.
    startDate: now,
    ...over
  });

const cloudIssue = (over: Partial<Issue> = {}): Issue => ({
  id: 'gh-issue-9001',
  identifier: 'CHK-7',
  title: 'Cart loses items',
  description: 'Steps to reproduce',
  status: 'todo',
  priority: 'high',
  projectId: 'gh-repo-100',
  labels: [],
  subtasks: [],
  comments: [],
  githubRepo: 'acme/checkout',
  githubNumber: 7,
  githubUrl: 'https://github.com/acme/checkout/issues/7',
  createdAt: now,
  updatedAt: now,
  ...over
});

const cloudComment = (over: Partial<IssueComment> = {}): IssueComment => ({
  id: 'gh-acme/checkout-555',
  issueId: 'gh-issue-9001',
  authorType: 'user',
  authorName: 'octocat',
  content: 'Reproduced on staging.',
  createdAt: now,
  ...over
});

/** The team's board as the pull will read it. */
function source(board: { projects?: Project[]; issues?: Issue[]; comments?: IssueComment[] } = {}) {
  return {
    projects: async () => board.projects ?? [cloudProject()],
    issues: async () => board.issues ?? [cloudIssue()],
    comments: async () => board.comments ?? [cloudComment()]
  };
}

async function load() {
  process.env.ALPHA_HOME = tmp;
  delete process.env.ALPHA_MODE;
  vi.resetModules();
  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);
  const board = await import('./sharedBoard.js');
  const svc = sql.sqliteService as any;
  const { runWithWorkspace } = await import('./workspaceContext.js');
  const inWorkspace = <T>(fn: () => T) => runWithWorkspace('ws-default', fn);
  return { svc, board, inWorkspace };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-sharedboard-'));
  opened = [];
});

afterEach(() => {
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.resetModules();
});

describe('pulling the team board', () => {
  /** What makes a developer's run something the cloud will accept. */
  it('writes the team’s cards under the team’s ids', async () => {
    const { svc, board, inWorkspace } = await load();

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report).toMatchObject({ projectsAdded: 1, issuesAdded: 1, comments: 1, conflicts: [] });
    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue).toMatchObject({ identifier: 'CHK-7', projectId: 'gh-repo-100', priority: 'high' });
    expect(issue.comments.map((c: IssueComment) => c.content)).toContain('Reproduced on staging.');
  });

  it('changes nothing the second time', async () => {
    const { board } = await load();
    await board.pullSharedBoard('ws-default', source());

    const again = await board.pullSharedBoard('ws-default', source());

    expect(again).toMatchObject({ projectsAdded: 0, projectsUpdated: 0, issuesAdded: 0, issuesUpdated: 0, comments: 0 });
  });

  it('takes the team’s changes to a card', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());

    await board.pullSharedBoard('ws-default', source({ issues: [cloudIssue({ title: 'Cart empties', status: 'in_progress' })] }));

    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue).toMatchObject({ title: 'Cart empties', status: 'in_progress' });
  });

  /** The cloud never stores a folder on this disk, so a pull must not erase it. */
  it('keeps this machine’s folder for a project', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());
    inWorkspace(() =>
      svc.updateProject('gh-repo-100', {
        resources: [
          ...cloudProject().resources,
          { id: 'local', type: 'local_path', name: 'checkout', pathOrUrl: 'C:/code/checkout' }
        ]
      })
    );

    await board.pullSharedBoard('ws-default', source({ projects: [cloudProject({ name: 'Checkout service' })] }));

    const project = inWorkspace(() => svc.getProjects()).find((p: Project) => p.id === 'gh-repo-100');
    expect(project.name).toBe('Checkout service');
    expect(project.resources.map((r: any) => r.type)).toEqual(['github_repo', 'local_path']);
  });

  /** The runner owns a card while an agent works on it here. */
  it('leaves a card alone while this machine is running it', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());
    inWorkspace(() => {
      svc.updateIssue('gh-issue-9001', { status: 'agent_running', branchName: 'alpha/fix-cart' });
      svc.savePrototypeRun({
        id: 'run-1', issueId: 'gh-issue-9001', projectId: 'gh-repo-100', agentId: 'agent-architect',
        status: 'running', scenario: 'success', plan: [], currentStageIndex: 0, stages: [], activities: [],
        createdAt: now, updatedAt: now
      });
    });

    await board.pullSharedBoard('ws-default', source({ issues: [cloudIssue({ status: 'todo', title: 'Renamed on the web' })] }));

    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue).toMatchObject({ status: 'agent_running', branchName: 'alpha/fix-cart', title: 'Renamed on the web' });
  });

  /** How the next sync knows a comment has already gone to GitHub. */
  it('learns that a comment was published', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source({ comments: [cloudComment({ id: 'comm-run-1' })] }));

    await board.pullSharedBoard('ws-default', source({ comments: [cloudComment({ id: 'comm-run-1', githubId: 777 })] }));

    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue.comments.find((c: IssueComment) => c.id === 'comm-run-1')?.githubId).toBe(777);
  });
});

describe('cards this machine made before it joined the team', () => {
  /**
   * Same repository, another id. Merging would mean rewriting every run and
   * comment that points at the local one, so the pull says so instead.
   */
  it('reports a project that is already here under another id', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() =>
      svc.createProject({
        id: 'proj-mine', name: 'My checkout', key: 'MINE',
        resources: [{ id: 'r', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }]
      })
    );

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report.conflicts).toEqual([expect.objectContaining({ project: 'MINE' })]);
    expect(report.conflicts[0].detail).toMatch(/Remove MINE/);
    // Neither the team's project nor its cards were added beside the local one.
    const ids = inWorkspace(() => svc.getProjects()).map((p: Project) => p.id);
    expect(ids).not.toContain('gh-repo-100');
    expect(inWorkspace(() => svc.getIssues()).map((i: Issue) => i.id)).not.toContain('gh-issue-9001');
  });

  it('reports an issue that is already here under another id', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source({ issues: [], comments: [] }));
    inWorkspace(() =>
      svc.createIssue({ id: 'issue-mine', identifier: 'CHK-900', projectId: 'gh-repo-100', title: 'Mine', githubRepo: 'acme/checkout', githubNumber: 7 })
    );

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report.conflicts).toEqual([expect.objectContaining({ project: 'CHK-900' })]);
    expect(inWorkspace(() => svc.getIssues()).map((i: Issue) => i.id)).toEqual(['issue-mine']);
  });

  it('reports a key this machine already uses', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() => svc.createProject({ id: 'proj-other', name: 'Other', key: 'CHK', resources: [] }));

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report.conflicts).toEqual([expect.objectContaining({ project: 'CHK' })]);
  });
});

describe('asSyncReport', () => {
  it('puts clashes where the app shows them one by one', async () => {
    const { board } = await load();

    const shaped = board.asSyncReport({
      projectsAdded: 2, projectsUpdated: 1, issuesAdded: 5, issuesUpdated: 3, unchanged: 4, comments: 6,
      conflicts: [{ project: 'MINE', detail: 'clash' }]
    });

    expect(shaped).toMatchObject({ projectsImported: 2, created: 5, errors: [{ project: 'MINE', detail: 'clash' }] });
  });
});

describe('supabaseBoardSource', () => {
  /** A stand-in for supabase-js's query builder: every call returns the builder, `range` answers. */
  function fakeClient(pages: Record<string, unknown[][]>, error?: string) {
    const calls: Array<{ table: string; from: number; to: number }> = [];
    return {
      calls,
      client: {
        from(table: string) {
          const builder: any = {
            select: () => builder,
            eq: () => builder,
            order: () => builder,
            range: async (from: number, to: number) => {
              calls.push({ table, from, to });
              if (error) return { data: null, error: { message: error } };
              return { data: pages[table]?.[from / 1000] ?? [], error: null };
            }
          };
          return builder;
        }
      } as any
    };
  }

  /** A board of more than a thousand cards must not stop at the first page. */
  it('reads every page', async () => {
    const { board } = await load();
    const row = (i: number) => ({
      id: `i${i}`, identifier: `CHK-${i}`, title: 't', description: '', status: 'todo', priority: 'low', project_id: 'p',
      assigned_agent_id: null, assigned_squad_id: null, assigned_human: null, created_by: null, labels: [], subtasks: [],
      branch_name: null, pr_url: null, github_repo: null, github_number: null, github_url: null,
      created_at: now, updated_at: now
    });
    const { client, calls } = fakeClient({
      issues: [Array.from({ length: 1000 }, (_, i) => row(i)), [row(1000)]]
    });

    const issues = await board.supabaseBoardSource(client).issues('ws-default');

    expect(issues).toHaveLength(1001);
    expect(calls.map(c => c.from)).toEqual([0, 1000]);
  });

  it('fails loudly rather than pulling a partial board', async () => {
    const { board } = await load();
    const { client } = fakeClient({}, 'JWT expired');

    await expect(board.supabaseBoardSource(client).projects('ws-default')).rejects.toThrow('JWT expired');
  });
});

describe('the rows the desktop writes back', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await pg?.close();
  });

  /**
   * Column names are the one thing no type catches: a typo is a valid object
   * that every insert refuses. So they go into the real migration.
   */
  it('fit the real schema, and read back as they were sent', async () => {
    const { issueRow, commentRow, toIssue, toComment } = await import('../store/postgresIssueStore.js');
    await pg.exec(`insert into workspaces (id, name, slug) values ('ws-default', 'Alpha', 'alpha')`);
    await pg.exec(`insert into projects (id, workspace_id, name, key) values ('gh-repo-100', 'ws-default', 'checkout', 'CHK')`);

    const issue = cloudIssue({ assignedHuman: 'octocat', labels: ['bug'] });
    const comment = cloudComment({ githubId: 555 });
    const insert = async (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row);
      await pg.query(
        `insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map(column => {
          const value = row[column];
          return Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value) : value;
        })
      );
    };
    await insert('issues', issueRow('ws-default', issue));
    await insert('issue_comments', commentRow(comment));

    const [back] = (await pg.query<any>('select * from issues')).rows;
    const [backComment] = (await pg.query<any>('select * from issue_comments')).rows;
    expect(toIssue(back, [])).toEqual({ ...issue, comments: [] });
    expect(toComment(backComment)).toEqual({ ...comment, isThinking: false, authorAvatar: undefined, agentId: undefined });
  });
});
