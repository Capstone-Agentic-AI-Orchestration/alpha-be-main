import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';

dotenv.config();

/**
 * Which half of the platform this process is.
 *
 * The same compiled backend runs in two places, and they are not variations of
 * one deployment — they have opposite jobs:
 *
 *   - `cloud`   on Render. The control plane: identity, RBAC, GitHub App,
 *               webhooks, the board. It has no developer, no checkout, no agent
 *               CLIs and an ephemeral disk, so it must never try to execute.
 *   - `desktop` inside Electron. The execution node: spawns `claude`/`agy`/
 *               `codex` against a real working copy, and owns the machine-local
 *               facts (paths, PIDs, discovered runtimes) that cannot be shared.
 *
 * Until now nothing in the code could tell them apart, so every difference had
 * to live in someone's head — which is how the packaged desktop build ended up
 * shipping a backend snapshot with no RBAC layer at all.
 *
 * Defaults to `desktop`. A developer running `npm run dev` gets the behaviour
 * they had before, and the mode that grants the fewest assumptions about its
 * environment is the safer thing to reach for by accident: cloud mode binds a
 * public interface.
 */
export type AlphaMode = 'cloud' | 'desktop';
export const ALPHA_MODE: AlphaMode = process.env.ALPHA_MODE === 'cloud' ? 'cloud' : 'desktop';
export const IS_CLOUD = ALPHA_MODE === 'cloud';
export const IS_DESKTOP = !IS_CLOUD;

export const PORT = Number(process.env.PORT || 3001);
/**
 * Loopback on the desktop, public in the cloud.
 *
 * On a workstation this API spawns shell commands, so binding 0.0.0.0 would
 * hand every device on the network a way to start a run. In a Render container
 * the opposite is true: the health check and all real traffic arrive from
 * outside the container, and a service bound to loopback answers none of them —
 * the deploy is marked unhealthy and rolled back with no obvious cause.
 */
export const HOST = process.env.HOST || (IS_CLOUD ? '0.0.0.0' : '127.0.0.1');

/**
 * The GitHub organisation this installation serves.
 *
 * Pinned, not inferred. It used to be derived by counting `githubOrg` across
 * existing projects, which is circular on a fresh install: you need a project
 * to resolve an org, an org to resolve a role, and a role to create a project.
 * Worse, the undefined org silently disabled the `no_team` access gate, so
 * every signed-in account fell through to the `?? 'admin'` default.
 */
export const ALPHA_ORG = process.env.ALPHA_ORG || 'Capstone-Agentic-AI-Orchestration';

/**
 * GitHub logins granted admin without a team, comma separated.
 *
 * A bridge, not the mechanism. Roles come from GitHub teams, and an `admins`
 * team is the intended source — but it does not exist in the organisation yet,
 * while the change that reads it also removes the `?? 'admin'` default that
 * previously granted admin to everyone. Without this there is a window with no
 * administrator at all.
 *
 * It doubles as the recovery path for when GitHub is what broke: a deleted
 * team, revoked org approval, or a token that cannot read teams would
 * otherwise leave nobody able to fix it.
 *
 * Empty by default. Clear it once the `admins` team exists.
 */
export const ALPHA_ADMINS = (process.env.ALPHA_ADMINS || '')
  .split(',')
  .map(login => login.trim())
  .filter(Boolean);

/**
 * Root for everything Alpha stores on this machine.
 *
 * Overridable because these paths are resolved once at import time, which
 * otherwise leaves any service that touches the filesystem — the persona files
 * and memory tiers especially — with no way to be exercised except against the
 * real `~/.alpha`. Tests point this at a temp directory; it also lets an
 * operator relocate the store off a synced home directory.
 */
export const ALPHA_DIR = process.env.ALPHA_HOME || path.join(os.homedir(), '.alpha');
export const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ALPHA_DIR, 'alpha.db');
export const LOGS_DIR = path.join(ALPHA_DIR, 'logs');
export const AUDIT_LOG_PATH = path.join(LOGS_DIR, 'audit.log');
export const MEMORY_DIR = path.join(ALPHA_DIR, 'memory');
export const RUNS_DIR = path.join(ALPHA_DIR, 'runs');
// Hand-editable persona files, one per agent: `<id>.md`. The SQLite `agents`
// table stays the system of record for structured config; these files own the
// system prompt prose and override the columns they declare. See agentFileService.
export const AGENTS_DIR = path.join(ALPHA_DIR, 'agents');
// Working copies of repositories Alpha created or cloned. One allowlisted root
// keeps every agent-writable path in a single place that is easy to reason about.
export const WORKSPACES_DIR = path.join(ALPHA_DIR, 'workspaces');

export const CORS_ORIGIN = process.env.CORS_ORIGIN || [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].join(',');

const ALLOWED_ORIGINS = CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean);

/**
 * One entry of the allowlist, as a matcher.
 *
 * `*` is permitted only as a whole label inside the host — `https://*.vercel.app`
 * — because Vercel gives every preview deploy a fresh subdomain and an
 * exact-match list blocks all of them. Every push would otherwise produce a
 * preview that cannot reach the API, which reads as a broken build.
 *
 * The `*` matches one label and no dots, so `https://*.vercel.app` admits
 * `alpha-fe-git-xyz.vercel.app` but not `evil.attacker.com.vercel.app.evil.com`,
 * and the anchors stop a suffix match from accepting a lookalike domain.
 */
function originMatcher(pattern: string): (origin: string) => boolean {
  if (pattern === '*') return () => true;
  if (!pattern.includes('*')) return origin => origin === pattern;

  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('[^.]+');
  const re = new RegExp(`^${source}$`);
  return origin => re.test(origin);
}

const ORIGIN_MATCHERS = ALLOWED_ORIGINS.map(originMatcher);

/** Whether this `Origin` header may call the API. */
export function isAllowedOrigin(origin: string): boolean {
  return ORIGIN_MATCHERS.some(match => match(origin));
}

// Supabase Configuration (team / cloud mode)
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// GitHub OAuth & Hosted Cloud Configuration
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
/**
 * Must match the route that actually exists: `/api/github/oauth/callback`.
 *
 * The default said `/api/github/callback`, which is not mounted. With an empty
 * `.env` — the state this repository has always been in — that default applies,
 * so the very first OAuth attempt would have redirected GitHub to a 404. The
 * flow has never been executed, so nothing depended on the wrong value.
 */
export const GITHUB_CALLBACK_URL =
  process.env.GITHUB_CALLBACK_URL || 'http://localhost:3001/api/github/oauth/callback';
export const GITHUB_SCOPE = process.env.GITHUB_SCOPE || 'repo,workflow,read:org';

// GitHub App Configuration
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
export const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '';
export const GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET || '';
export const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || 'alpha-agentic-orchestrator';
