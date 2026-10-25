import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rows: [] as any[], threads: [] as any[], can: true, project: { id: 'project', name: 'Website', resources: [{ type: 'github_repo', pathOrUrl: 'https://github.com/acme/site' }] } }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { listLocalPreviews: () => mocks.rows.map(row => ({ ...row })), saveLocalPreview: (row: any) => { const index = mocks.rows.findIndex(item => item.id === row.id); if (index >= 0) mocks.rows[index] = { ...row }; else mocks.rows.push({ ...row }); } } }));
vi.mock('../store/stores.js', () => ({ chatStore: () => ({ listThreads: async () => mocks.threads }), projectStore: () => ({ get: async () => mocks.project }) }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { can: () => mocks.can, canAccessProject: () => true } }));
import { localPreviewService, LocalPreviewService, previewAdapter, previewEnvironment, redactPreviewLog } from './localPreviewService.js';
import { parseAlphaRoute, orchestratorRoutingPrompt, isStopPreviewRequest } from './chatRouter.js';
const context = { workspaceId: 'workspace', userId: 'alice', role: 'dev' } as any;

describe('local preview admission and isolation', () => {
  beforeEach(() => { mocks.rows = []; mocks.threads = [{ id: 'thread', projectId: 'project' }]; mocks.can = true; });
  afterAll(async () => { await localPreviewService.shutdown(); });
  it('does not pass engine credentials, Node injection or Electron flags to project scripts', () => {
    const env = previewEnvironment({ PATH: 'bin', SystemRoot: 'system', GH_TOKEN: 'private', ALPHA_LOCAL_TOKEN: 'admin', SUPABASE_SERVICE_ROLE_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require injected', VITE_API_KEY: 'private' }, 5000);
    expect(env.PATH).toBe('bin'); expect(env.HOST).toBe('127.0.0.1'); expect(env.PORT).toBe('5000');
    for (const key of ['GH_TOKEN', 'ALPHA_LOCAL_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_API_KEY']) expect(env[key]).toBeUndefined();
  });
  it('accepts deterministic supported scripts and rejects shell/host overrides', () => {
    expect(previewAdapter({ scripts: { dev: 'vite' } })?.flags(1234)).toEqual(['--host', '127.0.0.1', '--port', '1234', '--strictPort']);
    expect(previewAdapter({ scripts: { dev: 'next dev' } })?.script).toBe('dev');
    for (const dev of ['vite --host 0.0.0.0', 'vite && curl example.com', 'node arbitrary.js', 'npm run dev']) expect(previewAdapter({ scripts: { dev } })).toBeUndefined();
  });
  it('refuses an unowned thread and execution-disabled roles before accessing a repository', async () => {
    mocks.threads = []; await expect(localPreviewService.start(context, 'other')).rejects.toThrow('accessible project');
    mocks.threads = [{ id: 'thread', projectId: 'project' }]; mocks.can = false;
    await expect(localPreviewService.start(context, 'thread')).rejects.toThrow('role cannot');
    mocks.can = true; await expect(localPreviewService.start(context, 'thread', 'other/secret')).rejects.toThrow('outside');
  });
  it('expires persisted ready flags after restart and never attaches an arbitrary old port', async () => {
    mocks.rows = [{ id: 'old', workspaceId: 'workspace', ownerId: 'alice', threadId: 'thread', state: 'ready', origin: 'http://127.0.0.1:5000' }];
    const restarted = new LocalPreviewService();
    expect((await restarted.list(context, 'thread'))[0]).toMatchObject({ state: 'stopped', origin: undefined });
    expect(restarted.resolveSurface('old', 'guessed')).toBeUndefined(); await restarted.shutdown();
  });
  it('redacts common tokens and credential assignments in startup output', () => {
    expect(redactPreviewLog('token=secret ghp_abcdef https://user:pass@example.com')).toBe('token=[redacted] [redacted] https://[redacted]@example.com');
  });
  it('routes a preview as existing-script execution instead of a code build', () => {
    expect(parseAlphaRoute('ALPHA_ROUTE {"route":"preview","repositories":["acme/site"]}').decision?.route).toBe('preview');
    expect(orchestratorRoutingPrompt({ canBuild: true, repositories: ['acme/site'] })).toContain('"route":"preview"');
  });
  it('recognizes explicit stop commands without mistaking build stops or quoted questions for controls', () => {
    for (const command of ['now stop the local run', 'please stop the preview', 'can you stop npm run dev?']) expect(isStopPreviewRequest(command)).toBe(true);
    for (const command of ['stop', 'stop the build', 'why did the preview stop?', 'do not stop the preview', 'stop the preview and delete the project']) expect(isStopPreviewRequest(command)).toBe(false);
    expect(parseAlphaRoute('ALPHA_ROUTE {"route":"stop_preview"}').decision?.route).toBe('stop_preview');
  });
  it('omits capabilities and unrelated repository evidence and rechecks access', async () => {
    mocks.rows = [{ id: 'old', projectId: 'project', repository: 'acme/site', commit: 'abc', branch: 'build', state: 'stopped', capability: 'private-capability', logs: 'token=private', createdAt: '2026-01-01' }];
    const evidence = await localPreviewService.chatEvidence(context, 'thread', ['acme/site']);
    expect(evidence.text).toContain('abc'); expect(evidence.text).toContain('[redacted]'); expect(evidence.text).not.toContain('private-capability');
    expect((await localPreviewService.chatEvidence(context, 'thread', ['other/repo'])).roots).toEqual([]);
    expect((await localPreviewService.chatEvidence(context, 'thread', ['other/repo'])).text).not.toContain('abc');
    mocks.threads = []; await expect(localPreviewService.chatEvidence(context, 'thread')).rejects.toThrow('accessible project');
  });
  it('bounds, deduplicates and redacts main-process runtime diagnostics and rejects invalid capabilities', () => {
    const item = { record: { id: 'live', capability: 'cap', state: 'ready', origin: 'http://127.0.0.1:1234', logs: '' }, touched: Date.now() };
    (localPreviewService as any).owned.set('live', item);
    localPreviewService.recordSurfaceDiagnostic('live', 'wrong', 'console', 'ignored');
    expect(item.record).not.toHaveProperty('browserDiagnostics');
    for (let index = 0; index < 40; index++) localPreviewService.recordSurfaceDiagnostic('live', 'cap', 'console', `error ${index}: token=private`);
    localPreviewService.recordSurfaceDiagnostic('live', 'cap', 'console', 'error 39: token=private');
    const events = (item.record as any).browserDiagnostics;
    expect(events).toHaveLength(30); expect(JSON.stringify(events)).not.toContain('private');
    (localPreviewService as any).owned.delete('live');
  });
  it('stops only the caller and conversation previews, including an in-flight start', async () => {
    const service = new LocalPreviewService();
    const owned = (service as any).owned as Map<string, any>;
    const stop = vi.spyOn(service as any, 'stopOwned').mockImplementation(async (item: any) => { owned.delete(item.record.id); });
    owned.set('other-owner', { record: { id: 'other-owner', workspaceId: 'workspace', ownerId: 'bob', threadId: 'thread' } });
    owned.set('other-thread', { record: { id: 'other-thread', workspaceId: 'workspace', ownerId: 'alice', threadId: 'elsewhere' } });
    owned.set('other-workspace', { record: { id: 'other-workspace', workspaceId: 'elsewhere', ownerId: 'alice', threadId: 'thread' } });
    let release!: () => void;
    const job = new Promise<void>(resolve => { release = resolve; }).then(() => { owned.set('starting', { record: { id: 'starting', workspaceId: 'workspace', ownerId: 'alice', threadId: 'thread' } }); });
    (service as any).pending.set(JSON.stringify(['workspace', 'alice', 'thread']), { job });
    const stopping = service.stopForThread(context, 'thread');
    await new Promise(resolve => setImmediate(resolve));
    release();
    expect(await stopping).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1); expect(owned.has('starting')).toBe(false); expect(owned.size).toBe(3);
    owned.clear(); await service.shutdown();
  });
});
