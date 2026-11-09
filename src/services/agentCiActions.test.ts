import { describe, expect, it } from 'vitest';

import type { GitHubApi } from './githubApi.js';
import { commentOnIssue, createIssue, failedRunLogs, MAX_RUN_ATTEMPTS, rerunFailedJobs, updateIssue } from './agentCiActions.js';

/**
 * What an agent may do about CI by itself: read a failure, retry it once, and
 * open an issue for it -- and nothing that would make a red run look green.
 */

type Call = { method: string; path: string; body?: unknown };

function fakeApi(answers: Record<string, unknown>, text: Record<string, string> = {}) {
  const calls: Call[] = [];
  const answer = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (!(path in answers)) throw new Error(`unexpected ${method} ${path}`);
    return answers[path];
  };
  const api: GitHubApi = {
    get: async (path: string) => answer('GET', path) as any,
    getAll: async (path: string) => answer('GET', path) as any,
    post: async (path: string, body: unknown) => answer('POST', path, body) as any,
    patch: async (path: string, body: unknown) => answer('PATCH', path, body) as any,
    put: async (path: string, body: unknown) => answer('PUT', path, body) as any,
    delete: async (path: string) => {
      answer('DELETE', path);
    },
    getText: async (path: string) => {
      calls.push({ method: 'GET', path });
      if (!(path in text)) throw new Error('GitHub 410 on GET: logs expired');
      return text[path];
    }
  };
  return { api, calls };
}

const RUN = '/repos/acme/shop/actions/runs/42';

describe('reading why a run failed', () => {
  it('returns each failed job with its failed steps and the end of its log, without timestamps', async () => {
    const { api } = fakeApi(
      {
        [`${RUN}/jobs?filter=latest&per_page=100`]: {
          jobs: [
            { id: 1, name: 'lint', conclusion: 'success', steps: [] },
            {
              id: 2,
              name: 'unit-tests / Backend Unit Tests',
              conclusion: 'failure',
              html_url: 'https://github.com/acme/shop/actions/runs/42/job/2',
              steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }]
            }
          ]
        }
      },
      { '/repos/acme/shop/actions/jobs/2/logs': '2026-11-08T05:00:00.1234567Z FAIL tests/unit/app.spec.ts\n2026-11-08T05:00:01Z Expected 200, got 500' }
    );

    const report = await failedRunLogs(api, 'acme/shop', '42');

    expect(report).toContain('Job "unit-tests / Backend Unit Tests" failure.');
    expect(report).toContain('Failed steps: Run tests');
    expect(report).toContain('FAIL tests/unit/app.spec.ts\nExpected 200, got 500');
    expect(report).not.toContain('2026-11-08T');
    expect(report).not.toContain('"lint"');
  });

  it('says so when a log cannot be read, instead of failing the whole answer', async () => {
    const { api } = fakeApi({
      [`${RUN}/jobs?filter=latest&per_page=100`]: { jobs: [{ id: 3, name: 'build', conclusion: 'timed_out', steps: [] }] }
    });

    expect(await failedRunLogs(api, 'acme/shop', 42)).toMatch(/Job "build" timed_out\.[\s\S]*could not read the log/);
  });

  it('reports a run with no failed jobs plainly', async () => {
    const { api } = fakeApi({ [`${RUN}/jobs?filter=latest&per_page=100`]: { jobs: [{ id: 1, name: 'lint', conclusion: 'success' }] } });

    expect(await failedRunLogs(api, 'acme/shop', '42')).toBe('No failed jobs in this run.');
  });

  it('refuses a malformed repository or run id before calling GitHub', async () => {
    const { api, calls } = fakeApi({});

    await expect(failedRunLogs(api, 'acme/shop/../x', '42')).rejects.toThrow('owner/name');
    await expect(failedRunLogs(api, 'acme/shop', '42;rm')).rejects.toThrow('Invalid workflow run id');
    expect(calls).toEqual([]);
  });
});

