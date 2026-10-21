import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexModelConfigArgs } from './codexModelConfig.js';

const temporaryHomes: string[] = [];

function createCodexHome(catalog: unknown, config = ''): { home: string; catalogPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-codex-model-config-'));
  temporaryHomes.push(home);
  const catalogPath = path.join(home, 'opencodex-catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  fs.writeFileSync(path.join(home, 'config.toml'), config || [
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`
  ].join('\n'));
  return { home, catalogPath };
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('codexModelConfigArgs', () => {
  it('routes catalogued models through the loopback gateway with their metadata catalog', () => {
    const { home, catalogPath } = createCodexHome({ models: [{ slug: 'gpt-6-astra' }] });

    expect(codexModelConfigArgs('gpt-6-astra', 'http://127.0.0.1:10100/v1', { home })).toEqual([
      '--config', 'openai_base_url="http://127.0.0.1:10100/v1"',
      '--config', `model_catalog_json=${JSON.stringify(catalogPath)}`
    ]);
  });

  it('does not add gateway overrides when the chosen model is missing from the catalog', () => {
    const { home } = createCodexHome({ models: [{ slug: 'gpt-6.1-sol' }] });
    expect(codexModelConfigArgs('gpt-6-astra', 'http://127.0.0.1:10100/v1', { home })).toEqual([]);
  });

  it('rejects non-loopback endpoints and catalog paths outside Codex home', () => {
    const external = 'https://example.invalid/v1';
    const { home } = createCodexHome(
      { models: [{ slug: 'gpt-6-astra' }] },
      `model_catalog_json = "${path.join(os.tmpdir(), 'outside.json')}"`
    );
    expect(codexModelConfigArgs('gpt-6-astra', external, { home })).toEqual([]);
  });

  it('does nothing when no model is selected', () => {
    const { home } = createCodexHome({ models: [{ slug: 'gpt-6-astra' }] });
    expect(codexModelConfigArgs(undefined, 'http://127.0.0.1:10100/v1', { home })).toEqual([]);
    expect(codexModelConfigArgs('gpt-6-astra', undefined, { home })).toEqual([]);
  });
});
