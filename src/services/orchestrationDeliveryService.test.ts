import { describe, expect, it, vi } from 'vitest';
import { OrchestrationDeliveryService } from './orchestrationDeliveryService.js';
import { DeliveryError, type DeliveryRecord } from './orchestrationDelivery.js';
import type { DeliveryGithub, DeliveryPull } from './orchestrationDeliveryGithub.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { SQLiteService } from './sqliteService.js';
import type { WorkspaceContext } from './workspaceRegistry.js';

const sha = (char: string) => char.repeat(40);
const context = (role = 'pm') => ({ workspaceId: 'ws', userId: 'person', role }) as WorkspaceContext;
function fixture(repos = ['acme/shop']) {
  const snapshot = {
    run: { id: 'build', workspaceId: 'ws', projectId: 'project', createdBy: 'person', repository: repos[0],
      status: 'completed', repositoryWorkspaces: repos.map(repository => ({ repository })),
      plan: { goal: 'Fix cart totals' }, publications: repos.map((repository, index) => ({ repository,
        branchName: 'alpha/orchestration/build', baseBranch: 'dev', resultCommit: sha('a'), pullRequestUrl: `https://github.com/${repository}/pull/${index + 1}` })) },
    tasks: repos.flatMap((repository, index) => [
      { id: `code${index}`, kind: 'backend', ownerAgentId: `coder${index}`, status: 'accepted', repository },
      { id: `review${index}`, kind: 'review', ownerAgentId: 'security', status: 'accepted', repository },
      { id: `validate${index}`, kind: 'validation', ownerAgentId: 'validator', status: 'accepted', repository }
    ]),
    attempts: repos.flatMap((_, index) => ['code', 'review', 'validate'].map((kind, order) => ({ taskId: `${kind}${index}`, status: 'accepted',
      createdAt: `2026-10-29T00:00:0${order}.000Z`, completedAt: `2026-10-29T00:00:0${order}.000Z` }))), findings: [], artifacts: []
  } as unknown as OrchestrationSnapshot;
  let saved: DeliveryRecord | undefined;
  const store = {
    getOrchestrationSnapshot: () => snapshot,
    getOrchestrationDelivery: () => saved && structuredClone(saved),
    listAllOrchestrationDeliveries: () => saved ? [saved] : [],
    hasOrchestrationDeliveryAction: (_runId: string, action: string) => saved?.history.some(event => event.action === action) ?? false,
    saveOrchestrationDelivery: (record: DeliveryRecord, revision?: number) => {
      if (revision !== undefined && saved?.revision !== revision) throw new Error('stale');
      saved = structuredClone(record); return structuredClone(saved);
    }
  } as unknown as SQLiteService;
  const pulls = new Map<string, DeliveryPull>();
  const dev = new Map(repos.map(repo => [repo, sha('d')]));
  const uat = new Map(repos.map(repo => [repo, sha('u')]));
  repos.forEach((repo, index) => pulls.set(`${repo}:${index + 1}`, {
    number: index + 1, html_url: `https://github.com/${repo}/pull/${index + 1}`, state: 'open', merged: false, mergeable: true,
    merge_commit_sha: sha('m'), head: { sha: sha('a'), ref: 'alpha/orchestration/build', repo: { full_name: repo } },
    base: { sha: sha('d'), ref: 'dev', repo: { full_name: repo } }
  }));
  let state: 'passed' | 'pending' | 'failed' = 'passed';
  const github = {
    pull: vi.fn(async (repo: string, number: number) => structuredClone(pulls.get(`${repo}:${number}`)!)),
    branch: vi.fn(async (repo: string, branch: string) => (branch === 'dev' ? dev : uat).get(repo)!),
    required: vi.fn(async () => ['CI']),
    checks: vi.fn(async () => ({ required: ['CI'], checks: [{ name: 'CI', state }], state })),
    assertScope: vi.fn(async () => {}),
    merge: vi.fn(async (repo: string, pull: DeliveryPull) => {
      const stored = pulls.get(`${repo}:${pull.number}`)!;
      if (stored.merged) return stored.merge_commit_sha!;
      stored.merged = true; stored.state = 'closed'; stored.merge_commit_sha = pull.base.ref === 'uat' ? sha('f') : sha('e');
      (pull.base.ref === 'uat' ? uat : dev).set(repo, stored.merge_commit_sha);
      return stored.merge_commit_sha;
    }),
    prepareUat: vi.fn(async (repo: string) => {
      const pull = { number: 100, html_url: `https://github.com/${repo}/pull/100`, state: 'open', merged: false, mergeable: true,
        merge_commit_sha: sha('n'), head: { sha: dev.get(repo)!, ref: 'dev', repo: { full_name: repo } },
        base: { sha: uat.get(repo)!, ref: 'uat', repo: { full_name: repo } } };
      pulls.set(`${repo}:100`, pull); return structuredClone(pull);
    })
  };
  const verifier = vi.fn(async (target: DeliveryRecord['repositories'][0]) => ({ sha: target.uatHead!, url: 'https://shop.vercel.app/', status: 'READY', verifiedAt: 'now' }));
  const planner = vi.fn(async () => 'repair-build');
  const service = new OrchestrationDeliveryService(store, github as unknown as DeliveryGithub, verifier, planner);
  service.ensure(snapshot);
  const refresh = () => service.refresh('ws', 'build');
  const act = async (action: import('./orchestrationDelivery.js').DeliveryAction, role = 'pm', key: string = crypto.randomUUID()) => {
    const record = saved!;
    return service.act({ context: context(role), runId: 'build', projectId: 'project', expectedRevision: record.revision, action, key });
  };
  return { snapshot, store, service, github, pulls, dev, uat, verifier, planner, refresh, act,
    setState(value: typeof state) { state = value; }, record: () => saved! };
}

