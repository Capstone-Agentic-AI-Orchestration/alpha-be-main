import { describe, it, expect } from 'vitest';
import {
  clearUsageLimit,
  defaultAssistantCandidates,
  markUsageLimited,
  usageLimitFor
} from './defaultAssistant.js';
import { isCommandDenial, usageLimitDetail } from './cliRunner.js';
import { RuntimeEngine, ModelProvider } from '../models/index.js';

const rt = (provider: ModelProvider, models: string[], isDefault = false, status: RuntimeEngine['status'] = 'online'): RuntimeEngine => ({
  id: provider.toLowerCase(), name: `${provider} CLI`, provider, status, type: 'cloud', latencyMs: 0, models, isDefault
});

const machine = [
  rt('Anthropic', ['claude-sonnet-5'], true),
  rt('Antigravity', ['gemini-3.8-flash-high', 'claude-opus-4-6-thinking']),
  rt('OpenAI', ['gpt-6-luna'])
];

describe('who answers for Alpha', () => {
  it('uses the Orchestrator model ahead of the machine default, then every other runtime once', () => {
    const candidates = defaultAssistantCandidates(machine, {
      provider: 'Antigravity', modelName: 'claude-opus-4-6-thinking', reasoningEffort: 'high', agentName: 'Orchestrator Agent'
    });

    expect(candidates.map(c => [c.provider, c.modelName])).toEqual([
      ['Antigravity', 'claude-opus-4-6-thinking'],
      ['Anthropic', 'claude-sonnet-5'],
      ['OpenAI', 'gpt-6-luna']
    ]);
    expect(candidates[0]).toMatchObject({ reasoningEffort: 'high', reason: expect.stringMatching(/Orchestrator Agent/) });
  });

  it('falls back to the machine default when the Orchestrator runtime is signed out or the model is gone', () => {
    const signedOut = [rt('Anthropic', ['claude-sonnet-5'], true), rt('Antigravity', ['gemini-3.8-flash-high'], false, 'offline')];
    expect(defaultAssistantCandidates(signedOut, {
      provider: 'Antigravity', modelName: 'gemini-3.8-flash-high', agentName: 'Orchestrator Agent'
    })[0].provider).toBe('Anthropic');
    expect(defaultAssistantCandidates(machine, {
      provider: 'Antigravity', modelName: 'retired-model', agentName: 'Orchestrator Agent'
    })[0].provider).toBe('Anthropic');
  });

  it('remembers a used-up plan for an hour and forgets it after a good answer', () => {
    const now = Date.parse('2026-10-23T03:00:00Z');
    markUsageLimited('Anthropic', "You've hit your weekly limit", now);
    expect(usageLimitFor('Anthropic', now + 59 * 60 * 1000)).toBe("You've hit your weekly limit");
    expect(usageLimitFor('Anthropic', now + 61 * 60 * 1000)).toBeNull();

    markUsageLimited('Anthropic', 'limit', now);
    clearUsageLimit('Anthropic');
    expect(usageLimitFor('Anthropic', now)).toBeNull();
  });
});

describe('recognising a used-up plan', () => {
  it("recognises agy ending a turn over a refused terminal command, and nothing else", () => {
    const detail = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
    expect(isCommandDenial('Antigravity', { failureKind: 'empty', failureDetail: detail })).toBe(true);
    expect(isCommandDenial('Anthropic', { failureKind: 'empty', failureDetail: detail })).toBe(false);
    expect(isCommandDenial('Antigravity', { failureKind: 'empty', failureDetail: 'the CLI produced no output' })).toBe(false);
    expect(isCommandDenial('Antigravity', { failureKind: null, failureDetail: null })).toBe(false);
  });

  it('reads Claude Code weekly limit, which arrives as the reply text with an error result', () => {
    const text = "You've hit your weekly limit · resets Oct 26, 2am (Asia/Manila)";
    expect(usageLimitDetail({ streamError: text, exitCode: 1, content: text })).toBe(text);
  });

  it('reads the Codex and Gemini wording from stderr on a failed exit', () => {
    expect(usageLimitDetail({ exitCode: 1, stderr: "ERROR: You've hit your usage limit. Try again later." })).toMatch(/usage limit/);
    expect(usageLimitDetail({ exitCode: 1, stderr: 'Error 429: RESOURCE_EXHAUSTED quota exceeded' })).toMatch(/RESOURCE_EXHAUSTED/);
  });

  it('leaves a successful answer that only talks about limits alone', () => {
    expect(usageLimitDetail({ exitCode: 0, content: 'Your API has a usage limit of 100 requests per minute.' })).toBeNull();
    expect(usageLimitDetail({ exitCode: 1, stderr: 'Error: could not connect' })).toBeNull();
  });
});
