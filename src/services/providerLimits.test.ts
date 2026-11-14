import { describe, expect, it } from 'vitest';
import { antigravityUsageWindows, claudeUsageWindows, parseOpenCodeStats } from './providerLimits.js';

describe('provider usage parsers', () => {
  it('reads every Antigravity quota group, including separately limited models', () => {
    const windows = antigravityUsageWindows({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [
        { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.62, reset_time: '2026-11-21T08:54:20Z' },
        { id: 'gemini-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-14T13:54:20Z' }] },
      { name: 'Claude and GPT models', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0 }] },
      { name: 'Gemini 4 Argon', buckets: [{ id: 'argon', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 'n/a' }] }
    ] } } });
    expect(windows.map(window => [window.label, window.remainingPercent, window.usedPercent])).toEqual([
      ['Gemini Models · Weekly', 62, 38], ['Gemini Models · 5-hour window', 100, 0], ['Claude and GPT models · 5-hour window', 0, 100]
    ]);
    expect(windows[0].resetsAt).toBe('2026-11-21T08:54:20.000Z');
    expect(windows[2].resetsAt).toBeNull();
    expect(antigravityUsageWindows({ status: 'ERROR' })).toEqual([]);
  });

  it('reads Claude plan windows and model buckets, skipping windows without utilization', () => {
    const windows = claudeUsageWindows({
      five_hour: { utilization: 81.5, resets_at: '2026-11-14T15:00:00Z' },
      seven_day: { utilization: 140, resets_at: null },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: 'not a date' }]
    });
    expect(windows.map(window => [window.label, window.remainingPercent])).toEqual([
      ['5-hour window', 18.5], ['Weekly window', 0], ['Fable · Weekly', 88]
    ]);
    expect(windows[2].resetsAt).toBeNull();
    expect(claudeUsageWindows(null)).toEqual([]);
  });

  it('reads OpenCode spending from its stats table', () => {
    const table = '│Sessions                                             14 │\n│Total Cost                                     $1,204.50 │\n│Input                                           12.5K │\n│Output                                           3.1M │';
    expect(parseOpenCodeStats(table)).toEqual({ costUsd: 1204.5, sessions: 14, inputTokens: 12500, outputTokens: 3100000 });
    expect(parseOpenCodeStats('Error: database locked')).toBeNull();
  });
});
