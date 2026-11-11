import { describe, expect, it } from 'vitest';
import { estimateApiEquivalentCost } from './usagePricing.js';

describe('API-equivalent usage estimates', () => {
  it('does not double count cached Codex input', () => {
    const result = estimateApiEquivalentCost('codex', 'gpt-6.1-sol', {
      inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 250_000
    });
    expect(result.estimatedCostUsd).toBeCloseTo(2.525);
  });
  it('keeps provider-reported cost separate and leaves unknown models unpriced', () => {
    expect(estimateApiEquivalentCost('claude', 'unknown-model', { inputTokens: 10 }, 0)).toEqual({ reportedCostUsd: 0 });
    expect(estimateApiEquivalentCost('codex', 'unknown-model', { inputTokens: 10 })).toEqual({});
  });
});
