import { RunUsage } from '../models/index.js';
import { RunTelemetry } from './streamParser.js';

/**
 * What a run actually cost, accumulated from the CLI's own `result` events.
 *
 * Every stream parser already decodes token counts — `RunTelemetry` has held
 * `inputTokens`, `outputTokens`, `costUsd` and the cache figures since the
 * parsers were written — and every one of them was thrown away at the end of
 * the turn. Nothing persisted them, so Alpha could not answer "what did that
 * run use", and the agent cards showed a hardcoded 620,000 tokens for every
 * agent instead.
 *
 * That matters more than a missing number on a dashboard. Alpha spawns the
 * machine's own CLIs, so tokens are not billed per call — they are spent
 * against a subscription's rate limits. Knowing whether a three-agent squad is
 * affordable on a given plan is a measurement, and this is the measurement.
 */

/**
 * Fold one `result` event into the running total.
 *
 * Additive rather than last-writer-wins: `codex exec` emits `turn.completed`
 * once per turn, so keeping only the final event would report a multi-turn
 * run as though it had done a single turn's worth of work. Claude and
 * Antigravity emit one result each, where a sum of one is the same answer.
 *
 * A field absent from BOTH sides stays absent. This is deliberate — `undefined`
 * means the CLI did not report that figure (codex says nothing about cache
 * reads; Claude does not break out thinking tokens), and `0` means it reported
 * zero. Collapsing the two would put invented zeroes on screen, which is the
 * same defect as the fabricated diff statistics this codebase already removed.
 */
export function mergeUsage(base: RunUsage | undefined, next: RunTelemetry): RunUsage {
  const merged: RunUsage = { ...(base ?? {}) };

  add(merged, 'inputTokens', next.inputTokens);
  add(merged, 'outputTokens', next.outputTokens);
  add(merged, 'cacheReadTokens', next.cacheReadTokens);
  add(merged, 'cacheCreationTokens', next.cacheCreationTokens);
  add(merged, 'thinkingTokens', next.thinkingTokens);
  add(merged, 'costUsd', next.costUsd);
  add(merged, 'numTurns', next.numTurns);

  return merged;
}

function add(target: RunUsage, key: keyof RunUsage, value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  target[key] = (target[key] ?? 0) + value;
}

/**
 * Total tokens moved through the model for this run.
 *
 * Cache reads are counted. They are cheaper per token than fresh input, not
 * free, and on the measured Claude turn they were 68,492 of the 70,000-odd
 * tokens in the request — excluding them would report that turn as having used
 * four input tokens, which is true and useless.
 *
 * Returns undefined when nothing was reported at all, so a caller can tell
 * "this run used no tokens" apart from "nobody measured this run".
 */
export function totalTokens(usage: RunUsage | undefined): number | undefined {
  if (!usage) return undefined;

  const parts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.thinkingTokens
  ].filter((n): n is number => typeof n === 'number');

  return parts.length ? parts.reduce((a, b) => a + b, 0) : undefined;
}

/** True when the CLI reported at least one figure worth storing. */
export function hasUsage(usage: RunUsage | undefined): boolean {
  return !!usage && Object.values(usage).some(v => typeof v === 'number');
}
