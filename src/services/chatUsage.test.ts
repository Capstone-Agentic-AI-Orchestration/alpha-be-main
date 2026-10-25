import { describe, expect, it, vi } from 'vitest';
vi.mock('./sqliteService.js', () => ({ sqliteService: { saveChatUsage: vi.fn(), getAgentCall: () => ({ messageId: 'request' }) } }));
import { normalizeTokens, UsageAccumulator, startUsage, currentUsageEntries, type UsageEntry } from './chatUsage.js';
import { StreamParser } from './streamParser.js';
import { sqliteService } from './sqliteService.js';

describe('conversation usage accounting', () => {
  it('counts Codex cached input only once and ignores invalid numbers without manufacturing zero', () => {
    expect(normalizeTokens('codex', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 })).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, totalTokens: 120 });
    expect(normalizeTokens('claude', { inputTokens: -1, outputTokens: NaN })).toEqual({});
    expect(normalizeTokens('claude', { outputTokens: 0 })).toEqual({ outputTokens: 0, totalTokens: 0 });
    expect(normalizeTokens('claude', { inputTokens: 5, outputTokens: 20, thinkingTokens: 15, cacheReadTokens: 30, cacheCreationTokens: 10 }).totalTokens).toBe(65);
    expect(normalizeTokens('antigravity', { inputTokens: 5, outputTokens: 20, thinkingTokens: 15, cacheReadTokens: 30 }).totalTokens).toBe(70);
  });

  it('reconciles Claude message starts, cumulative output, repeated assistant envelopes and final totals', () => {
    const parser = new StreamParser('claude');
    const acc = new UsageAccumulator('claude');
    const feed = (event: unknown) => { parser.parseLine(JSON.stringify(event)).forEach(parsed => acc.accept(parsed)); return acc.snapshot(); };
    expect(feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 0 } } } }).totalTokens).toBe(60);
    feed({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 4 } } });
    feed({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 8 } } });
    expect(feed({ type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 8 } } }).totalTokens).toBe(68);
    expect(feed({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 4 } } }).totalTokens).toBe(68);
    const final = { type: 'result', usage: { input_tokens: 25, cache_read_input_tokens: 100, output_tokens: 16 } };
    expect(feed(final).totalTokens).toBe(141);
    expect(feed(final).totalTokens).toBe(141);
  });

  it('adds distinct Codex turns while replacing a replayed final event', () => {
    const parser = new StreamParser('codex');
    const acc = new UsageAccumulator('codex');
    const feed = (event: unknown) => parser.parseLine(JSON.stringify(event)).forEach(parsed => acc.accept(parsed));
    feed({ type: 'turn.started' });
    const end = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } };
    feed(end); feed(end);
    expect(acc.snapshot().totalTokens).toBe(110);
    feed({ type: 'turn.started' }); feed(end);
    expect(acc.snapshot().totalTokens).toBe(220);
    // A resumed CLI invocation starts its own accounting, not the old session's sum.
    expect(new UsageAccumulator('codex').snapshot()).toEqual({});
  });

  it('records physical attempts separately and closes work on cancellation without erasing its usage', () => {
    const first = startUsage({ threadId: 't1', callId: 'c1' }, 'codex', 'test')!;
    first.accept({ type: 'result', telemetry: { inputTokens: 100, outputTokens: 20 } });
    first.finish('stopped'); first.finish();
    const rows = vi.mocked(sqliteService.saveChatUsage).mock.calls;
    expect(rows.at(-1)?.[0]).toMatchObject({ threadId: 't1', messageId: 'request', status: 'stopped', usage: { totalTokens: 120 } });
    const oldId = rows.at(-1)![0].id;
    const retry = startUsage({ threadId: 't1' }, 'codex')!;
    expect(rows.at(-1)![0].id).not.toBe(oldId);
    retry.finish();
  });

  it('coalesces rapid provider updates and flushes the latest count on exit', () => {
    vi.useFakeTimers();
    try {
      const before = vi.mocked(sqliteService.saveChatUsage).mock.calls.length;
      const recording = startUsage({ threadId: 'burst' }, 'claude')!;
      for (let outputTokens = 1; outputTokens <= 100; outputTokens++) recording.accept({ type: 'usage', streamKey: 'message', telemetry: { inputTokens: 10, outputTokens } });
      expect(vi.mocked(sqliteService.saveChatUsage).mock.calls.length - before).toBe(1);
      vi.advanceTimersByTime(250);
      expect(vi.mocked(sqliteService.saveChatUsage).mock.calls.at(-1)?.[0].usage.totalTokens).toBe(110);
      recording.finish();
      expect(vi.mocked(sqliteService.saveChatUsage).mock.calls.at(-1)?.[0].status).toBe('completed');
    } finally { vi.useRealTimers(); }
  });

  it('does not revive an orphaned process after a daemon restart', () => {
    const entry = { id: 'old-daemon', status: 'running', startedAt: '2026-10-25T01:00:00Z', updatedAt: '2026-10-25T01:00:20Z', usage: { totalTokens: 120 } } as UsageEntry;
    expect(currentUsageEntries([entry])[0]).toMatchObject({ status: 'interrupted', endedAt: entry.updatedAt, usage: { totalTokens: 120 } });
    expect(entry.status).toBe('running');
  });
});
