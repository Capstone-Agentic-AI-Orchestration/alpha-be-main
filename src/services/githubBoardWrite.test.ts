import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Pushing a board change up to GitHub.
 *
 * The read path made a teammate's issues visible; without this the board is
 * still single-player — you watch what other people do and they see nothing of
 * yours.
 *
 * The cases that matter are the destructive ones. A status change must not
 * delete a teammate's labels, and a failed push must be reported rather than
 * leaving the board showing a state GitHub never accepted.
 */
let tmp: string;
let opened: { close(): void }[] = [];

interface Call { method: 'GET' | 'POST' | 'PATCH'; path: string; body?: any }
/** Every request made of GitHub, so what was sent can be asserted. */
let calls: Call[];
/** Answers for GitHub. An Error is thrown, as a failed request would be. */
let responder: (call: Call) => unknown;

function answer(call: Call): any {
  calls.push(call);
  const out = responder(call);
  if (out instanceof Error) throw out;
  return out;
}

const fakeGitHub = {
  get: async (p: string) => answer({ method: 'GET', path: p }),
  getAll: async (p: string) => answer({ method: 'GET', path: p }),
  post: async (p: string, body: unknown) => answer({ method: 'POST', path: p, body }),
  patch: async (p: string, body: unknown) => answer({ method: 'PATCH', path: p, body })
};

async function loadService() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  calls = [];

  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);
  // From the same module registry as the service under test, or the override
  // would be set on a copy it never reads.
  (await import('./githubApi.js')).useGitHubApi(fakeGitHub);
  const write = await import('./githubBoardWrite.js');
  write.resetLabelCache();
  return { svc: sql.sqliteService as any, write };
}

const MANAGED = ['alpha:todo', 'alpha:in-progress', 'alpha:review', 'alpha:backlog',
  'alpha:agent-running', 'alpha:p-urgent', 'alpha:p-high', 'alpha:p-medium',
  'alpha:p-low', 'alpha:p-none'];

/** Default: labels already exist, issue reads back with a teammate label. */
const defaultResponder = ({ method, path: p }: Call): unknown => {
  if (p.includes('/labels')) return method === 'GET' ? MANAGED.map(name => ({ name })) : {};
  if (method === 'PATCH') return {};
  if (/issues\/\d+$/.test(p)) return { labels: [{ name: 'bug' }, { name: 'alpha:todo' }] };
  if (p.endsWith('/issues')) return { number: 42, html_url: 'https://github.com/o/r/issues/42' };
  return {};
};

