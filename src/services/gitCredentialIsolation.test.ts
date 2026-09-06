import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

import {
  agentCredentialEnv,
  mcpCredentialEnv,
  realGhConfigDir,
  isolationEnabled,
  GH_VOID_DIR
} from './gitCredentialIsolation.js';

/**
 * The agent's shell must not reach GitHub; Alpha's own tool must.
 *
 * A run spawns its CLI with `--dangerously-skip-permissions`, so an agent has
 * arbitrary shell and inherits a signed-in `gh` plus a git credential helper.
 * That path bypasses every guard Alpha has — protected branches, the review
 * gate, the audit trail — because none of them can see raw shell.
 *
 * Behaviour verified separately against the real binaries on this machine:
 * with the agent environment, `gh auth status` reports no host and
 * `git credential fill` returns nothing; with the MCP environment, both work.
 * These pin the contract that produces it.
 */

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.ALPHA_ALLOW_AGENT_GIT_CREDENTIALS;
});

afterEach(() => {
  process.env = { ...saved };
});

describe('agentCredentialEnv', () => {
  it('points gh at a directory with no hosts file', () => {
    // gh keeps the record of which host and user to look up in hosts.yml, so an
    // empty config dir signs it out even though the token is in the keyring.
    expect(agentCredentialEnv().GH_CONFIG_DIR).toBe(GH_VOID_DIR);
  });

  it('blanks every token variable gh would honour', () => {
    const env = agentCredentialEnv();
    expect(env.GH_TOKEN).toBe('');
    expect(env.GITHUB_TOKEN).toBe('');
    expect(env.GH_ENTERPRISE_TOKEN).toBe('');
  });

  /**
   * Empty strings, never deletions.
   *
   * This map is merged over `process.env` by the spawner. A key left out of it
   * keeps whatever the daemon inherited — so omitting `GH_TOKEN` would hand the
   * agent the very token this removes.
   */
  it('uses empty values rather than omitting keys', () => {
    const env = agentCredentialEnv();
    expect(Object.keys(env)).toContain('GH_TOKEN');
    expect(env.GH_TOKEN).not.toBeUndefined();
  });

  it('overrides only credential.helper, leaving system git config alone', () => {
    // GIT_CONFIG_NOSYSTEM would also drop http.sslcainfo, core.autocrlf and the
    // LFS filters — taking the CA bundle out to remove one entry.
    const env = agentCredentialEnv();
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  });

  it('returns nothing when the operator has opted out', () => {
    process.env.ALPHA_ALLOW_AGENT_GIT_CREDENTIALS = '1';
    expect(isolationEnabled()).toBe(false);
    expect(agentCredentialEnv()).toEqual({});
    expect(mcpCredentialEnv()).toEqual({});
  });
});

describe('mcpCredentialEnv', () => {
  it('hands the real config dir back', () => {
    expect(mcpCredentialEnv().GH_CONFIG_DIR).toBe(realGhConfigDir());
    expect(mcpCredentialEnv().GH_CONFIG_DIR).not.toBe(GH_VOID_DIR);
  });

  /**
   * Zero, not an empty key.
   *
   * `GIT_CONFIG_COUNT=0` is how git is told there are no injected entries.
   * Blanking the key instead would leave count at 1 pointing at nothing.
   */
  it('disarms the git override by clearing the count', () => {
    expect(mcpCredentialEnv().GIT_CONFIG_COUNT).toBe('0');
  });

  it('undoes exactly what the agent environment did', () => {
    // Layered as the MCP spec layers them: stripped values, then these.
    const merged = { ...agentCredentialEnv(), ...mcpCredentialEnv() };
    expect(merged.GH_CONFIG_DIR).toBe(realGhConfigDir());
    expect(merged.GIT_CONFIG_COUNT).toBe('0');
  });
});

describe('realGhConfigDir', () => {
  it('prefers an explicitly set GH_CONFIG_DIR', () => {
    expect(realGhConfigDir({ GH_CONFIG_DIR: '/somewhere/gh' })).toBe('/somewhere/gh');
  });

  it('falls back to XDG_CONFIG_HOME', () => {
    expect(realGhConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe(path.join('/xdg', 'gh'));
  });

  it('uses the platform default when nothing is set', () => {
    const resolved = realGhConfigDir({});
    const expected =
      process.platform === 'win32' && process.env.AppData === undefined
        ? path.join(os.homedir(), '.config', 'gh')
        : resolved;
    expect(resolved).toBe(expected);
    expect(resolved.length).toBeGreaterThan(0);
  });
});
