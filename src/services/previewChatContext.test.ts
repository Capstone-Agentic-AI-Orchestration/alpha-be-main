import { beforeEach, describe, expect, it, vi } from 'vitest';
const evidence = vi.hoisted(() => vi.fn());
vi.mock('./localPreviewService.js', () => ({ localPreviewService: { chatEvidence: evidence } }));
import { previewChatContext } from './previewChatContext.js';
const context = { workspaceId: 'workspace', userId: 'alice', role: 'dev' } as any;
const ordinary = [{ name: 'site', repo: 'acme/site', dir: '/ordinary' }];
const preview = [{ name: 'site', repo: 'acme/site', dir: '/preview' }];
beforeEach(() => { evidence.mockReset(); });
describe('preview source and evidence for chat', () => {
  it('uses the exact running preview copy for a runtime investigation, preserving repository scope', async () => {
    evidence.mockResolvedValue({ roots: preview, text: 'commit abc: runtime failed', sourceKey: 'preview:abc' });
    expect(await previewChatContext(context, 'thread', 'Inspect the browser white screen', ordinary, ['acme/site'])).toEqual({ roots: preview, text: 'commit abc: runtime failed', sourceKey: 'preview:abc' });
    expect(evidence).toHaveBeenCalledWith(context, 'thread', ['acme/site']);
  });
  it('supplies runtime evidence without replacing the checkout for unrelated questions', async () => {
    evidence.mockResolvedValue({ roots: preview, text: 'runtime evidence', sourceKey: 'preview:abc' });
    expect(await previewChatContext(context, 'thread', 'Explain the repository API', ordinary)).toEqual({ roots: ordinary, text: 'runtime evidence', sourceKey: '' });
  });
  it('does not silently use the ordinary checkout when preview evidence cannot be authorized', async () => {
    evidence.mockRejectedValue(new Error('access denied'));
    const result = await previewChatContext(context, 'other', 'Check npm run dev', ordinary);
    expect(result.roots).toEqual([]); expect(result.text).toContain('unavailable');
  });
  it('has no preview access without a trusted request context', async () => {
    expect((await previewChatContext(undefined, 'thread', 'Check preview', ordinary)).roots).toEqual(ordinary);
    expect(evidence).not.toHaveBeenCalled();
  });
  it('keeps normal repository access for a browser question when no preview has existed', async () => {
    evidence.mockResolvedValue({ roots: [], text: 'No recorded preview', sourceKey: '' });
    expect((await previewChatContext(context, 'thread', 'Explain browser entry points', ordinary)).roots).toEqual(ordinary);
  });
});
