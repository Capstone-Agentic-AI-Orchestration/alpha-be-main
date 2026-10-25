import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionsArtifactDownload, actionsArtifacts, actionsDownload, actionsId, actionsJobLogs, actionsJobs,
  actionsRuns, actionsWorkflows, cleanActionsLog, trustedActionsDownload } from './projectActionsService.js';
import type { GitHubApi } from './githubApi.js';

const run = { id: 11, name: 'CI', workflow_id: 8, run_number: 5, run_attempt: 2, head_branch: 'feature/deleted', head_sha: 'abc',
  event: 'push', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/a/b/actions/runs/11', created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:01:00Z' };
function fake(answer: (path: string) => unknown) {
  const get = vi.fn(async (path: string) => answer(path));
  return { api: { get } as unknown as GitHubApi, get };
}
afterEach(() => vi.unstubAllGlobals());

describe('project Actions history', () => {
  it('reads an envelope, filters the provider history, and exposes the next page', async () => {
    const { api, get } = fake(() => ({ total_count: 85, workflow_runs: [run] }));
    const result = await actionsRuns('a/b', { page: '2', branch: 'feature/deleted', workflow: '8', status: 'failure', from: '2026-10-01', to: '2026-10-25' }, api);
    expect(get.mock.calls[0][0]).toContain('/workflows/8/runs?page=2&per_page=30');
    expect(get.mock.calls[0][0]).toContain('branch=feature%2Fdeleted');
    expect(result).toMatchObject({ totalCount: 85, nextPage: 3, runs: [{ repository: 'a/b', number: 5, attempt: 2, conclusion: 'failure', branch: 'feature/deleted' }] });
  });
  it('reports filtered search limits instead of promising nonexistent pages', async () => {
    const { api } = fake(() => ({ total_count: 1300, workflow_runs: [run] }));
    expect(await actionsRuns('a/b', { page: '10', perPage: '100', status: 'failure' }, api)).toMatchObject({ limited: true, nextPage: null });
  });
  it.each([{ page: '0' }, { page: '1.5' }, { perPage: '101' }, { workflow: '../other' }, { branch: '../secret' }, { status: 'green' }, { from: '2026-02-31' }, { from: '2026-10-25', to: '2026-10-01' }])('rejects invalid query inputs before GitHub: %j', async options => {
    const { api, get } = fake(() => ({}));
    await expect(actionsRuns('a/b', options, api)).rejects.toMatchObject({ status: 400 }); expect(get).not.toHaveBeenCalled();
  });
  it('paginates workflow inventory and artifacts', async () => {
    const { api } = fake(path => path.includes('/workflows?') ? { total_count: 140, workflows: [{ id: 8, name: 'CI', path: 'ci.yml', state: 'disabled_manually' }] } :
      { total_count: 101, artifacts: [{ id: 3, name: 'report', size_in_bytes: 42, expired: true, expires_at: 'date' }] });
    expect(await actionsWorkflows('a/b', { perPage: '100' }, api)).toMatchObject({ nextPage: 2, workflows: [{ state: 'disabled_manually' }] });
    expect(await actionsArtifacts('a/b', '11', { perPage: '100' }, api)).toMatchObject({ nextPage: 2, artifacts: [{ expired: true, size: 42 }] });
  });
  it('requests one exact attempt and preserves skipped jobs and steps', async () => {
    const { api, get } = fake(path => path.endsWith('/runs/11') ? run : { total_count: 1, jobs: [{ id: 7, run_id: 11, name: 'matrix / linux', status: 'completed', conclusion: 'skipped', steps: [] }] });
    expect(await actionsJobs('a/b', '11', { attempt: '1' }, api)).toMatchObject({ attempt: 1, jobs: [{ attempt: 1, conclusion: 'skipped', steps: [] }] });
    expect(get.mock.calls[1][0]).toContain('/attempts/1/jobs');
    await expect(actionsJobs('a/b', '11', { attempt: '3' }, api)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects unsafe numeric identifiers', () => {
    for (const value of ['0', '-1', '1/2', '1e3', '9007199254740992']) expect(() => actionsId(value)).toThrow();
  });
});
describe('scoped job logs and artifacts', () => {
  it('refuses a job from another run before downloading', async () => {
    const { api } = fake(() => ({ run_id: 99 }));
    await expect(actionsJobLogs('a/b', '11', '7', api)).rejects.toMatchObject({ status: 404 });
  });
  it('distinguishes not-ready and skipped logs', async () => {
    const { api } = fake(() => ({ run_id: 11, status: 'in_progress' }));
    expect(await actionsJobLogs('a/b', '11', '7', api)).toMatchObject({ state: 'not_ready' });
    const skipped = fake(() => ({ run_id: 11, status: 'completed', conclusion: 'skipped' }));
    expect(await actionsJobLogs('a/b', '11', '7', skipped.api)).toMatchObject({ state: 'unavailable' });
  });
  it('rejects foreign, expired, and oversized artifacts without fetching downloads', async () => {
    for (const [data, status] of [[{ workflow_run: { id: 99 } }, 404], [{ workflow_run: { id: 11 }, expired: true }, 410],
      [{ workflow_run: { id: 11 }, expired: false, size_in_bytes: 100000000 }, 413]] as const) {
      await expect(actionsArtifactDownload('a/b', '11', '3', fake(() => data).api)).rejects.toMatchObject({ status });
    }
  });
  it('removes terminal control sequences but preserves plain text and line breaks', () => {
    expect(cleanActionsLog('\u001b[31mFailure\u001b[0m\nhello\u0000\tworld')).toBe('Failure\nhello\tworld');
  });
});
describe('authenticated Actions downloads', () => {
  it('uses the token only for the initial GitHub API request', async () => {
    const fetcher = vi.fn(async () => new Response('output'));
    fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://production.blob.core.windows.net/log?sig=private' } }));
    const result = await actionsDownload('/repos/a/b/actions/jobs/7/logs', 20, true, Promise.resolve('secret'), fetcher);
    expect(result.bytes.toString()).toBe('output');
    expect((fetcher.mock.calls as unknown as Array<[URL, RequestInit]>)[0][1].headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect((fetcher.mock.calls as unknown as Array<[URL, RequestInit]>)[1][1].headers).toEqual({});
  });
  it('rejects untrusted redirects before sending a second request', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(actionsDownload('/repos/a/b/actions/jobs/7/logs', 20, true, Promise.resolve('secret'), fetcher)).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const url of ['https://evil.com', 'https://api.github.com.evil.com', 'https://u:p@api.github.com', 'file:///tmp/a']) expect(trustedActionsDownload(new URL(url))).toBe(false);
  });
  it('truncates oversized logs and refuses oversized archives', async () => {
    const fetcher = vi.fn(async () => new Response('123456789'));
    expect(await actionsDownload('/repos/a/b/actions/jobs/7/logs', 5, true, Promise.resolve('t'), fetcher)).toMatchObject({ truncated: true, bytes: Buffer.from('12345') });
    await expect(actionsDownload('/repos/a/b/actions/artifacts/3/zip', 5, false, Promise.resolve('t'), fetcher)).rejects.toMatchObject({ status: 413 });
  });
});
