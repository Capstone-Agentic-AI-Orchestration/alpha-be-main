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
let claudeCatalogForAuth: (catalog: { models: string[]; source: RuntimeCatalogSource; error?: string }, authMethod: unknown) => { models: string[]; source: RuntimeCatalogSource; error?: string };

beforeAll(async () => {
  ({ parseOpenCodeModelIds, parseAntigravityModelIds, parseLMStudioModelIds, codexCacheModelIds, claudeCatalogForAuth } = await import('./runtimeService.js'));
});

describe('runtime model catalog parsers', () => {
  it('keeps Claude Code subscription models when no API catalog is available', () => {
    expect(claudeCatalogForAuth({ models: [], source: 'none', error: 'ANTHROPIC_API_KEY is not configured' }, 'claude.ai')).toEqual({
      models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
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
