import { describe, expect, it } from 'vitest';
import type { RuntimeEngine } from '../models/index.js';
import { reconcileDetectedRuntimes } from './runtimeReconciliation.js';
const engine = (id: string, updates: Partial<RuntimeEngine> = {}): RuntimeEngine => ({ id, name: id, provider: 'Ollama', type: 'local', latencyMs: 1, status: 'offline', models: [], ...updates });

describe('runtime scan reconciliation', () => {
  it('drops absent engines and legacy models without detection evidence', () => {
    expect(reconcileDetectedRuntimes([engine('ollama'), engine('lmstudio')], [engine('ollama', { models: ['dummy'], isDefault: true })], new Set())).toEqual([]);
  });
  it('keeps installed engines even when their servers are stopped', () => {
    expect(reconcileDetectedRuntimes([engine('ollama')], [], new Set(['ollama']))).toHaveLength(1);
  });
  it('does not mistake an HTTP error on a known port for installation evidence', () => {
    expect(reconcileDetectedRuntimes([engine('ollama', { status: 'degraded', catalogError: 'HTTP 404' })], [], new Set())).toEqual([]);
  });
  it('keeps positively detected endpoints with no models', () => {
    expect(reconcileDetectedRuntimes([engine('lmstudio', { status: 'online', catalogFetchedAt: '2026-10-16T00:00:00Z' })], [], new Set())).toHaveLength(1);
  });
  it('retains a verified catalog as stale during an outage and moves the default to a usable engine', () => {
    const result = reconcileDetectedRuntimes([engine('ollama'), engine('codex', { status: 'online', models: ['current'] })], [engine('ollama', { models: ['real'], catalogFetchedAt: '2026-10-15T00:00:00Z', isDefault: true })], new Set());
    expect(result[0]).toMatchObject({ models: ['real'], catalogSource: 'cache', catalogStale: true, isDefault: false });
    expect(result[1].isDefault).toBe(true);
  });
  it('honors a successful empty catalog instead of resurrecting old models', () => {
    const result = reconcileDetectedRuntimes([engine('ollama', { status: 'online', catalogFetchedAt: 'new' })], [engine('ollama', { models: ['removed'], catalogFetchedAt: 'old' })], new Set());
    expect(result[0].models).toEqual([]);
  });
  it('replaces a saved catalog when the new scan found models without a fetch time', () => {
    // Codex's built-in catalog carries no fetch time. Keeping the saved list
    // instead left Codex showing three old models when it offered eight.
    const result = reconcileDetectedRuntimes(
      [engine('codex', { status: 'online', models: ['gpt-6-astra', 'gpt-6.1-sol'], catalogSource: 'cli', catalogStale: true })],
      [engine('codex', { models: ['gpt-5.6-terra'], catalogFetchedAt: '2026-10-15T00:00:00Z' })],
      new Set()
    );
    expect(result[0]).toMatchObject({ models: ['gpt-6-astra', 'gpt-6.1-sol'], catalogSource: 'cli' });
  });
});