describe('retrying a failed run', () => {
  it('retries the failed jobs of a finished first attempt', async () => {
    const { api, calls } = fakeApi({
      [RUN]: { id: 42, status: 'completed', conclusion: 'failure', run_attempt: 1, head_branch: 'agent/fix', html_url: 'u' },
      [`${RUN}/rerun-failed-jobs`]: undefined
    });

    expect(await rerunFailedJobs(api, 'acme/shop', '42')).toEqual({ runId: 42, attempt: 2, url: 'u', branch: 'agent/fix' });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: `${RUN}/rerun-failed-jobs`, body: {} });
  });

  it('refuses a second retry, so a run cannot be retried until it happens to pass', async () => {
    const { api, calls } = fakeApi({
      [RUN]: { id: 42, status: 'completed', conclusion: 'failure', run_attempt: MAX_RUN_ATTEMPTS, html_url: 'u' }
    });

    await expect(rerunFailedJobs(api, 'acme/shop', '42')).rejects.toThrow(/already been retried[\s\S]*fix the cause/);
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('refuses runs that are still going or that passed', async () => {
    const running = fakeApi({ [RUN]: { id: 42, status: 'in_progress', conclusion: null, run_attempt: 1, html_url: 'u' } });
    await expect(rerunFailedJobs(running.api, 'acme/shop', '42')).rejects.toThrow('still in progress');

    const passed = fakeApi({ [RUN]: { id: 42, status: 'completed', conclusion: 'success', run_attempt: 1, html_url: 'u' } });
    await expect(rerunFailedJobs(passed.api, 'acme/shop', '42')).rejects.toThrow('Nothing failed');
  });
});

describe('opening an issue', () => {
  it('opens it with the agent attribution at the end of the body', async () => {
    const { api, calls } = fakeApi({ '/repos/acme/shop/issues': { number: 7, html_url: 'https://github.com/acme/shop/issues/7' } });

    const issue = await createIssue(
      api,
      'acme/shop',
      { title: ' Audit fails on body-parser ', body: 'Run 42 fails Dependency Audit.', labels: ['ci'] },
      'Opened by an Alpha agent during run r1.'
    );

    expect(issue).toEqual({ number: 7, url: 'https://github.com/acme/shop/issues/7' });
    expect(calls[0].body).toEqual({
      title: 'Audit fails on body-parser',
      body: 'Run 42 fails Dependency Audit.\n\n---\n\n_Opened by an Alpha agent during run r1._',
      labels: ['ci']
    });
  });

  it('refuses an issue with no title or bad labels', async () => {
    const { api, calls } = fakeApi({});

    await expect(createIssue(api, 'acme/shop', { title: '  ' }, 'a')).rejects.toThrow('title');
    await expect(createIssue(api, 'acme/shop', { title: 't', labels: [''] }, 'a')).rejects.toThrow('Labels');
    expect(calls).toEqual([]);
  });
});

const ISSUE = '/repos/acme/shop/issues/7';
const agentIssue = (extra: Record<string, unknown> = {}) => ({
  number: 7, title: 'Audit fails', state: 'open', html_url: 'https://github.com/acme/shop/issues/7',
  body: 'Run 42 fails Dependency Audit.\n\n---\n\n_Opened by an Alpha agent during run r1._', ...extra
});
const personIssue = (extra: Record<string, unknown> = {}) => ({ number: 7, title: 'Typo on login', state: 'open', html_url: 'u', body: 'Please fix.', ...extra });

describe('commenting on an issue', () => {
  it('comments on any issue in the repository, signed as an agent', async () => {
    const { api, calls } = fakeApi({ [ISSUE]: personIssue(), [ISSUE + '/comments']: { id: 1, html_url: 'https://github.com/acme/shop/issues/7#c1' } });
    const result = await commentOnIssue(api, 'acme/shop', 7, ' Fixed in #12. ', 'Posted by an Alpha agent during run r2.');
    expect(result).toEqual({ issue: 7, url: 'https://github.com/acme/shop/issues/7#c1' });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: ISSUE + '/comments', body: { body: 'Fixed in #12.\n\n---\n\n_Posted by an Alpha agent during run r2._' } });
  });

  it('refuses pull requests, locked issues, empty text and bad numbers', async () => {
    const pr = fakeApi({ [ISSUE]: personIssue({ pull_request: {} }) });
    await expect(commentOnIssue(pr.api, 'acme/shop', 7, 'x', 'a')).rejects.toThrow('github_review_pull_request');
    const locked = fakeApi({ [ISSUE]: personIssue({ locked: true }) });
    await expect(commentOnIssue(locked.api, 'acme/shop', 7, 'x', 'a')).rejects.toThrow('locked');
    const none = fakeApi({});
    await expect(commentOnIssue(none.api, 'acme/shop', 7, '  ', 'a')).rejects.toThrow('needs text');
    await expect(commentOnIssue(none.api, 'acme/shop', 0, 'x', 'a')).rejects.toThrow('Invalid issue number');
    expect([...pr.calls, ...locked.calls, ...none.calls].some(call => call.method === 'POST')).toBe(false);
  });
});

