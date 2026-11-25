import { describe, it, expect } from 'vitest';
import { pickDefaultRuntime, defaultAssistantCandidates, DEFAULT_ASSISTANT, DEFAULT_ASSISTANT_PROMPT, describeRuntimeModel, assistantPromptFor, CLIENT_ASSISTANT_PROMPT, HOW_TO_EXPLAIN } from './defaultAssistant.js';
import { chatAudience } from './chatProductContext.js';
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

  it('keeps the Orchestrator on its full Claude model name when the scan lists only aliases', () => {
    const claude = { ...rt('Anthropic', 'online', ['sonnet', 'opus', 'haiku', 'fable'], true), catalogSource: 'cli' as const };
    const [first] = defaultAssistantCandidates([claude], { provider: 'Anthropic', modelName: 'claude-sonnet-5', agentName: 'Alpha' });
    expect(first?.modelName).toBe('claude-sonnet-5');
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

describe('how Alpha explains the product', () => {
  it('leads with purpose, keeps code names out unless asked, and never guesses', () => {
    expect(DEFAULT_ASSISTANT_PROMPT).toContain(HOW_TO_EXPLAIN);
    expect(HOW_TO_EXPLAIN).toContain('Lead with what the product is for');
    expect(HOW_TO_EXPLAIN).toContain('No file paths, frameworks, libraries or configuration names unless the person asks');
    expect(HOW_TO_EXPLAIN).toContain('Never guess. When something is not in these records, say it is not recorded');
    expect(HOW_TO_EXPLAIN).toContain('Name old or conflicting records as such');
  });

  it('speaks to each team role in its own terms', () => {
    expect(assistantPromptFor('pm')).toContain('project manager: use product terms');
    expect(assistantPromptFor('dev')).toContain('developer: product terms first, then technical detail');
    for (const role of ['pm', 'dev', 'admin']) expect(assistantPromptFor(role)).toContain('suggest adding it to the brief or the board');
  });

  it('gives a client, or a role it does not know, the client prompt with nothing about how the work is done', () => {
    for (const role of ['client', undefined, 'auditor']) expect(assistantPromptFor(role)).toBe(CLIENT_ASSISTANT_PROMPT);
    expect(CLIENT_ASSISTANT_PROMPT).toContain('Never guess.');
    expect(CLIENT_ASSISTANT_PROMPT).not.toMatch(/\b(?:builds?|agents?|plans?|tasks?|blockers?|specialists?|orchestrat\w*|decisions?|board|cards?)\b/i);
    expect(chatAudience('client')).toBe('client');
    expect(chatAudience(undefined)).toBe('client');
    expect(chatAudience('dev')).toBe('team');
  });
});

describe('describeRuntimeModel', () => {
  it('tells the agent the runtime and model Alpha chose, so it can say which model it is', () => {
    const text = describeRuntimeModel({ provider: 'Anthropic', name: 'Claude Code CLI', modelName: 'claude-sonnet-5', reasoningEffort: 'high' });
    expect(text).toContain('## Your runtime');
    expect(text).toContain('Claude Code CLI (Anthropic) with the model claude-sonnet-5, high reasoning effort');
    expect(text).toContain('which model or runtime you are using');
  });

  it('does not repeat the provider when the runtime has no separate name', () => {
    expect(describeRuntimeModel({ provider: 'OpenAI', modelName: 'gpt-6.1' })).toContain('runs through OpenAI with the model gpt-6.1, as selected');
  });
});
