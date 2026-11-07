import { describe, expect, it } from 'vitest';
import { codexIsolationArgsFrom, runtimeIsolation } from './runtimeIsolation.js';

const FEATURES = [
  'apps                                     stable             true',
  'browser_use                              stable             true',
  'hooks                                    stable             true',
  'memories                                 stable             true',
  'plugins                                  stable             true',
  'fast_mode                                stable             true'
].join('\r\n');

describe('Codex isolation flags', () => {
  it('disables only operator-facing features this Codex lists', () => {
    expect(codexIsolationArgsFrom(FEATURES)).toEqual([
      '--disable', 'apps', '--disable', 'plugins', '--disable', 'memories', '--disable', 'hooks', '--disable', 'browser_use'
    ]);
  });

  it('passes no unknown feature names, which would stop codex from starting', () => {
    expect(codexIsolationArgsFrom('fast_mode stable true')).toEqual([]);
    expect(codexIsolationArgsFrom('')).toEqual([]);
  });
});

describe('runtime isolation status', () => {
  it('marks Codex as not isolated until someone signs in for Alpha, and says how to fix it', () => {
    expect(runtimeIsolation('codex', { codexSignedInForAlpha: false })).toMatchObject({ isolated: false, action: 'codex_sign_in' });
    expect(runtimeIsolation('codex', { codexSignedInForAlpha: true })).toMatchObject({ isolated: true });
  });

  it.each(['claude', 'antigravity', 'gemini', 'opencode'])('marks %s as isolated', id => {
    expect(runtimeIsolation(id, { codexSignedInForAlpha: false })?.isolated).toBe(true);
  });

  it('says nothing about local model runtimes', () => {
    expect(runtimeIsolation('ollama', { codexSignedInForAlpha: false })).toBeUndefined();
  });
});
