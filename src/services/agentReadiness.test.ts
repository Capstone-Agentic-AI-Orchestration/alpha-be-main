import { describe, it, expect } from 'vitest';
import { agentReadiness } from './agentReadiness.js';
import { RuntimeEngine, ModelProvider } from '../models/index.js';

const runtime = (
  provider: ModelProvider,
  status: RuntimeEngine['status'],
  models: string[] = []
): RuntimeEngine => ({
  id: provider.toLowerCase(),
  name: `${provider} CLI`,
  provider,
  status,
  type: 'cloud',
  latencyMs: 0,
  models
});

const forProvider = (provider: ModelProvider, status: RuntimeEngine['status']) =>
  agentReadiness({ modelProvider: provider, modelName: 'any-model' }, [runtime(provider, status)]);

describe('agentReadiness', () => {
  it('is ready when the CLI is installed and signed in', () => {
    expect(forProvider('Anthropic', 'online').status).toBe('ready');
  });

  it('distinguishes signed out from not installed', () => {
    // runtimeService reports `degraded` for installed-but-no-session. Collapsing
    // the two would tell someone to install a CLI they already have.
    expect(forProvider('OpenAI', 'degraded').status).toBe('signed_out');
    expect(forProvider('OpenAI', 'offline').status).toBe('not_installed');
  });

  it('names the binary a person would actually type', () => {
    expect(forProvider('OpenAI', 'degraded').detail).toContain('codex');
    expect(forProvider('Anthropic', 'degraded').detail).toContain('claude');
    expect(forProvider('Antigravity', 'degraded').detail).toContain('agy');
  });

  it('gives the sign-in command when signed out', () => {
    expect(forProvider('OpenAI', 'degraded').command).toBe('codex login');
  });

  it('gives install guidance when the binary is missing', () => {
    expect(forProvider('OpenAI', 'offline').command).toContain('@openai/codex');
  });

  it('says the agent cannot answer, not merely that a CLI is unhappy', () => {
    for (const s of ['degraded', 'offline'] as const) {
      expect(forProvider('OpenAI', s).detail).toMatch(/cannot answer/i);
    }
  });

  it('is unknown when no runtime was scanned for the provider', () => {
    const r = agentReadiness({ modelProvider: 'OpenAI', modelName: 'codex' }, []);
    expect(r.status).toBe('unknown');
    expect(r.detail).toMatch(/Runtimes page/i);
  });

  it('matches the runtime by provider, not by position', () => {
    const runtimes = [runtime('Anthropic', 'online'), runtime('OpenAI', 'degraded')];
    expect(agentReadiness({ modelProvider: 'OpenAI', modelName: 'codex' }, runtimes).status).toBe('signed_out');
  });

  it('checks Antigravity readiness for Google Gemini agents', () => {
    const agy = runtime('Antigravity', 'online', ['gemini-3.8-flash-high']);
    const result = agentReadiness(
      { modelProvider: 'Google Gemini', modelName: 'gemini-3.8-flash-high' },
      [runtime('Google Gemini', 'offline'), agy]
    );
    expect(result.status).toBe('ready');
    expect(result.detail).toContain('agy');
  });

  it('handles a scanning runtime without claiming failure', () => {
    const r = agentReadiness({ modelProvider: 'Anthropic', modelName: 'claude-sonnet-5' }, [runtime('Anthropic', 'scanning')]);
    expect(r.status).toBe('unknown');
    expect(r.detail).not.toMatch(/cannot answer/i);
  });
  /**
   * The failure this was added for: Antigravity 1.1.25 retired the gemini-3.5
   * family, and an agent pinned to one kept reporting 'ready' because the CLI
   * itself was healthy. The run then died on "invalid model selection".
   */
  it('flags a pinned model the CLI no longer offers, even when it is signed in', () => {
    const agy = runtime('Antigravity', 'online', [
      'gemini-3.8-flash-high',
      'gemini-3.7-flash-high'
    ]);
    const r = agentReadiness(
      { modelProvider: 'Antigravity', modelName: 'gemini-3.5-flash-low' },
      [agy]
    );
    expect(r.status).toBe('stale_model');
    expect(r.detail).toContain('gemini-3.5-flash-low');
    expect(r.detail).toMatch(/cannot answer/i);
    // The point of failing here rather than at the CLI is that the message
    // names the fix; the CLI's own error blamed the install.
    expect(r.command).toContain('gemini-3.8-flash-high');
  });

  it('stays ready when the pinned model is still offered', () => {
    const agy = runtime('Antigravity', 'online', ['gemini-3.8-flash-high']);
    const r = agentReadiness(
      { modelProvider: 'Antigravity', modelName: 'gemini-3.8-flash-high' },
      [agy]
    );
    expect(r.status).toBe('ready');
  });

  /**
   * A timed-out probe keeps the last known list, and several runtimes report no
   * models at all. Treating "we do not know" as "the model is gone" would take
   * working agents offline on a slow network.
   */
  it('does not call a model stale when the runtime reported no models', () => {
    const r = agentReadiness(
      { modelProvider: 'Antigravity', modelName: 'gemini-3.5-flash-low' },
      [runtime('Antigravity', 'online', [])]
    );
    expect(r.status).toBe('ready');
  });

  it('does not call a model stale when the CLI is not usable anyway', () => {
    // Signed out is the more actionable message of the two: fixing the login is
    // a precondition for the model list being trustworthy at all.
    const r = agentReadiness(
      { modelProvider: 'Antigravity', modelName: 'gemini-3.5-flash-low' },
      [runtime('Antigravity', 'degraded', ['gemini-3.8-flash-high'])]
    );
    expect(r.status).toBe('signed_out');
  });

  /**
   * A Claude subscription login has no model list, so the scan lists Claude
   * Code's aliases. Agents pinned to a full name before that change must stay
   * ready: Claude Code accepts the name, and an alias list cannot prove it gone.
   */
  it('keeps a full Claude model name ready when the scan lists only aliases', () => {
    const claude = { ...runtime('Anthropic', 'online', ['sonnet', 'opus', 'haiku', 'fable']), catalogSource: 'cli' as const };
    expect(agentReadiness({ modelProvider: 'Anthropic', modelName: 'claude-sonnet-5' }, [claude]).status).toBe('ready');
    expect(agentReadiness({ modelProvider: 'Anthropic', modelName: 'opus' }, [claude]).status).toBe('ready');
    expect(agentReadiness({ modelProvider: 'Anthropic', modelName: 'gpt-6-luna' }, [claude]).status).toBe('stale_model');
  });

  it('still flags a Claude model missing from a live API catalog', () => {
    const claude = { ...runtime('Anthropic', 'online', ['claude-sonnet-5-5']), catalogSource: 'remote_api' as const };
    expect(agentReadiness({ modelProvider: 'Anthropic', modelName: 'claude-sonnet-4-5' }, [claude]).status).toBe('stale_model');
  });

  it('ignores an agent with no model pinned', () => {
    const r = agentReadiness(
      { modelProvider: 'Antigravity', modelName: '' },
      [runtime('Antigravity', 'online', ['gemini-3.8-flash-high'])]
    );
    expect(r.status).toBe('ready');
  });

  it('supports OpenCode provider readiness', () => {
    const ready = forProvider('OpenCode', 'online');
    expect(ready.status).toBe('ready');
    const signedOut = forProvider('OpenCode', 'degraded');
    expect(signedOut.status).toBe('signed_out');
    expect(signedOut.command).toBe('opencode auth');
    const notInstalled = forProvider('OpenCode', 'offline');
    expect(notInstalled.status).toBe('not_installed');
    expect(notInstalled.command).toContain('opencode-ai');
  });
});
