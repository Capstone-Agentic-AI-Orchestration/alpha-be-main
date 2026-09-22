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

/**
 * An installed desktop app, as opposed to a daemon someone is running from a
 * checkout. Set by the Electron shell from `app.isPackaged`.
 *
 * The difference matters for one thing only: whether the machine's `gh` login
 * may stand in for a sign-in Alpha has not got. For a developer editing Alpha
 * it should -- they have `gh` set up and should not complete a device flow to
 * run what they are working on. For an installed copy it must not, because
 * borrowing the machine's account is the behaviour the in-app sign-in replaced.
 * Without this the fallback silently reinstated it: the app opened straight
 * onto the board, signed in as whoever the terminal was.
 */
export const IS_PACKAGED_DESKTOP = process.env.ALPHA_PACKAGED === '1';

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
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

let hostOverrideReason = '';

/**
 * A loopback bind in a container serves nobody, so it is never the intent.
 *
 * The mode default alone was not enough. `dotenv` loads the repository's local
 * `.env`, which sets `HOST=127.0.0.1` for desktop development, and that value
 * wins over the default here. The file is gitignored so a real Render deploy
 * would not have it — but "the safety depends on a file being absent" is the
 * kind of thing that holds until someone copies their env to the server, and
 * the failure it produces is a health check that times out with nothing in the
 * log pointing at the cause.
 *
 * Overridden rather than refused: the deploy should come up. The reason is
 * reported at startup so the stale setting still gets fixed.
 */
function resolveHost(): string {
  const configured = process.env.HOST?.trim();
  if (!configured) return IS_CLOUD ? '0.0.0.0' : '127.0.0.1';

  if (IS_CLOUD && LOOPBACK_HOSTS.has(configured.toLowerCase())) {
    hostOverrideReason =
      `HOST was set to "${configured}", which in cloud mode would accept no traffic ` +
      'from outside the container and fail the platform health check. Bound 0.0.0.0 instead.';
    return '0.0.0.0';
  }
  return configured;
}

export const HOST = resolveHost();

/** Why HOST differs from what was configured, when it does. */
export function hostOverrideNote(): string {
  return hostOverrideReason;
}

/**
 * The GitHub organisation this installation serves.
 *
 * Pinned, not inferred. It used to be derived by counting `githubOrg` across
 * existing projects, which is circular on a fresh install: you need a project
 * to resolve an org, an org to resolve a role, and a role to create a project.
 * Worse, the undefined org silently disabled the `no_team` access gate, so
 * every signed-in account fell through to the `?? 'admin'` default.
 *
 * Required, with no default. It used to fall back to one particular
 * organisation, which tied every deployment -- and every teammate's desktop --
 * to that org without saying so. `index.ts` refuses to start without it.
 */
export const ALPHA_ORG = (process.env.ALPHA_ORG || '').trim();

/**
 * The repository the desktop app is released from, as `owner/name`.
 *
 * Named rather than derived from `ALPHA_ORG`: the desktop can live anywhere,
 * and guessing at a name is how a deployment ends up silently serving another
 * organisation's installer. Empty means this deployment offers no download,
 * which the route says plainly instead of failing.
 */
export const ALPHA_DESKTOP_REPO = (process.env.ALPHA_DESKTOP_REPO || '').trim();

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

/**
 * Origins allowed to call this API with credentials. No default: an unset
 * allowlist admits no cross-origin browser at all, which is the safe reading.
 * The desktop shell sets its own; a dev server's origin goes in `.env`.
 */
export const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

const ALLOWED_ORIGINS = CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean);

/**
 * Hosting platforms where a subdomain is not evidence of anything.
 *
 * `alpha-fe-git-main-lloyd.vercel.app` and `attacker-exfil.vercel.app` are
 * issued by the same registrar to anyone who signs up, so a wildcard over one
 * of these apexes is not an allowlist — it admits every tenant of the platform.
 * Combined with `credentials: true` that lets any of them replay a signed-in
 * user's session cookie against this API.
 */
const SHARED_HOSTING_APEXES = [
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'herokuapp.com',
  'onrender.com',
  'web.app',
  'firebaseapp.com',
  'github.io'
];

