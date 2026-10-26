import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordBoardSyncMetric, type BoardSyncMetric } from './boardSyncMetrics.js';

afterEach(() => vi.restoreAllMocks());

describe('board sync aggregate metrics', () => {
  it('logs only aggregate fields, even if extra row data is supplied', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    recordBoardSyncMetric({
      workspaceId: 'workspace-secret-id',
      clientVersion: 'desktop-2.0.67',
      kind: 'snapshot',
      changedRows: 4,
      responseBytes: 1638,
      rowKey: { id: 'project-secret-id' },
      row: { name: 'ROW_BODY_SECRET', content: 'COMMENT_BODY_SECRET' }
    } as BoardSyncMetric);

    expect(info).toHaveBeenCalledOnce();
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      event: 'board_sync_metric',
      workspaceId: 'workspace-secret-id',
      clientVersion: 'desktop-2.0.67',
      kind: 'snapshot',
      changedRows: 4,
      responseBytes: 1638
    });
    expect(String(info.mock.calls[0][0])).not.toMatch(/project-secret-id|ROW_BODY_SECRET|COMMENT_BODY_SECRET/);
  });

  it('ignores unsupported response kinds and never lets a broken logger interrupt a response', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('logger unavailable');
    });

    expect(() => recordBoardSyncMetric({
      workspaceId: 'workspace', clientVersion: 'web-0.1.0', kind: 'other', changedRows: 1, responseBytes: 8
    } as unknown as BoardSyncMetric)).not.toThrow();
    expect(() => recordBoardSyncMetric({
      workspaceId: 'workspace', clientVersion: 'web-0.1.0', kind: 'delta', changedRows: 1, responseBytes: 8
    })).not.toThrow();
    expect(info).toHaveBeenCalledOnce();
  });
});
