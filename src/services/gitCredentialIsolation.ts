import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ALPHA_DIR } from '../config/env.js';

/**
 * Keep GitHub credentials out of the agent's shell, and hand them only to the
 * tools that are supposed to have them.
 *
 * ## What this closes
 *
 * A run spawns its CLI with `--dangerously-skip-permissions`, so the agent has
 * arbitrary shell, and the process inherits the operator's environment. `gh` is
 * signed in and `git` has a credential helper, which means an agent working a
 * kanban card could `git push --force`, `gh pr merge`, or commit a workflow
 * file — with no gate, no approval, and no record. Alpha's audit trail sees the
 * MCP tools and its own pipeline; it cannot see raw shell.
 *
 * Every guard Alpha has assumes work arrives by pull request. Leaving the
 * shell path open meant those guards protected a door standing next to an open
 * window.
 *
 * ## How, measured on this machine
 *
 *   - `GH_CONFIG_DIR` pointed at an empty directory:
 *     `gh auth status` reports "not logged into any GitHub hosts". This works
 *     even though the token itself lives in the OS keyring, because the record
 *     of *which* host and user to look up is `hosts.yml` in the config dir.
 *
 *   - `credential.helper` overridden to empty via `GIT_CONFIG_COUNT`:
 *     `git credential fill` for github.com returns nothing, where it otherwise
 *     returns a password.
 *
 * ## Why not GIT_CONFIG_NOSYSTEM
 *
 * It is the obvious lever and it is the wrong one. This machine's *system* git
 * config carries `credential.helper` — so `GIT_CONFIG_GLOBAL` alone does not
 * remove it — but it also carries `http.sslcainfo`, `core.autocrlf` and the
 * Git LFS filters. Dropping all of that to remove one entry takes the CA bundle
 * with it, and rewrites line endings in a repository that depends on autocrlf.
 * `GIT_CONFIG_COUNT` injects the single override and leaves the rest intact.
 *
 * ## What this is not
 *
 * A barrier, not a boundary. An agent that goes looking can still read
 * `hosts.yml` off disk — no environment variable prevents reading a file the OS
 * user owns. This makes accidental and casual use impossible and makes the MCP
 * tools the path of least resistance, which is most of the value. A real
 * boundary needs OS-level isolation: a separate user, or a container.
 */

/** An empty directory that exists only so `gh` can find nothing in it. */
export const GH_VOID_DIR = path.join(ALPHA_DIR, 'gh-void');

/**
 * Off by default would make the audit trail permanently partial, so it is on —
 * but a single variable turns it off for anyone whose workflow it breaks
 * (a private git dependency fetched during `npm install`, say).
 */
export function isolationEnabled(): boolean {
  return process.env.ALPHA_ALLOW_AGENT_GIT_CREDENTIALS !== '1';
}

/**
 * Where `gh` really keeps its configuration, captured before anything is
 * stripped so it can be handed back to the MCP server.
 *
 * Mirrors gh's own resolution order. Read from the daemon's environment rather
 * than probed, because by the time a tool needs this the child environment has
 * already been rewritten.
 */
export function realGhConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh');
  if (process.platform === 'win32' && env.AppData) return path.join(env.AppData, 'GitHub CLI');
  return path.join(os.homedir(), '.config', 'gh');
}

/**
 * Environment that removes GitHub credentials from a spawned agent CLI.
 *
 * Empty strings rather than deletions: this is merged over `process.env` by the
 * spawner, and a key absent from the overlay leaves the inherited value in
 * place. Only an explicit empty value overwrites it.
 */
export function agentCredentialEnv(): Record<string, string> {
  if (!isolationEnabled()) return {};

  try {
    fs.mkdirSync(GH_VOID_DIR, { recursive: true });
  } catch {
    // If the directory cannot be made, pointing gh at it still yields no
    // hosts.yml, which is the outcome we want.
  }

  return {
    // gh: no hosts.yml, so no host to authenticate against.
    GH_CONFIG_DIR: GH_VOID_DIR,
    // …and no token handed over by the environment either.
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '',

    // git: one config override, leaving system config otherwise untouched.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: ''
  };
}

/**
 * Environment that gives the credentials back, for Alpha's own MCP server.
 *
 * The server is a child of the agent CLI, so it inherits the stripped values
 * above; these are written into its MCP spec to restore them for that process
 * alone. It is the one place a push is allowed, because it is the one place
 * Alpha can refuse a protected branch and record what happened.
 *
 * `GIT_CONFIG_COUNT=0` is the documented way to say "no injected entries" —
 * clearing the count is what disarms the override, not blanking the key.
 */
export function mcpCredentialEnv(): Record<string, string> {
  if (!isolationEnabled()) return {};

  return {
    GH_CONFIG_DIR: realGhConfigDir(),
    GIT_CONFIG_COUNT: '0'
  };
}
