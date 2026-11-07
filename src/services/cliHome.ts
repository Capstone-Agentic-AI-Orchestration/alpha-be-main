import fs from 'node:fs';
import path from 'node:path';

import { ALPHA_DIR } from '../config/env.js';
import { StreamFamily } from './streamParser.js';

/**
 * Isolate an agent CLI from the operator's personal configuration.
 *
 * ## The problem
 *
 * Asked what agents existed, an Alpha agent answered with the machine owner's
 * own roster — `ceo`, `cpo`, `vp-design`, `orchestration-lead` and the rest —
 * read out of `~/.gemini/GEMINI.md` and `~/.gemini/agents/`. Those are the
 * operator's personal `agy` agents. They are not Alpha's, the person chatting
 * has no reason to know they exist, and an Alpha agent has no business
 * enumerating them.
 *
 * `agy` loads all of it automatically: GEMINI.md as ambient context, plus
 * `agents/`, `rules/`, `skills/`, `memory/`, `hooks/` and `plugins/`. There is
 * no flag to turn that off — Claude Code has `--setting-sources`, and that is
 * exactly what this runner already passes for the Claude family; `agy --help`
 * offers no equivalent.
 *
 * ## The lever that does work
 *
 * `agy` resolves its configuration from the home directory, so pointing the
 * spawned process at a different one isolates it completely. Verified against
 * agy on this machine: with HOME and USERPROFILE relocated, `agy agents` lists
 * nothing, and a prompt still answers — its credentials do not live under
 * `~/.gemini`, so sign-in survives.
 *
 * ## Each runtime
 *
 * - `claude` is already isolated by `--setting-sources ''` and
 *   `--strict-mcp-config`, and its credentials ARE under `~/.claude`, so
 *   relocating its home would sign the user out. Verified 2026-11-07: a turn
 *   loads none of the operator's `CLAUDE.md`, skills, agents or MCP servers.
 * - `agy` (Antigravity, and Gemini agents through it) gets a managed home.
 *   Alpha's own tool servers inherit that HOME, so ALPHA_HOME is pinned to the
 *   real Alpha folder; without it they created a second, empty `.alpha`
 *   database inside the managed home.
 * - `codex` reads its global `AGENTS.md`, skills, memories, hooks, plugins
 *   and apps from CODEX_HOME, and `--ignore-user-config` skips only
 *   `config.toml`. The operator's `~/.codex/AGENTS.md` grew to Notion rules
 *   that Alpha agents then followed. Codex gets its own home at
 *   `cli-home/codex` once someone signs in there for Alpha (its credentials
 *   live in that home, so the operator's sign-in cannot be shared without
 *   two copies of a rotating token). Until then it keeps the real home, and
 *   the Runtimes page says so.
 * - `opencode` merges Alpha's config over the operator's global one, so the
 *   operator's MCP servers stayed enabled, and it loads `~/.claude` and
 *   `~/.agents` skills. It gets an empty config home and its Claude Code
 *   compatibility and external skills turned off. Credentials live in its data
 *   folder, which is untouched.
 *
 * The directory is persistent rather than per-run so the CLI keeps its own
 * cache and conversation state across turns — a fresh home every turn would
 * make `--conversation` meaningless.
 */

export const CLI_HOME_DIR = path.join(ALPHA_DIR, 'cli-home');

/** Families whose configuration leaks in and whose auth survives relocation. */
const ISOLATED_FAMILIES: ReadonlySet<StreamFamily> = new Set<StreamFamily>(['antigravity']);

/**
 * A managed home directory for this CLI family, or null to leave the process
 * with the real one.
 */
export function managedCliHome(family: StreamFamily): string | null {
  if (!ISOLATED_FAMILIES.has(family)) return null;

  const dir = path.join(CLI_HOME_DIR, family);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Environment overrides that point a spawned CLI at its managed home.
 *
 * Both variables, because the CLIs are a mix of Go and Node: Go's
 * `os.UserHomeDir` reads USERPROFILE on Windows and HOME elsewhere, and Node's
 * `os.homedir` prefers USERPROFILE on Windows but falls back to HOME.
 */
export function cliHomeEnv(family: StreamFamily): Record<string, string> {
  const home = managedCliHome(family);
  if (!home) return {};

  // Alpha's tool servers run under the same HOME and must keep using the
  // real Alpha folder rather than resolving `~/.alpha` inside the managed one.
  return { HOME: home, USERPROFILE: home, ALPHA_HOME: ALPHA_DIR };
}

/** Alpha's own Codex home. Created on first use; empty until someone signs in for Alpha. */
export function codexAlphaHome(): string {
  const dir = path.join(CLI_HOME_DIR, 'codex');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Whether someone has signed in to Codex for Alpha, so agents can use Alpha's own home. */
export function codexAlphaSignedIn(home: string = codexAlphaHome()): boolean {
  return fs.existsSync(path.join(home, 'auth.json'));
}

/**
 * Environment that keeps OpenCode away from the operator's own setup.
 *
 * Measured with OpenCode 1.17.9 (`opencode debug config` and `debug skill`):
 * the operator's global config contributed two enabled MCP servers and 72
 * skills came from `~/.claude` and `~/.agents`; with these three settings
 * there were no personal MCP servers and only the built-in skill.
 */
export function openCodeIsolationEnv(): Record<string, string> {
  const dir = path.join(CLI_HOME_DIR, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  return {
    XDG_CONFIG_HOME: dir,
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1'
  };
}