function plant(svc: any, over: Record<string, unknown> = {}) {
  svc.createProject({
    id: 'p1', name: 'Backend', key: 'ALF',
    resources: [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/o/r' }]
  });
  return svc.createIssue({
    id: 'iss-1', projectId: 'p1', identifier: 'ALF-101',
    title: 'Add a thing', description: 'because', status: 'todo', priority: 'medium',
    labels: [], ...over
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-ghwrite-'));
  opened = [];
  responder = defaultResponder;
});

afterEach(async () => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  (await import('./githubApi.js')).useGitHubApi(null);
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const patchSent = () => calls.find(c => c.method === 'PATCH')!.body;
const labelsCreated = () => calls.filter(c => c.method === 'POST' && c.path.endsWith('/labels'));

describe('pushing a new issue', () => {
  it('creates it on GitHub and reports the number back', async () => {
    const { svc, write } = await loadService();
    const issue = plant(svc);

    const result = await write.pushIssue(issue, 'ws-default');

    expect(result.pushed).toBe(true);
    expect(result.patch).toMatchObject({
      githubRepo: 'o/r',
      githubNumber: 42,
      githubUrl: 'https://github.com/o/r/issues/42'
    });
  });

  it('sends the status and priority as labels', async () => {
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc, { status: 'in_progress', priority: 'high' }), 'ws-default');

    const create = calls.find(c => c.method === 'POST' && c.path === '/repos/o/r/issues')!;
    expect(create.body.labels).toEqual(expect.arrayContaining(['alpha:in-progress', 'alpha:p-high']));
    expect(create.body).toMatchObject({ title: 'Add a thing', body: 'because' });
  });

  /** A local-only board is a valid way to use Alpha. */
  it('pushes nothing for a project with no repository', async () => {
    const { svc, write } = await loadService();
    svc.createProject({ id: 'p2', name: 'Local', key: 'LOC', resources: [] });
    const issue = svc.createIssue({ id: 'iss-2', projectId: 'p2', title: 'Local only' });

    const result = await write.pushIssue(issue, 'ws-default');

    expect(result.pushed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('label bootstrapping', () => {
  /**
   * Adding a label that does not exist is an error, not an implicit create.
   * The first real sync test could not set `alpha:in-progress` until the label
   * had been made by hand.
   */
  it('creates the missing labels before writing', async () => {
    responder = (call) => {
      if (call.path.includes('/labels')) return call.method === 'GET' ? [] : {};   // none exist
      if (call.path.endsWith('/issues')) return { number: 1, html_url: 'u' };
      return {};
    };
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc), 'ws-default');

    const created = labelsCreated();
    expect(created.length).toBeGreaterThan(0);
    expect(created.map(c => c.body.name)).toContain('alpha:in-progress');
    // Labels first: the issue's own create would fail without them.
    const firstLabel = calls.indexOf(created[0]);
    const issueCreate = calls.findIndex(c => c.method === 'POST' && c.path.endsWith('/issues'));
    expect(firstLabel).toBeLessThan(issueCreate);
  });

  it('does not create a label that already exists', async () => {
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc), 'ws-default');
    expect(labelsCreated()).toHaveLength(0);
  });

  it('checks a repository only once per process', async () => {
    const { svc, write } = await loadService();
    const issue = plant(svc);
    await write.pushIssue(issue, 'ws-default');
    await write.pushIssue(issue, 'ws-default');
    expect(calls.filter(c => c.method === 'GET' && c.path.includes('/labels?per_page'))).toHaveLength(1);
  });
});

describe('pushing an update', () => {
  /**
   * The case this whole path could get catastrophically wrong.
   *
   * Replacing the label set is the obvious implementation, and it silently
   * deletes `bug`, `security`, `good first issue` — triage someone did on
   * github.com, undone by a colleague dragging a card.
   */
  it('keeps labels Alpha does not own', async () => {
    const { svc, write } = await loadService();
    const issue = plant(svc, { githubRepo: 'o/r', githubNumber: 7, status: 'review' });

    await write.pushIssue(issue, 'ws-default');

    const { labels } = patchSent();
    expect(labels).toContain('bug');                // read back from GitHub
    expect(labels).toContain('alpha:review');
    expect(labels).not.toContain('alpha:todo');     // the old status is gone
  });

  it('closes the issue for done and writes no done label', async () => {
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc, { githubRepo: 'o/r', githubNumber: 7, status: 'done' }), 'ws-default');

    expect(patchSent().state).toBe('closed');
    // Done is expressed by closing; a label would be left behind on a reopen.
    expect(patchSent().labels).not.toContain('alpha:done');
  });

  it('reopens the issue for any other status', async () => {
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc, { githubRepo: 'o/r', githubNumber: 7, status: 'in_progress' }), 'ws-default');

    expect(patchSent().state).toBe('open');
  });

  it('falls back to the local labels when GitHub cannot be read', async () => {
    // A stale label set is better than refusing to record the status change.
    responder = (call) => {
      if (call.path.includes('/labels?per_page')) return [{ name: 'alpha:review' }, { name: 'alpha:p-medium' }];
      if (call.method === 'GET' && /issues\/7$/.test(call.path)) return new Error('GitHub 502');
      return {};
    };
    const { svc, write } = await loadService();
    const issue = plant(svc, { githubRepo: 'o/r', githubNumber: 7, status: 'review', labels: ['bug'] });

    const result = await write.pushIssue(issue, 'ws-default');

    expect(result.pushed).toBe(true);
    expect(patchSent().labels).toContain('bug');
  });
});

describe('failure reporting', () => {
  /**
   * The local write already happened; the browser must be told the shared copy
   * did not, or the board shows a state GitHub never accepted and the next
   * sync silently reverts it.
   */
  it('reports a failure instead of throwing', async () => {
    responder = (call) =>
      call.path.includes('/labels?per_page') ? [] : new Error('GitHub 403 on POST: Forbidden');
    const { svc, write } = await loadService();

    const result = await write.pushIssue(plant(svc), 'ws-default');

    expect(result.pushed).toBe(false);
    expect(result.error).toContain('403');
  });
});

describe('needsPush', () => {
  it('is true only for fields GitHub owns', async () => {
    const { svc, write } = await loadService();
    const before = plant(svc);

    expect(write.needsPush(before, { ...before, status: 'review' })).toBe(true);
    expect(write.needsPush(before, { ...before, title: 'Renamed' })).toBe(true);
    expect(write.needsPush(before, { ...before, priority: 'urgent' })).toBe(true);
    // Alpha's own business — spending a GitHub request on it changes nothing.
    expect(write.needsPush(before, { ...before, assignedAgentId: 'agent-architect' })).toBe(false);
    expect(write.needsPush(before, { ...before, branchName: 'feat/x' })).toBe(false);
  });
});