/**
 * Whether a wildcard pattern leans on a domain the operator does not control.
 *
 * A wildcard is safe over an apex you own — `https://*.alpha.example.com` can
 * only ever be issued by you. Over a shared apex it is safe only if the literal
 * part of the pattern pins something you control: Vercel URLs end in
 * `-<team-slug>.vercel.app`, so `https://alpha-fe-main-*-myteam.vercel.app`
 * still requires an attacker to publish under your team.
 *
 * Measured as literal characters rather than by parsing the platform's URL
 * format, because every platform's format is different and changes. Six is
 * enough to rule out a bare `*` and a token gesture like `*-app`, without
 * guessing at a scheme.
 */
function wildcardLeansOnSharedApex(pattern: string): boolean {
  const host = pattern.replace(/^[a-z]+:\/\//i, '').split('/')[0].toLowerCase();
  const apex = SHARED_HOSTING_APEXES.find(a => host === `*.${a}` || host.endsWith(`.${a}`));
  if (!apex) return false;

  const subdomain = host.slice(0, Math.max(0, host.length - apex.length - 1));
  const literal = subdomain.replaceAll('*', '').replace(/[^a-z0-9]/g, '');
  return literal.length < 6;
}

/**
 * One entry of the allowlist, as a matcher.
 *
 * `*` stands for exactly one host label — it expands to `[^.]+`, and the
 * pattern is anchored — so `https://*.example.com` cannot be satisfied by
 * `evil.example.com.attacker.net` or by a deeper subdomain.
 *
 * That containment is about the shape of the match. It says nothing about who
 * can obtain a matching name, which is the question that actually decides
 * whether an origin is trustworthy — see `wildcardLeansOnSharedApex`.
 */
function originMatcher(pattern: string): (origin: string) => boolean {
  if (pattern === '*') {
    // `credentials: true` plus a total wildcard is the classic CORS hole, and
    // browsers reject the combination anyway. Refuse rather than appear to work.
    logOriginRefusal(pattern, 'a bare "*" cannot be combined with credentials');
    return () => false;
  }
  if (!pattern.includes('*')) return origin => origin === pattern;

  if (wildcardLeansOnSharedApex(pattern)) {
    logOriginRefusal(
      pattern,
      'a wildcard over a shared hosting apex admits every tenant of that platform. ' +
        'Pin a label you control (https://myapp-*-myteam.vercel.app) or list the exact origin'
    );
    return () => false;
  }

  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('[^.]+');
  const re = new RegExp(`^${source}$`);
  return origin => re.test(origin);
}

/**
 * Refusals are announced, not silent.
 *
 * An operator who sets a pattern that is dropped would otherwise see only a
 * browser CORS error with nothing in the server log pointing at the cause.
 */
const refusedOrigins: Array<{ pattern: string; reason: string }> = [];
function logOriginRefusal(pattern: string, reason: string): void {
  refusedOrigins.push({ pattern, reason });
}

/** Origin patterns that were dropped as unsafe, for the startup banner. */
export function unsafeOriginPatterns(): ReadonlyArray<{ pattern: string; reason: string }> {
  return refusedOrigins;
}

const ORIGIN_MATCHERS = ALLOWED_ORIGINS.map(originMatcher);

/** Whether this `Origin` header may call the API. */
export function isAllowedOrigin(origin: string): boolean {
  return ORIGIN_MATCHERS.some(match => match(origin));
}

/**
 * Key for encrypting stored GitHub tokens, and for nothing else.
 *
 * A session row holds a `repo`-scoped GitHub token. In plaintext that makes
 * the database a credential store: read access to one file or one backup is
 * read/write access to every private repository in the organisation. Encrypted
 * at rest, a leaked database is inert without this value, which lives only in
 * the process environment.
 *
 * Required in cloud mode — the daemon refuses to start without it rather than
 * quietly writing tokens in the clear. Unused on the desktop, which has no
 * sessions: there, `gh` holds the credential in the OS keyring where it
 * belongs.
 */
export const ALPHA_SESSION_SECRET = process.env.ALPHA_SESSION_SECRET || '';

/**
 * How long a browser session lasts before re-authentication.
 *
 * Seven days by default: long enough that a PM checking the board twice a week
 * is not re-authenticating every visit, short enough that a stolen cookie is
 * not indefinite. Sessions are revocable regardless, so this is the ceiling on
 * an unnoticed compromise rather than the only defence.
 */
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);

