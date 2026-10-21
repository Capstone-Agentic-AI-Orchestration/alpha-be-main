import { describe, it, expect } from 'vitest';
import { pickDefaultRuntime, DEFAULT_ASSISTANT, DEFAULT_ASSISTANT_PROMPT } from './defaultAssistant.js';
import { RuntimeEngine, ModelProvider } from '../models/index.js';

const rt = (
  provider: ModelProvider,
  status: RuntimeEngine['status'],
  models: string[],
  isDefault = false
): RuntimeEngine => ({
  id: provider.toLowerCase(), name: `${provider} CLI`, provider, status,
  type: 'cloud', latencyMs: 0, models, isDefault
});

describe('pickDefaultRuntime', () => {
  it('prefers the runtime the scan marked default', () => {
    const chosen = pickDefaultRuntime([
      rt('Antigravity', 'online', ['gemini-3.7-flash-high']),
      rt('Anthropic', 'online', ['claude-sonnet-5'], true)
    ]);

    expect(chosen?.provider).toBe('Anthropic');
    expect(chosen?.modelName).toBe('claude-sonnet-5');
    expect(chosen?.reason).toMatch(/default runtime/i);
  });

  it('keeps the selected runtime endpoint available to the Codex runner', () => {
    const chosen = pickDefaultRuntime([
      { ...rt('OpenAI', 'online', ['gpt-6-astra'], true), endpoint: 'http://127.0.0.1:10100/v1' }
    ]);

    expect(chosen?.endpoint).toBe('http://127.0.0.1:10100/v1');
  });

  it('falls back to another signed-in runtime rather than refusing', () => {
    const chosen = pickDefaultRuntime([
      rt('Anthropic', 'degraded', ['claude-sonnet-5'], true),
      rt('Antigravity', 'online', ['gemini-3.7-flash-high'])
    ]);

    expect(chosen?.provider).toBe('Antigravity');
    expect(chosen?.reason).toMatch(/only signed-in/i);
  });

  it('ignores a runtime that is signed out or missing', () => {
    expect(pickDefaultRuntime([
      rt('Anthropic', 'degraded', ['claude-sonnet-5'], true),
      rt('OpenAI', 'offline', ['codex'])
    ])).toBeNull();
  });

  it('ignores a runtime that reports no models', () => {
    expect(pickDefaultRuntime([rt('Anthropic', 'online', [], true)])).toBeNull();
  });

  it('is null when there are no runtimes at all', () => {
    expect(pickDefaultRuntime([])).toBeNull();
  });

  it('picks deterministically when several are usable and none is default', () => {
    const runtimes = [rt('OpenAI', 'online', ['codex']), rt('Anthropic', 'online', ['claude-sonnet-5'])];
    // Same machine must not answer from a different model run to run.
    expect(pickDefaultRuntime(runtimes)?.provider)
      .toBe(pickDefaultRuntime([...runtimes].reverse())?.provider);
  });
});

describe('the default assistant identity', () => {
  it('is not an agent id that could collide with a generated one', () => {
    expect(DEFAULT_ASSISTANT.id.startsWith('agent-')).toBe(false);
  });

  it('tells the model it is Alpha and not one of the agents', () => {
    expect(DEFAULT_ASSISTANT_PROMPT).toMatch(/you are Alpha/i);
    expect(DEFAULT_ASSISTANT_PROMPT).toMatch(/not one of the configured/i);
  });

  it('tells it to point at @mentions rather than impersonate an agent', () => {
    expect(DEFAULT_ASSISTANT_PROMPT).toMatch(/@mention/i);
    expect(DEFAULT_ASSISTANT_PROMPT).toMatch(/rather than answering on that agent/i);
  });
});
