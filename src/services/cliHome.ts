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
 * ## Why only Antigravity
 *
 * - `claude` is already isolated by `--setting-sources ''`, and its credentials
 *   ARE under `~/.claude`, so relocating its home would sign the user out.
 * - `codex` keeps `auth.json` in `~/.codex`, so the same applies. Its exposure
 *   is a 29-byte `AGENTS.md`; signing the user out to remove that is a bad
 *   trade. `~/.codex/config.toml` can still contribute MCP servers and model
 *   settings, which is worth revisiting if it ever matters.
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

  return { HOME: home, USERPROFILE: home };
}
