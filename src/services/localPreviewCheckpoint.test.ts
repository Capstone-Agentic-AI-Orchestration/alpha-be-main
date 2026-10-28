import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const mocks = vi.hoisted(() => ({ root: '', snapshot: {} as any, rows: [] as any[] }));
vi.mock('./sqliteService.js', () => ({ sqliteService: {
  getOrchestrationSnapshot: () => mocks.snapshot, isPathAllowed: () => true,
  saveLocalPreview: (row: any) => { mocks.rows.push({ ...row }); }, listLocalPreviews: () => []
} }));
vi.mock('./workspaceService.js', () => ({
  ensureWorkspacesRoot: () => mocks.root, resolveProjectWorkspace: () => null, allowAttachedWorkspace: () => {}
}));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { can: () => true, canAccessProject: () => true } }));
vi.mock('../store/stores.js', () => ({ chatStore: () => ({ listThreads: async () => [{ id: 'thread', projectId: 'project' }] }),
  projectStore: () => ({ get: async () => ({ id: 'project', resources: [{ type: 'github_repo', pathOrUrl: 'https://github.com/acme/site' }] }) }) }));
import { LocalPreviewService, localPreviewService } from './localPreviewService.js';
const context = { workspaceId: 'ws', userId: 'alice', role: 'dev' } as any;
let service: LocalPreviewService;
let commit: string;
let launch: ReturnType<typeof vi.spyOn>;
const git = (...args: string[]) => execFileSync('git', args, { cwd: mocks.root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-preview-checkpoint-')); mocks.rows = [];
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(mocks.root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } })); git('add', '.'); git('commit', '-m', 'accepted'); commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(mocks.root, 'later.txt'), 'later work'); git('add', '.'); git('commit', '-m', 'later');
  mocks.snapshot = { run: { id: 'run', workspaceId: 'ws', projectId: 'project', originChatThreadId: 'thread', repository: 'acme/site', status: 'executing',
    repositoryWorkspaces: [{ repository: 'acme/site', worktreePath: mocks.root, branchName: 'alpha/test' }] },
    tasks: [{ id: 'ui', kind: 'frontend', status: 'accepted' }], attempts: [{ taskId: 'ui', status: 'accepted', resultCommit: commit }] };
  service = new LocalPreviewService(); launch = vi.spyOn(service as any, 'launch').mockResolvedValue(undefined);
});
afterEach(async () => { await service.shutdown(); await localPreviewService.shutdown(); vi.restoreAllMocks(); fs.rmSync(mocks.root, { recursive: true, force: true }); });
describe('preview checkpoint selection', () => {
  it('serves the accepted commit even when the worktree HEAD has advanced', async () => {
    const record = await service.start(context, 'thread', 'acme/site', 'message', { runId: 'run', taskId: 'ui', commit });
    expect(record.commit).toBe(commit); expect(record.commit).not.toBe(git('rev-parse', 'HEAD'));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({ commit }) }), mocks.root);
  });
  it.each(['wrong-thread', 'wrong-commit', 'cancelled'])('rejects invalid checkpoint scope: %s', async kind => {
    if (kind === 'wrong-thread') mocks.snapshot.run.originChatThreadId = 'other';
    if (kind === 'wrong-commit') mocks.snapshot.attempts[0].resultCommit = 'b'.repeat(40);
    if (kind === 'cancelled') mocks.snapshot.run.status = 'cancelled';
    await expect(service.start(context, 'thread', 'acme/site', 'message', { runId: 'run', taskId: 'ui', commit })).rejects.toThrow('not an accepted');
    expect(launch).not.toHaveBeenCalled();
  });
});
