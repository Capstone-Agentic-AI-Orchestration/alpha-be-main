import { describe, it, expect } from 'vitest';
import { agentReadiness } from './agentReadiness.js';
import { RuntimeEngine, ModelProvider } from '../models/index.js';

const runtime = (provider: ModelProvider, status: RuntimeEngine['status']): RuntimeEngine => ({
  id: provider.toLowerCase(),
  name: `${provider} CLI`,
  provider,
  status,
  type: 'cloud',
  latencyMs: 0,
  models: []
});

const forProvider = (provider: ModelProvider, status: RuntimeEngine['status']) =>
  agentReadiness({ modelProvider: provider }, [runtime(provider, status)]);

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
    const r = agentReadiness({ modelProvider: 'OpenAI' }, []);
    expect(r.status).toBe('unknown');
    expect(r.detail).toMatch(/Runtimes page/i);
  });

  it('matches the runtime by provider, not by position', () => {
    const runtimes = [runtime('Anthropic', 'online'), runtime('OpenAI', 'degraded')];
    expect(agentReadiness({ modelProvider: 'OpenAI' }, runtimes).status).toBe('signed_out');
  });

  it('treats Google Gemini as its own runtime', () => {
    expect(forProvider('Google Gemini', 'offline').detail).toContain('gemini');
  });

  it('handles a scanning runtime without claiming failure', () => {
    const r = agentReadiness({ modelProvider: 'Anthropic' }, [runtime('Anthropic', 'scanning')]);
    expect(r.status).toBe('unknown');
    expect(r.detail).not.toMatch(/cannot answer/i);
  });
});