describe('editing, closing and reopening an issue', () => {
  it('edits an agent\'s issue and keeps the line saying an agent opened it', async () => {
    const { api, calls } = fakeApi({ [ISSUE]: agentIssue() });
    (api as any).patch = async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return { ...agentIssue(), html_url: 'u2' }; };
    const result = await updateIssue(api, 'acme/shop', 7, { title: 'Audit fails on multer', body: 'Run 43 too.', labels: ['ci'] }, 'Posted by an Alpha agent.');
    expect(result).toMatchObject({ number: 7, changed: ['title', 'labels', 'body'] });
    expect(calls.at(-1)).toEqual({ method: 'PATCH', path: ISSUE, body: {
      title: 'Audit fails on multer', labels: ['ci'], body: 'Run 43 too.\n\n---\n\n_Opened by an Alpha agent during run r1._'
    } });
  });

  it('closes an agent\'s issue only with a reason, posted before it closes', async () => {
    const { api, calls } = fakeApi({ [ISSUE]: agentIssue(), [ISSUE + '/comments']: { id: 2, html_url: 'c' } });
    (api as any).patch = async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return { ...agentIssue(), state: 'closed' }; };
    await expect(updateIssue(api, 'acme/shop', 7, { state: 'closed' }, 'a')).rejects.toThrow('needs a comment');
    expect(calls).toEqual([]);

    const result = await updateIssue(api, 'acme/shop', 7, { state: 'closed', comment: 'Fixed in #12.' }, 'Posted by an Alpha agent.');
    expect(result).toMatchObject({ state: 'closed', changed: ['state'] });
    expect(calls.map(call => call.method + ' ' + call.path)).toEqual(['GET ' + ISSUE, 'POST ' + ISSUE + '/comments', 'PATCH ' + ISSUE]);
    expect(calls.at(-1)?.body).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('reopens an agent\'s issue', async () => {
    const { api, calls } = fakeApi({ [ISSUE]: agentIssue({ state: 'closed' }) });
    (api as any).patch = async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return agentIssue(); };
    await expect(updateIssue(api, 'acme/shop', 7, { state: 'open' }, 'a')).resolves.toMatchObject({ state: 'open', changed: ['state'] });
    expect(calls.at(-1)?.body).toEqual({ state: 'open' });
  });

  it('refuses to edit or close an issue a person opened', async () => {
    const { api, calls } = fakeApi({ [ISSUE]: personIssue() });
    await expect(updateIssue(api, 'acme/shop', 7, { state: 'closed', comment: 'Done.' }, 'a')).rejects.toThrow(/not opened by an Alpha agent[\s\S]*github_comment_issue/);
    await expect(updateIssue(api, 'acme/shop', 7, { title: 'Mine now' }, 'a')).rejects.toThrow('not opened by an Alpha agent');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('refuses an empty change and bad values before asking GitHub', async () => {
    const { api, calls } = fakeApi({});
    await expect(updateIssue(api, 'acme/shop', 7, {}, 'a')).rejects.toThrow('Say what to change');
    await expect(updateIssue(api, 'acme/shop', 7, { state: 'deleted' }, 'a')).rejects.toThrow('open or closed');
    await expect(updateIssue(api, 'acme/shop', 7, { labels: [''] }, 'a')).rejects.toThrow('Labels');
    await expect(updateIssue(api, 'acme/shop', 7, { title: ' ' }, 'a')).rejects.toThrow('title');
    expect(calls).toEqual([]);
  });
});

