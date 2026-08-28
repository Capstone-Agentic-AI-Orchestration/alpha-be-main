export const EXECUTION_LIMITS = {
  WALL_CLOCK_TIMEOUT_MS: 15 * 60 * 1000, // 15 minutes hard timeout
  IDLE_TIMEOUT_MS: 120 * 1000, // 120 seconds no-output idle timeout
  MAX_TURNS: 25, // 25 turns per task
  MAX_OUTPUT_LINES_FOR_CONTEXT: 100, // Compaction threshold
  MAX_OUTPUT_CHARS_FOR_CONTEXT: 2000,
  MAX_RULES_WORD_COUNT: 500
};

/**
 * Caps on what the file-backed memory tiers may add to a system prompt.
 *
 * The plan's stated goal for this layer was agents that improve over time
 * "without ballooning prompt tokens", and these files are append-only by nature
 * — nothing else stops a mistakes.md from growing until it dominates every
 * request. Characters rather than tokens because that is what we can measure
 * without a tokenizer; roughly 4 chars per token, so 6000 is ~1.5k tokens per
 * file and the total cap is ~4.5k.
 */
export const MEMORY_LIMITS = {
  MAX_CHARS_PER_FILE: 6000,
  MAX_CHARS_TOTAL: 18000
};

export const PROVIDER_CONCURRENCY = {
  ANTHROPIC: { concurrency: 2, interval: 60000, intervalCap: 50 },
  GEMINI: { concurrency: 5, interval: 60000, intervalCap: 120 },
  OPENAI: { concurrency: 3, interval: 60000, intervalCap: 80 }
};

export const RUNTIME_NAMES = {
  CLAUDE: 'claude',
  CODEX: 'codex',
  GEMINI: 'gemini',
  OLLAMA: 'ollama',
  LMSTUDIO: 'lmstudio'
};
