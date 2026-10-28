import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn(), start: vi.fn(), resolve: vi.fn(), save: vi.fn(), emit: vi.fn() }));
vi.mock('./localPreviewService.js', () => ({ localPreviewService: mocks, redactPreviewLog: (text: string) => text }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { saveLocalPreview: mocks.save } }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { resolve: mocks.resolve } }));
import { prepareAcceptedWebsitePreview } from './acceptedWebsitePreview.js';
const context = { workspaceId: 'ws', userId: 'alice' };
const snapshot = () => ({ run: { id: 'run', workspaceId: 'ws', projectId: 'project', createdBy: 'alice', originChatThreadId: 'thread', repository: 'acme/site', status: 'executing' },
  tasks: [{ id: 'ui', kind: 'frontend', status: 'accepted', repository: 'acme/site' }],
  attempts: [{ taskId: 'ui', status: 'accepted', resultCommit: 'a'.repeat(40), result: { acceptanceEvidence: { changedPaths: ['src/App.tsx'] } } }] }) as any;
beforeEach(() => { vi.clearAllMocks(); mocks.resolve.mockResolvedValue(context); mocks.list.mockResolvedValue([]); mocks.start.mockResolvedValue({ state: 'starting' }); });
describe('accepted website preview handoff', () => {
  it('selects the accepted frontend repository and exact commit', async () => {
    await prepareAcceptedWebsitePreview(snapshot(), 'ui');
    expect(mocks.start).toHaveBeenCalledWith(context, 'thread', 'acme/site', `run:ui:${'a'.repeat(40)}`, { runId: 'run', taskId: 'ui', commit: 'a'.repeat(40) });
  });
  it.each(['backend', 'audit', 'validation'])('does not launch for %s work', async kind => {
    const value = snapshot(); value.tasks[0].kind = kind; await prepareAcceptedWebsitePreview(value, 'ui'); expect(mocks.start).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'failed', 'awaiting_plan_approval', 'recovery_required'])('does not launch in %s state', async status => {
    const value = snapshot(); value.run.status = status; await prepareAcceptedWebsitePreview(value, 'ui'); expect(mocks.start).not.toHaveBeenCalled();
  });
  it('does not reopen a stopped preview on duplicate acceptance delivery', async () => {
    mocks.list.mockResolvedValue([{ messageId: `run:ui:${'a'.repeat(40)}`, state: 'stopped' }]);
    await prepareAcceptedWebsitePreview(snapshot(), 'ui'); expect(mocks.start).not.toHaveBeenCalled();
  });
  it('keeps startup failures as readable preview evidence without failing task acceptance', async () => {
    mocks.start.mockRejectedValue(new Error('No supported web script'));
    await prepareAcceptedWebsitePreview(snapshot(), 'ui');
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/site', commit: 'a'.repeat(40), state: 'failed', error: 'No supported web script' }));
    expect(mocks.emit).toHaveBeenCalledWith('status', expect.objectContaining({ state: 'failed' }));
  });
});
