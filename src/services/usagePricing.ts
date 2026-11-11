import type { StreamFamily } from './streamParser.js';

/** Prices are a dated reference snapshot, not a statement of provider billing. */
export const USAGE_PRICE_TABLE_VERSION = '2026-11-12';

interface ModelPrice {
  pattern: RegExp;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
}

/**
 * Public API list prices, used only to estimate the API-equivalent value of
 * Alpha-launched work. Subscription usage and actual bills are not inferred.
 * Sources: OpenAI API pricing, Anthropic Claude Platform pricing, and Google
 * Gemini Developer API pricing, checked on 2026-11-12.
 */
const MODEL_PRICES: ModelPrice[] = [
  { pattern: /^gpt-6-astra(?:$|-)/, inputUsdPerMillion: 10, outputUsdPerMillion: 50, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 12.5 },
  { pattern: /^gpt-6\.1-sol(?:$|-)/, inputUsdPerMillion: 2, outputUsdPerMillion: 10, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 2.5 },
  { pattern: /^gpt-6\.1-terra(?:$|-)/, inputUsdPerMillion: 1, outputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.05, cacheWriteUsdPerMillion: 1.25 },
  { pattern: /^gpt-6-luna(?:$|-)/, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5, cacheReadUsdPerMillion: 0.01, cacheWriteUsdPerMillion: 0.125 },
  { pattern: /^claude-opus-5[.-]5(?:$|-)/, inputUsdPerMillion: 4, outputUsdPerMillion: 20, cacheReadUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 5 },
  { pattern: /^claude-(?:mythos|fable)-5[.-]2(?:$|-)/, inputUsdPerMillion: 8, outputUsdPerMillion: 40, cacheReadUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 10 },
  { pattern: /^claude-(?:mythos|fable)-5[.-]1(?:$|-)/, inputUsdPerMillion: 10, outputUsdPerMillion: 50, cacheReadUsdPerMillion: 0.25, cacheWriteUsdPerMillion: 12.5 },
  { pattern: /^claude-(?:mythos|fable)-5(?:$|-)/, inputUsdPerMillion: 10, outputUsdPerMillion: 50, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 12.5 },
  { pattern: /^claude-opus-5(?:$|-)/, inputUsdPerMillion: 5, outputUsdPerMillion: 25, cacheReadUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 6.25 },
  { pattern: /^claude-opus-4[.-][5-8](?:$|-)/, inputUsdPerMillion: 5, outputUsdPerMillion: 25, cacheReadUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 6.25 },
  { pattern: /^claude-sonnet-5(?:[.-]5)?(?:$|-)/, inputUsdPerMillion: 2, outputUsdPerMillion: 10, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 2.5 },
  { pattern: /^claude-sonnet-4[.-][56](?:$|-)/, inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: 0.3, cacheWriteUsdPerMillion: 3.75 },
  { pattern: /^claude-haiku-5[.-]5(?:$|-)/, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5, cacheReadUsdPerMillion: 0.01, cacheWriteUsdPerMillion: 0.125 },
  { pattern: /^claude-haiku-4[.-]5(?:$|-)/, inputUsdPerMillion: 1, outputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 1.25 },
  { pattern: /^gemini-3\.8-flash(?:$|-)/, inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75, cacheReadUsdPerMillion: 0.075 },
  { pattern: /^gemini-3\.1-flash-lite(?:$|-)/, inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5, cacheReadUsdPerMillion: 0.025 },
  { pattern: /^gemini-2\.5-flash(?:$|-)/, inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.03 }
];

export interface UsageCostInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface UsageCost {
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
}

function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Cost estimates respect token overlap differences between CLI families. */
export function estimateApiEquivalentCost(
  family: StreamFamily,
  model: string | undefined,
  usage: UsageCostInput,
  reportedCostUsd?: number
): UsageCost {
  if (typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
    return { reportedCostUsd };
  }
  if (!model) return {};
  if (![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens]
    .some(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return {};
  const normalizedModel = model.toLowerCase();
  const price = MODEL_PRICES.find(item => item.pattern.test(normalizedModel));
  if (!price) return {};

  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  const cached = tokenCount(usage.cacheReadTokens);
  const cacheWrite = tokenCount(usage.cacheCreationTokens);
  // Codex reports cached input as a subset of input. Claude and Antigravity
  // report fresh input separately from cache tokens.
  const uncachedInput = family === 'codex' ? Math.max(0, input - cached - cacheWrite) : input;
  const cacheReadRate = price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion;
  const cacheWriteRate = price.cacheWriteUsdPerMillion ?? price.inputUsdPerMillion;
  const estimated = (
    uncachedInput * price.inputUsdPerMillion +
    cached * cacheReadRate +
    cacheWrite * cacheWriteRate +
    output * price.outputUsdPerMillion
  ) / 1_000_000;

  return { estimatedCostUsd: estimated };
}
