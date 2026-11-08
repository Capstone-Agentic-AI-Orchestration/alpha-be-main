import { describe, expect, it, vi } from 'vitest';
import { DeliveryGithub, type DeliveryPull } from './orchestrationDeliveryGithub.js';
import { GitHubApiError, type GitHubApi } from './githubApi.js';
import { deliverySmokeUrl } from './orchestrationDeliveryHosting.js';

function apiFixture() {
  let checks: any[] = [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', app: { id: 10 } }];
  let statuses: any[] = [];
  let required: any[] = [{ context: 'CI', app_id: 10 }];
  const api = {
    get: vi.fn(async (path: string): Promise<any> => {
      if (path.includes('/rules/branches/')) return [];
      if (path.endsWith('/protection')) return { required_status_checks: { checks: required, strict: true }, enforce_admins: { enabled: true } };
      if (path.includes('/check-runs?')) return { total_count: checks.length, check_runs: checks };
      throw new Error(`Unexpected read: ${path}`);
    }), getAll: vi.fn(async () => statuses), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn()
  };
  const github = new DeliveryGithub(api as unknown as GitHubApi);
  return { api, github, setChecks(value: any[]) { checks = value; }, setStatuses(value: any[]) { statuses = value; }, setRequired(value: any[]) { required = value; } };
}
describe('delivery GitHub evidence', () => {
  it('reads GitHub check-run envelopes rather than assuming a plain list', async () => {
    const f = apiFixture();
    expect((await f.github.checks('acme/shop', 'a'.repeat(40), 'dev')).state).toBe('passed');
    expect(f.api.get).toHaveBeenCalledWith(expect.stringContaining('/check-runs?filter=latest&per_page=100&page=1'));
  });
  it('will not accept a same-name check from a different app', async () => {
    const f = apiFixture(); f.setChecks([{ name: 'CI', status: 'completed', conclusion: 'success', app: { id: 99 } }]);
    f.setStatuses([{ context: 'CI', state: 'success' }]);
    expect((await f.github.checks('acme/shop', 'a', 'dev')).state).toBe('pending');
  });
  it.each(['skipped', 'neutral', 'cancelled', 'timed_out', 'failure'])('does not accept %s as a passing check', async conclusion => {
    const f = apiFixture(); f.setChecks([{ name: 'CI', status: 'completed', conclusion, app: { id: 10 } }]);
    expect((await f.github.checks('acme/shop', 'a', 'dev')).state).toBe('failed');
  });
  it('blocks missing policy instead of treating no checks as green', async () => {
    const f = apiFixture(); f.setRequired([]);
    await expect(f.github.checks('acme/shop', 'a', 'dev')).rejects.toThrow(/no required CI checks/);
  });
  it('requires strict checks on dev to close the base-advance race', async () => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => path.endsWith('/protection') ?
      { required_status_checks: { checks: [{ context: 'CI', app_id: 10 }], strict: false }, enforce_admins: { enabled: true } } : original(path));
    await expect(f.github.required('acme/shop', 'dev')).rejects.toThrow(/strict required checks/);
  });
  it('accepts non-strict checks on uat, which a merge-commit promotion can never keep up to date', async () => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => path.endsWith('/protection') ?
      { required_status_checks: { checks: [{ context: 'CI', app_id: 10 }], strict: false }, enforce_admins: { enabled: true } } : original(path));
    expect((await f.github.checks('acme/shop', 'a', 'uat')).state).toBe('passed');
  });
  it('still refuses non-strict uat checks that administrators can bypass', async () => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => path.endsWith('/protection') ?
      { required_status_checks: { checks: [{ context: 'CI', app_id: 10 }], strict: false }, enforce_admins: { enabled: false } } : original(path));
    await expect(f.github.required('acme/shop', 'uat')).rejects.toThrow(/administrators/);
  });
  it('refuses a policy whose strict checks can be bypassed by an administrator', async () => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => path.endsWith('/protection') ?
      { required_status_checks: { checks: [{ context: 'CI' }], strict: true }, enforce_admins: { enabled: false } } : original(path));
    await expect(f.github.required('acme/shop', 'uat')).rejects.toThrow(/administrators/);
  });
  it.each([undefined, [{ actor_type: 'RepositoryRole', actor_id: 5 }]])('does not assume an unavailable or populated ruleset bypass list is empty', async bypass => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => {
      if (path.includes('/rules/branches/')) return [{ type: 'required_status_checks', ruleset_id: 7,
        parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI', integration_id: 10 }] } }];
      if (path.includes('/rulesets/7')) return { enforcement: 'active', bypass_actors: bypass };
      if (path.endsWith('/protection')) throw new GitHubApiError('not protected', 404);
      return original(path);
    });
    await expect(f.github.required('acme/shop', 'uat')).rejects.toThrow(/administrators/);
  });
  it('accepts an active strict ruleset with a verified empty bypass list', async () => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => {
      if (path.includes('/rules/branches/')) return [{ type: 'required_status_checks', ruleset_id: 7,
        parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI', integration_id: 10 }] } }];
      if (path.includes('/rulesets/7')) return { enforcement: 'active', bypass_actors: [] };
      if (path.endsWith('/protection')) throw new GitHubApiError('not protected', 404);
      return original(path);
    });
    expect((await f.github.checks('acme/shop', 'a', 'uat')).state).toBe('passed');
  });
  it('preserves ruleset app binding when legacy protection only names a context', async () => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => path.includes('/rules/branches/') ?
      [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI', integration_id: 10 }] } }] : original(path));
    f.setRequired([{ context: 'CI' }]); f.setChecks([{ name: 'CI', status: 'completed', conclusion: 'success', app: { id: 99 } }]);
    expect((await f.github.checks('acme/shop', 'a', 'uat')).state).toBe('pending');
  });
  it('does not convert a permissions error into an empty passing policy', async () => {
    const f = apiFixture(); f.api.get.mockRejectedValue(new GitHubApiError('forbidden', 403));
    await expect(f.github.required('acme/shop', 'uat')).rejects.toMatchObject({ status: 403 });
  });
  it('uses the latest legacy status, not a previous success', async () => {
    const f = apiFixture(); f.setChecks([]); f.setRequired([{ context: 'CI' }]);
    f.setStatuses([{ context: 'CI', state: 'failure' }, { context: 'CI', state: 'success' }]);
    expect((await f.github.checks('acme/shop', 'a', 'dev')).state).toBe('failed');
  });
  it('lets the current synthetic merge check replace an earlier source result', async () => {
    const f = apiFixture(); const original = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async path => path.includes('/commits/merge/check-runs') ?
      { total_count: 1, check_runs: [{ name: 'CI', status: 'completed', conclusion: 'failure', app: { id: 10 } }] } : original(path));
    expect((await f.github.checks('acme/shop', 'head', 'dev', 'merge')).state).toBe('failed');
  });
  it('guards merges with current source/base evidence and the GitHub SHA precondition', async () => {
    const f = apiFixture();
    const pull = { number: 7, state: 'open', merged: false, mergeable: true, head: { sha: 'head' }, base: { sha: 'base' } } as DeliveryPull;
    f.api.get.mockResolvedValue(pull); f.api.put.mockResolvedValue({ merged: true, sha: 'merged' });
    await expect(f.github.merge('acme/shop', pull, 'head', 'base')).resolves.toBe('merged');
    expect(f.api.put).toHaveBeenCalledWith('/repos/acme/shop/pulls/7/merge', { sha: 'head', merge_method: 'merge' });
    f.api.get.mockResolvedValue({ ...pull, base: { sha: 'changed' } });
    await expect(f.github.merge('acme/shop', pull, 'head', 'base')).rejects.toThrow(/changed/);
    expect(f.api.put).toHaveBeenCalledTimes(1);
  });
  it('blocks workflow changes including renamed workflow files', async () => {
    const f = apiFixture(); f.api.getAll.mockResolvedValue([{ filename: 'copied.yml', previous_filename: '.github/workflows/ci.yml' }]);
    await expect(f.github.assertScope('acme/shop', 1)).rejects.toThrow(/changes workflows/);
  });
  it.each(['http://shop.vercel.app', 'https://localhost', 'https://127.0.0.1', 'https://shop.vercel.app.evil.test', 'https://person:password@shop.vercel.app', 'https://shop.vercel.app:444'])('refuses unsafe smoke target %s', value => {
    expect(() => deliverySmokeUrl(value, false)).toThrow();
  });
  it('restricts smoke paths to the provider root and backend health', () => {
    expect(deliverySmokeUrl('shop.vercel.app/path?secret=x', false).href).toBe('https://shop.vercel.app/');
    expect(deliverySmokeUrl('https://shop.onrender.com/other', true).href).toBe('https://shop.onrender.com/health');
  });
});
