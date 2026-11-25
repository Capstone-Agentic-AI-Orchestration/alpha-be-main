import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RuntimeCatalogSource } from '../models/index.js';

vi.mock('./sqliteService.js', () => ({
  sqliteService: {
    getRuntimes: () => [],
    saveRuntimes: () => undefined
  }
}));

let parseOpenCodeModelIds: (output: string) => string[];
let parseAntigravityModelIds: (output: string) => string[];
let parseLMStudioModelIds: (payload: unknown) => string[];
let codexCacheModelIds: (payload: unknown) => string[];
let codexFetchedModelCache: (payload: unknown) => boolean;
let claudeCatalogForAuth: (catalog: { models: string[]; source: RuntimeCatalogSource; error?: string }, authMethod: unknown) => { models: string[]; source: RuntimeCatalogSource; error?: string };

beforeAll(async () => {
  ({ parseOpenCodeModelIds, parseAntigravityModelIds, parseLMStudioModelIds, codexCacheModelIds, codexFetchedModelCache, claudeCatalogForAuth } = await import('./runtimeService.js'));
});

describe('runtime model catalog parsers', () => {
  it('lists Claude Code model aliases for a subscription login with no API catalog', () => {
    expect(claudeCatalogForAuth({ models: [], source: 'none', error: 'ANTHROPIC_API_KEY is not configured' }, 'claude.ai')).toEqual({
      models: ['sonnet', 'opus', 'haiku', 'fable'],
      source: 'cli'
    });
  });

  it('prefers a live Anthropic API catalog and does not invent models for other auth modes', () => {
    const liveCatalog = { models: ['claude-sonnet-5'], source: 'remote_api' as const };
    expect(claudeCatalogForAuth(liveCatalog, 'claude.ai')).toBe(liveCatalog);
    expect(claudeCatalogForAuth({ models: [], source: 'none' }, 'console')).toEqual({ models: [], source: 'none' });
  });

  it('keeps provider/model ids from OpenCode and ignores labels', () => {
    expect(parseOpenCodeModelIds([
      'Models available:',
      'opencode/big-pickle',
      'anthropic/claude-sonnet-5  (latest)',
      '> not-a-provider-model',
      'opencode/big-pickle'
    ].join('\n'))).toEqual([
      'opencode/big-pickle',
      'anthropic/claude-sonnet-5'
    ]);
  });

  it('filters hidden and API-unsupported Codex cache entries in priority order', () => {
    expect(codexCacheModelIds({ models: [
      { slug: 'hidden', priority: 0, visibility: 'hide' },
      { slug: 'gpt-5.6-terra', priority: 2, visibility: 'list', supported_in_api: true },
      { slug: 'internal', priority: 1, visibility: 'list', supported_in_api: false },
      { slug: 'gpt-5.6-sol', priority: 0, visibility: 'list', supported_in_api: true }
    ] })).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('parses Antigravity text and JSON listings without keeping headings', () => {
    expect(parseAntigravityModelIds([
      'Available models:',
      'gemini-3-pro\tGoogle Gemini Pro',
      'claude-sonnet-4-5',
      'Fetching models...'
    ].join('\n'))).toEqual(['gemini-3-pro', 'claude-sonnet-4-5']);
    expect(parseAntigravityModelIds(JSON.stringify({ models: [{ id: 'gpt-oss-120b' }] }))).toEqual(['gpt-oss-120b']);
  });

  it('uses LM Studio native model keys and omits embedding models', () => {
    expect(parseLMStudioModelIds({ models: [
      { type: 'llm', key: 'google/gemma-4-26b-a4b' },
      { type: 'embedding', key: 'nomic-embed-text' },
      { type: 'embeddings', id: 'legacy-embedding' }
    ] })).toEqual(['google/gemma-4-26b-a4b']);
    expect(parseLMStudioModelIds({ data: [{ id: 'legacy-model' }] })).toEqual(['legacy-model']);
  });
});

describe('Codex model cache provenance', () => {
  // Headers captured from one machine: Codex's own fetch, then the same file
  // after OpenCodex overwrote it with its gateway catalog.
  const codexFetched = {
    fetched_at: '2026-11-23T06:46:17.409537200Z',
    etag: 'W/"dd9556756534500859f736d0a884684f"',
    client_version: '0.166.0',
    models: [{ slug: 'gpt-6-luna', visibility: 'list' }]
  };
  const gatewayWritten = {
    fetched_at: '2000-01-01T00:00:00Z',
    client_version: '0.0.0',
    models: [
      { slug: 'gpt-6.2-sol', visibility: 'list' },
      { slug: 'anthropic/claude-opus-5-5', visibility: 'list' }
    ]
  };

  it('trusts the catalog Codex fetched for its own sign-in', () => {
    expect(codexFetchedModelCache(codexFetched)).toBe(true);
  });

  it('never trusts a catalog a gateway wrote into the Codex cache', () => {
    // Its models only exist while that gateway runs; listing them is how a
    // chat came to depend on OpenCodex being started.
    expect(codexFetchedModelCache(gatewayWritten)).toBe(false);
    expect(codexFetchedModelCache({ ...gatewayWritten, etag: '  ' })).toBe(false);
    expect(codexFetchedModelCache(null)).toBe(false);
  });
});
