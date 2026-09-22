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
/** Every `gh` invocation, so the arguments can be asserted. */
let calls: string[][];
let responder: (args: string[]) => string | Error;

async function loadService() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  calls = [];

  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
      ...actual,
      execFile: (_cmd: string, args: string[], _o: unknown, cb: Function) => {
        calls.push(args);
        const out = responder(args);
        if (out instanceof Error) return cb(out);
        return cb(null, { stdout: out }, '');
      }
    };
  });

  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);
  const write = await import('./githubBoardWrite.js');
  write.resetLabelCache();
  return { svc: sql.sqliteService as any, write };
}

/** Default: labels already exist, issue reads back with a teammate label. */
const defaultResponder = (args: string[]): string => {
  const joined = args.join(' ');
  if (joined.includes('/labels')) {
    return ['alpha:todo', 'alpha:in-progress', 'alpha:review', 'alpha:backlog',
            'alpha:agent-running', 'alpha:p-urgent', 'alpha:p-high', 'alpha:p-medium',
            'alpha:p-low', 'alpha:p-none'].join('\n');
  }
  if (args.includes('--method') && args.includes('PATCH')) return '{}';
  if (joined.match(/issues\/\d+$/)) {
    return JSON.stringify({ labels: [{ name: 'bug' }, { name: 'alpha:todo' }] });
  }
  if (joined.includes('/issues')) {
    return JSON.stringify({ number: 42, html_url: 'https://github.com/o/r/issues/42' });
  }
  return '';
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

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
});

const argsOf = (match: string) => calls.filter(c => c.join(' ').includes(match));

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

    const create = argsOf('POST')[0] ?? calls.find(c => c.join(' ').includes('repos/o/r/issues'))!;
    const sent = create.join(' ');
    expect(sent).toContain('labels[]=alpha:in-progress');
    expect(sent).toContain('labels[]=alpha:p-high');
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
    responder = (args) => {
      const joined = args.join(' ');
      if (joined.includes('/labels') && !args.includes('-f')) return '';   // none exist
      if (joined.includes('/labels')) return '{}';                          // create
      if (joined.includes('/issues')) return JSON.stringify({ number: 1, html_url: 'u' });
      return '';
    };
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc), 'ws-default');

    const created = calls.filter(c => c.join(' ').includes('repos/o/r/labels') && c.includes('-f'));
    expect(created.length).toBeGreaterThan(0);
    expect(created.map(c => c.join(' ')).join(' ')).toContain('name=alpha:in-progress');
  });

  it('does not create a label that already exists', async () => {
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc), 'ws-default');
    expect(calls.filter(c => c.join(' ').includes('/labels') && c.includes('-f'))).toHaveLength(0);
  });

  it('checks a repository only once per process', async () => {
    const { svc, write } = await loadService();
    const issue = plant(svc);
    await write.pushIssue(issue, 'ws-default');
    await write.pushIssue(issue, 'ws-default');
    expect(calls.filter(c => c.join(' ').includes('/labels?per_page'))).toHaveLength(1);
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

    const patch = calls.find(c => c.includes('PATCH'))!.join(' ');
    expect(patch).toContain('labels[]=bug');            // read back from GitHub
    expect(patch).toContain('labels[]=alpha:review');
    expect(patch).not.toContain('labels[]=alpha:todo'); // the old status is gone
  });

  it('closes the issue for done and writes no done label', async () => {
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc, { githubRepo: 'o/r', githubNumber: 7, status: 'done' }), 'ws-default');

    const patch = calls.find(c => c.includes('PATCH'))!.join(' ');
    expect(patch).toContain('state=closed');
    // Done is expressed by closing; a label would be left behind on a reopen.
    expect(patch).not.toContain('alpha:done');
  });

  it('reopens the issue for any other status', async () => {
    const { svc, write } = await loadService();
    await write.pushIssue(plant(svc, { githubRepo: 'o/r', githubNumber: 7, status: 'in_progress' }), 'ws-default');

    expect(calls.find(c => c.includes('PATCH'))!.join(' ')).toContain('state=open');
  });

  it('falls back to the local labels when GitHub cannot be read', async () => {
    // A stale label set is better than refusing to record the status change.
    responder = (args) => {
      const joined = args.join(' ');
      if (joined.includes('/labels?per_page')) return 'alpha:review\nalpha:p-medium';
      if (joined.match(/issues\/7$/) && !args.includes('PATCH')) return new Error('502');
      return '{}';
    };
    const { svc, write } = await loadService();
    const issue = plant(svc, { githubRepo: 'o/r', githubNumber: 7, status: 'review', labels: ['bug'] });

    const result = await write.pushIssue(issue, 'ws-default');

    expect(result.pushed).toBe(true);
    expect(calls.find(c => c.includes('PATCH'))!.join(' ')).toContain('labels[]=bug');
  });
});

describe('failure reporting', () => {
  /**
   * The local write already happened; the browser must be told the shared copy
   * did not, or the board shows a state GitHub never accepted and the next
   * sync silently reverts it.
   */
  it('reports a failure instead of throwing', async () => {
    responder = (args) =>
      args.join(' ').includes('/labels?per_page') ? '' : new Error('gh: 403 Forbidden');
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
