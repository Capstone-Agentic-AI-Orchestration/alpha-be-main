import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rows: [] as any[], owner: 'alice', save: vi.fn() }));
vi.mock('./sqliteService.js', () => ({ sqliteService: {
  getChatThreads: () => [{ id: 'thread', projectId: 'project', ownerId: mocks.owner }],
  getChatMessages: () => mocks.rows
} }));
vi.mock('./chatWriteThrough.js', () => ({ saveChatMessageAndShare: (row: any) => { mocks.save(row); mocks.rows.push(row); return row; } }));
import { recordPreviewChatStatus } from './previewChatStatus.js';
const record = { id: 'preview', workspaceId: 'ws', ownerId: 'alice', threadId: 'thread', projectId: 'project', commit: 'a'.repeat(40),
  messageId: 'origin-message', state: 'ready', capability: 'private-capability', logs: 'private process data', error: 'private startup error' } as any;
beforeEach(() => { mocks.rows = []; mocks.owner = 'alice'; mocks.save.mockClear(); });
describe('durable preview status messages', () => {
  it('records one observed outcome per state and leaves raw evidence in the right panel', () => {
    const ready = recordPreviewChatStatus(record);
    expect(ready?.content).toContain('ready on the right');
    expect(ready?.content).toContain('verification is separate');
    expect(JSON.stringify(ready)).not.toContain('private');
    expect(recordPreviewChatStatus(record)).toBeUndefined();
    const failed = recordPreviewChatStatus({ ...record, state: 'failed' });
    expect(failed?.content).toContain('encountered an error'); expect(failed?.content).not.toContain('private');
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it('does not publish into a deleted or differently owned conversation', () => {
    mocks.owner = 'bob'; expect(recordPreviewChatStatus(record)).toBeUndefined(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('reports observed browser errors once, without calling isolation blocks application errors', () => {
    const diagnostic = (kind: string, message: string) => ({ kind, message, timestamp: '' });
    recordPreviewChatStatus({ ...record, browserDiagnostics: [diagnostic('blocked', 'Preview isolation blocked resource')] });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const failure = { ...record, browserDiagnostics: [diagnostic('console', 'Error: Controlled browser failure')] };
    const message = recordPreviewChatStatus(failure);
    expect(message?.id).toBe('preview-preview-browser-errors');
    expect(message?.content).toContain('reported browser errors');
    recordPreviewChatStatus(failure); expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});