/**
 * The Supabase project's JWT secret, for signing database tokens.
 *
 * Symmetric: Render signs, Supabase verifies, and the secret never leaves the
 * server. Found in the Supabase dashboard under Settings → API. Distinct from
 * ALPHA_SESSION_SECRET, which encrypts stored GitHub tokens and is Alpha's
 * own — mixing them would mean one leak compromised both.
 *
 * Cloud only. Minting refuses to run on the desktop even when this is set:
 * anyone holding it can sign any role for any workspace. The desktop gets its
 * token from the cloud instead -- see ALPHA_CLOUD_API.
 */
export const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

/**
 * How long a database token is good for.
 *
 * Minutes, not days. Unlike a session this cannot be revoked — nothing checks
 * a blocklist on every row read — so its lifetime is the only bound on a
 * leaked one. Ten minutes is long enough to cover a page's work and short
 * enough that a copied token is stale before it is useful.
 */
export const SUPABASE_TOKEN_TTL_MS = Number(process.env.SUPABASE_TOKEN_TTL_MS || 10 * 60 * 1000);

/**
 * The cloud's own connection to Postgres: Supabase's session-pooler URL, with
 * the database password in it. Cloud only, and required there -- `index.ts`
 * refuses to start without it, because the alternative is state on Render's
 * disk, which every deploy and every free-tier spin-down replaces.
 *
 * Never on a developer's machine. The password connects as the tables' owner,
 * which row-level security does not restrict: holding it is holding every
 * workspace's data. The desktop reaches Postgres only through the Data API,
 * with a short-lived token the cloud minted for one login. `database()` refuses
 * to open a connection outside cloud mode, and the desktop build's settings
 * allowlist does not carry this value.
 */
export const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

/**
 * The certificate authority that signed the database's TLS certificate, as
 * PEM. Required with DATABASE_URL. Supabase's is downloadable from the
 * dashboard: Database settings → SSL Configuration.
 *
 * The connection carries the database password, so the server has to prove it
 * is the database before that is sent. Supabase signs its pooler certificates
 * with its own root, which is not in Node's trust store -- so without this
 * value the only way to connect would be to skip verification, and a
 * connection that skips it hands the password to anyone who can sit in the
 * path. There is no such fallback: no authority, no connection.
 *
 * Literal `\n` sequences are read as newlines, for hosts whose settings pages
 * take one line.
 */
export const DATABASE_CA_CERT = process.env.DATABASE_CA_CERT || '';

/**
 * Connections the cloud holds open at once. Small, because Supabase's free
 * tier caps the pooler's clients per project and one Render instance does not
 * need many.
 */
export const DATABASE_POOL_MAX = Number(process.env.DATABASE_POOL_MAX || 5);

// Supabase Configuration (team / cloud mode)
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

/**
 * Where the desktop asks for its database token: the cloud API's base URL,
 * e.g. `https://alpha-fe-main.vercel.app/api`. Desktop only.
 *
 * The desktop used to mint its own token with SUPABASE_JWT_SECRET, which put
 * the signing secret on every developer's machine -- and whoever holds it can
 * sign any role for any workspace, which makes every policy advisory. Now the
 * desktop proves who it is with its `gh` login and the cloud decides the role.
 *
 * The Vercel origin rather than Render's own hostname: the rewrite there
 * reaches Render from networks that cannot reach it directly.
 */
export const ALPHA_CLOUD_API = (process.env.ALPHA_CLOUD_API || '').trim().replace(/\/+$/, '');

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
 *
 * No default at all now: it names one deployment's hostname, and a guessed one
 * sends GitHub's redirect somewhere the cookie cannot follow. Unset, sign-in
 * reports itself as not configured rather than offering a link that breaks.
 */
export const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || '';
export const GITHUB_SCOPE = process.env.GITHUB_SCOPE || 'repo,workflow,read:org';

// GitHub App Configuration
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
export const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '';
export const GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET || '';
/**
 * The App's URL name, from `github.com/apps/<slug>`. No default: the old one
 * named an App that does not exist, so an unset value sent people to a 404.
 */
export const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || '';
