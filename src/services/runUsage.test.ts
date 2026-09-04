import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StreamParser } from './streamParser.js';
import { mergeUsage, totalTokens, hasUsage } from './runUsage.js';
import { RunUsage } from '../models/index.js';

/**
 * Token accounting.
 *
 * Every parser has decoded token counts since it was written, and every run
 * discarded them: there were no columns to put them in, so Alpha could not say
 * what a run cost while the agent cards displayed a hardcoded 620,000 tokens
 * for every agent. These tests pin the two properties that make the stored
 * figures trustworthy — nothing is invented, and nothing is double-counted.
 */

const fixture = (name: string) => path.resolve(process.cwd(), 'fixtures', name);

function replay(file: string, family: 'claude' | 'antigravity' | 'codex'): RunUsage | undefined {
  const parser = new StreamParser(family);
  let usage: RunUsage | undefined;

  for (const line of fs.readFileSync(fixture(file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    for (const ev of parser.parseLine(line)) {
      if (ev.type === 'result' && ev.telemetry) usage = mergeUsage(usage, ev.telemetry);
    }
  }

  return usage;
}

describe('mergeUsage — accumulation', () => {
  it('sums across result events rather than keeping the last', () => {
    // `codex exec` emits turn.completed once per turn. Last-writer-wins would
    // report a three-turn run as though it had done one turn's work.
    const first = mergeUsage(undefined, { inputTokens: 100, outputTokens: 10 });
    const second = mergeUsage(first, { inputTokens: 250, outputTokens: 40 });

    expect(second.inputTokens).toBe(350);
    expect(second.outputTokens).toBe(50);
  });

  it('leaves a field absent when neither side reported it', () => {
    // The distinction the nullable columns exist to preserve: codex reports no
    // cache figures at all, and "not measured" must not render as zero.
    const usage = mergeUsage(undefined, { inputTokens: 100 });

    expect(usage.cacheReadTokens).toBeUndefined();
    expect('cacheReadTokens' in usage).toBe(false);
  });

  it('keeps a reported zero as a zero', () => {
    const usage = mergeUsage(undefined, { inputTokens: 0, outputTokens: 12 });

    expect(usage.inputTokens).toBe(0);
    expect('inputTokens' in usage).toBe(true);
  });

  it('ignores non-finite values instead of poisoning the total', () => {
    const usage = mergeUsage({ inputTokens: 40 }, { inputTokens: NaN });
    expect(usage.inputTokens).toBe(40);
  });

  it('does not mutate the accumulator it was given', () => {
    const base: RunUsage = { inputTokens: 10 };
    mergeUsage(base, { inputTokens: 90 });
    expect(base.inputTokens).toBe(10);
  });
});

describe('totalTokens', () => {
  it('counts cache reads', () => {
    // The measured Claude turn billed 4 fresh input tokens against 68,492 read
    // from cache. Excluding cache would report that turn as having used four.
    expect(totalTokens({ inputTokens: 4, outputTokens: 368, cacheReadTokens: 68492 })).toBe(68864);
  });

  it('is undefined when nothing was reported', () => {
    expect(totalTokens(undefined)).toBeUndefined();
    expect(totalTokens({ costUsd: 0.5 })).toBeUndefined();
  });

  it('is zero — not undefined — when a CLI reported zeroes', () => {
    expect(totalTokens({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe('hasUsage', () => {
  it('rejects an empty accumulator so nothing writes an all-NULL row', () => {
    expect(hasUsage(undefined)).toBe(false);
    expect(hasUsage({})).toBe(false);
    expect(hasUsage({ costUsd: 0 })).toBe(true);
  });
});

describe('real transcripts', () => {
  /**
   * The figures below are read off the committed fixtures. They are the
   * evidence for the claim that Alpha's own persona and memory injection —
   * about 165 tokens — is roughly one percent of a turn, and that optimising
   * it would be optimising the wrong thing.
   */
  it('recovers the Claude turn, cache included', () => {
    const usage = replay('claude-stream-sample.jsonl', 'claude');

    expect(usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 368,
      cacheReadTokens: 68492,
      cacheCreationTokens: 70747
    });
    expect(usage?.costUsd).toBeCloseTo(0.750936, 6);
  });

  it('recovers Antigravity cache and thinking tokens', () => {
    // Both were being dropped: agy spells the key `cache_read_tokens`, not
    // Claude's `cache_read_input_tokens`, and is the only family that reports
    // reasoning separately. The tool sample read 8130 tokens from cache
    // against 5650 fresh — more than half the turn went missing.
    const usage = replay('antigravity-tool-sample.jsonl', 'antigravity');

    expect(usage).toMatchObject({
      inputTokens: 5650,
      outputTokens: 560,
      cacheReadTokens: 8130,
      thinkingTokens: 481
    });
  });

  it('reports no cost for Antigravity, because Antigravity reports none', () => {
    expect(replay('antigravity-tool-sample.jsonl', 'antigravity')?.costUsd).toBeUndefined();
  });

  it('records nothing for a codex turn that failed before completing', () => {
    // This fixture is a turn.failed — the model was rejected for the account.
    // A failed turn that never reported usage must stay unmeasured rather than
    // claiming it cost zero.
    expect(replay('codex-stream-sample.jsonl', 'codex')).toBeUndefined();
  });
});