describe('delivery authority and lifecycle', () => {
  it('continues a published build through explicit dev/UAT approval and exact deployment verification', async () => {
    const f = fixture();
    expect((await f.refresh()).stage).toBe('dev_approval');
    expect(f.github.merge).not.toHaveBeenCalled();
    await f.act('merge_dev', 'dev');
    expect((await f.refresh()).stage).toBe('uat_prepare');
    await f.act('prepare_uat');
    expect((await f.refresh()).stage).toBe('uat_approval');
    await f.act('merge_uat');
    const ready = await f.refresh();
    expect(ready.stage).toBe('uat_ready');
    expect(ready.repositories[0].deployment?.sha).toBe(sha('f'));
    expect(ready.reason).toMatch(/PM review; client handoff remains separate/);
    expect(ready.history.filter(event => event.actorId === 'person').length).toBeGreaterThan(0);
  });
  /**
   * A frontend + backend build that changed only the frontend: the backend got a planning
   * task, no code, no review and no pull request. Delivery used to require review evidence for
   * it anyway and stayed blocked, so the frontend pull request could never be merged.
   */
  it('checks review evidence only for repositories that have a pull request', async () => {
    const f = fixture(['acme/shop']);
    const run = f.snapshot.run as unknown as { repositoryWorkspaces: Array<{ repository: string }> };
    run.repositoryWorkspaces.push({ repository: 'acme/api' });
    (f.snapshot.tasks as unknown as Array<Record<string, unknown>>).push({ id: 'plan-api', kind: 'analysis', ownerAgentId: 'architect', status: 'accepted', repository: 'acme/api' });
    expect((await f.refresh()).stage).toBe('dev_approval');
    await f.act('merge_dev', 'dev');
    expect(f.github.merge).toHaveBeenCalledTimes(1);
  });
  it('requires both codebases to reach verified UAT', async () => {
    const f = fixture(['acme/front', 'acme/back']);
    await f.refresh(); await f.act('merge_dev'); await f.refresh(); await f.act('prepare_uat'); await f.refresh(); await f.act('merge_uat');
    f.verifier.mockImplementation(async target => ({ sha: target.uatHead!, url: '', status: 'BUILDING', verifiedAt: undefined as any }));
    expect((await f.refresh()).stage).toBe('uat_deploying');
    expect(f.record().repositories).toHaveLength(2);
  });
  it.each(['client'])('refuses delivery control by %s', async role => {
    const f = fixture(); await f.refresh(); await f.act('merge_dev'); await f.refresh();
    await expect(f.act('prepare_uat', role)).rejects.toMatchObject({ status: 403 });
    expect(f.github.prepareUat).not.toHaveBeenCalled();
  });
  it('lets a developer enable delivery once and advance through UAT without PM/admin approval', async () => {
    const f = fixture(); await f.refresh();
    await f.act('enable_uat', 'dev');
    await f.service.advanceAuthorized(context('dev'), 'build');
    expect((await f.refresh()).stage).toBe('uat_prepare');
    await f.service.advanceAuthorized(context('dev'), 'build');
    expect((await f.refresh()).stage).toBe('uat_approval');
    await f.service.advanceAuthorized(context('dev'), 'build');
    expect((await f.refresh()).stage).toBe('uat_ready');
    expect(f.github.merge).toHaveBeenCalledTimes(2);
    expect(f.record().authorization?.actorId).toBe('person');
  });
  it('honors pause and resume without requiring a PM role', async () => {
    const f = fixture(); await f.refresh(); await f.act('enable_uat', 'dev'); await f.act('pause_delivery', 'dev');
    await f.service.advanceAuthorized(context('dev'), 'build'); expect(f.github.merge).not.toHaveBeenCalled();
    await f.act('resume_delivery', 'dev'); await f.service.advanceAuthorized(context('dev'), 'build');
    expect(f.github.merge).toHaveBeenCalledTimes(1);
  });
  it('does not use a different person’s grant or keep retrying failed actions indefinitely', async () => {
    const f = fixture(); await f.refresh(); await f.act('enable_uat', 'dev');
    await f.service.advanceAuthorized({ ...context('dev'), userId: 'other-person' }, 'build');
    expect(f.github.merge).not.toHaveBeenCalled();
    f.github.merge.mockRejectedValue(new Error('unavailable'));
    for (let i = 0; i < 3; i++) { await f.refresh(); await f.service.advanceAuthorized(context('dev'), 'build'); }
    expect(f.record().authorization?.paused).toBe(true);
    await f.service.advanceAuthorized(context('dev'), 'build');
    expect(f.github.merge).toHaveBeenCalledTimes(3);
  });
  it('refuses another project and a stale revision without touching GitHub', async () => {
    const f = fixture(); await f.refresh();
    await expect(f.service.act({ context: context(), runId: 'build', projectId: 'elsewhere', expectedRevision: 1, action: 'merge_dev', key: 'test-key-1' })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.act({ context: context(), runId: 'build', projectId: 'project', expectedRevision: 0, action: 'merge_dev', key: 'test-key-1' })).rejects.toThrow(/changed/);
    expect(f.github.merge).not.toHaveBeenCalled();
  });
  it('invalidates displayed approval when the dev base moves', async () => {
    const f = fixture(); await f.refresh();
    f.pulls.get('acme/shop:1')!.base.sha = sha('z');
    await expect(f.act('merge_dev')).rejects.toThrow(/commits changed/);
    expect(f.github.merge).not.toHaveBeenCalled();
  });
  it.each(['pending', 'failed'] as const)('never merges %s checks', async state => {
    const f = fixture(); f.setState(state); await f.refresh();
    await expect(f.act('merge_dev')).rejects.toThrow();
    expect(f.github.merge).not.toHaveBeenCalled();
  });
  it('treats missing policy and unavailable APIs as blockers, not success', async () => {
    const f = fixture(); f.github.checks.mockRejectedValueOnce(new DeliveryError('No required CI checks configured.'));
    expect(await f.refresh()).toMatchObject({ stage: 'blocked', reason: 'No required CI checks configured.' });
    f.github.pull.mockRejectedValueOnce(new Error('token=private-value'));
    const blocked = await f.refresh();
    expect(blocked.stage).toBe('blocked'); expect(JSON.stringify(blocked)).not.toContain('private-value');
  });
  it('requires independent accepted review and validation after the latest code checkpoint', async () => {
    const f = fixture(); f.snapshot.tasks[1].ownerAgentId = 'coder0';
    expect((await f.refresh()).stage).toBe('blocked');
    f.snapshot.tasks[1].ownerAgentId = 'security';
    f.snapshot.attempts[0].completedAt = '2026-10-30T00:00:00Z';
    expect((await f.refresh()).stage).toBe('blocked');
  });
  it('blocks changed heads and workflow edits', async () => {
    const f = fixture(); f.pulls.get('acme/shop:1')!.head.sha = sha('b');
    expect((await f.refresh()).reason).toMatch(/commit changed/);
    f.pulls.get('acme/shop:1')!.head.sha = sha('a');
    f.github.assertScope.mockRejectedValue(new DeliveryError('Workflow edits need separate review.'));
    expect((await f.refresh()).stage).toBe('blocked');
  });
  it('does not treat an already-published repair as permission to edit again', async () => {
    const f = fixture(); f.setState('failed'); await f.refresh();
    await f.act('prepare_repair');
    expect(f.planner).toHaveBeenCalledTimes(1);
    expect(f.record().repairRunId).toBe('repair-build');
    await f.act('prepare_repair');
    expect(f.planner).toHaveBeenCalledTimes(1);
    expect(f.github.merge).not.toHaveBeenCalled();
  });
  it('bounds repair plans across repeated requests', async () => {
    const f = fixture(); f.setState('failed'); await f.refresh();
    const record = f.record(); record.repairAttempts = 2; f.store.saveOrchestrationDelivery(record, record.revision);
    await expect(f.act('prepare_repair')).rejects.toThrow(/Two repair plans/);
    expect(f.planner).not.toHaveBeenCalled();
  });
  it('replays an action key without merging twice', async () => {
    const f = fixture(); await f.refresh();
    await f.act('merge_dev', 'pm', 'same-action'); await f.act('merge_dev', 'pm', 'same-action');
    expect(f.github.merge).toHaveBeenCalledTimes(1);
  });
  it('preflights all repositories before merging any', async () => {
    const f = fixture(['acme/front', 'acme/back']); await f.refresh();
    f.pulls.get('acme/back:2')!.mergeable = false;
    await expect(f.act('merge_dev')).rejects.toThrow(/mergeability/);
    expect(f.github.merge).not.toHaveBeenCalled();
  });
  it('reconciles a successful remote merge after a lost response', async () => {
    const f = fixture(); await f.refresh();
    const merge = f.github.merge.getMockImplementation()!;
    f.github.merge.mockImplementationOnce(async (...args) => { await merge(...args); throw new Error('network lost'); });
    await expect(f.act('merge_dev')).rejects.toThrow('network lost');
    expect((await f.refresh()).stage).toBe('uat_prepare');
    expect(f.github.merge).toHaveBeenCalledTimes(1);
  });
  it('blocks a deployment from the wrong SHA even if its provider reports ready', async () => {
    const f = fixture(); await f.refresh(); await f.act('merge_dev'); await f.refresh(); await f.act('prepare_uat'); await f.refresh(); await f.act('merge_uat');
    f.verifier.mockResolvedValue({ sha: sha('z'), url: 'https://shop.vercel.app', status: 'READY', verifiedAt: 'now' });
    expect((await f.refresh()).stage).toBe('uat_deploying');
  });
  it('keeps an advanced UAT branch from retaining a stale readiness claim', async () => {
    const f = fixture(); await f.refresh(); await f.act('merge_dev'); await f.refresh(); await f.act('prepare_uat'); await f.refresh(); await f.act('merge_uat'); await f.refresh();
    f.uat.set('acme/shop', sha('z'));
    expect((await f.refresh()).stage).toBe('blocked');
  });
});
