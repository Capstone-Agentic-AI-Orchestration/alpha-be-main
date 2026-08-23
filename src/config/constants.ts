export const EXECUTION_LIMITS = {
  WALL_CLOCK_TIMEOUT_MS: 15 * 60 * 1000, // 15 minutes hard timeout
  IDLE_TIMEOUT_MS: 120 * 1000, // 120 seconds no-output idle timeout
  MAX_TURNS: 25, // 25 turns per task
  MAX_OUTPUT_LINES_FOR_CONTEXT: 100, // Compaction threshold
  MAX_OUTPUT_CHARS_FOR_CONTEXT: 2000,
  MAX_RULES_WORD_COUNT: 500
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
