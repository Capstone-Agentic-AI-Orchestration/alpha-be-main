import { describe, expect, it } from 'vitest';

import type { GitHubApi } from './githubApi.js';
import { createIssue, failedRunLogs, MAX_RUN_ATTEMPTS, rerunFailedJobs } from './agentCiActions.js';

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
