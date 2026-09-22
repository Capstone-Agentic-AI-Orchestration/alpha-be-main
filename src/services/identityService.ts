import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ALPHA_ORG, ALPHA_ADMINS } from '../config/env.js';
import { logInfo, logError } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

import { ghEnvironment } from './alphaGitHubToken.js';

/**
 * Who is using this copy of Alpha.
 *
 * There was no answer to that question. `currentUser` in the browser is
 * `users.find(u => u.role === role)` over a mock array, so "who am I" was
 * whichever role the picker was on — which is why an issue could not record who
 * created it and "My Issues" had to fall back to "has any assignee".
 *
 * The real answer is already on the machine: `gh` is signed in, and its login
 * is the same identity the org, the teams and every pull request use. Reading
 * it here means Alpha and GitHub agree about who you are before any of the
 * collaboration work starts.
 *
 * ## Why cached
 *
 * `gh api user` is a subprocess, several hundred milliseconds. An issue create
 * cannot pay that, and the answer changes about as often as someone signs out.
 * Resolved once and reused; `refreshIdentity()` exists for after a sign-in.
 *
 * ## Why there is a fallback
 *
 * A machine with no `gh`, or a signed-out one, still has a person at it. The OS
 * username is a worse identity but a true one, and it is marked as such so the
 * UI can say "local" rather than implying a GitHub account that is not there.
 */

export type IdentitySource = 'github' | 'local';

/**
 * Which Alpha role a set of GitHub teams implies.
 *
 * The role model already existed — `client | dev | pm | admin`, with a
 * capability matrix and per-role navigation — driven by a picker over mock
 * users. So "who am I" was whichever entry the switcher was on, and the
 * capabilities it gated were decorative.
 *
 * Your org already answers it: `project-managers` and `developers` exist with
 * real people in them. Reading membership makes the existing matrix mean
 * something without inventing a second permission system beside GitHub's.
 *
 * Matched on the team slug rather than a stored mapping, because the slug is
 * what the org actually has and a mapping table would be one more thing to keep
 * in step with it.
 */
const TEAM_ROLES: Array<{ match: RegExp; role: AlphaRole }> = [
  /**
   * No team mapped to `admin`, so the role was unreachable: `workspace.
   * manage_members` and `agent.manage` were capabilities nobody could hold.
   * The only thing that ever granted admin was the `?? 'admin'` fallback in
   * workspaceRegistry.ensureMember, which granted it to everyone — removed in
   * this same change, because the two defects were cancelling each other out.
   *
   * Listed first for readability only. `roleFromTeams` takes the highest
   * ROLE_RANK across all matching teams, so order here carries no meaning:
   * someone in both `developers` and `admins` resolves to admin either way.
   *
   * The team does not exist in the organisation yet. Until it is created this
   * entry simply never matches, which is why ALPHA_ADMINS below exists.
   */
  { match: /^(admins?|administrators?)$/i, role: 'admin' },
  { match: /^(project-managers?|pms?|product)$/i, role: 'pm' },
  { match: /^(developers?|devs?|engineering)$/i, role: 'dev' },
  { match: /^(clients?|stakeholders?)$/i, role: 'client' }
];

/** Ordered least to most privileged, so the strongest membership wins. */
const ROLE_RANK: Record<AlphaRole, number> = { client: 0, dev: 1, pm: 2, admin: 3 };

export type AlphaRole = 'client' | 'dev' | 'pm' | 'admin';

export interface TeamMembership {
  org: string;
  slug: string;
}

/**
 * The role these memberships imply, or undefined when none of them say.
 *
 * Undefined rather than a default: "we could not tell" and "you are a
 * developer" are different answers, and only the caller knows which fallback
 * is right for the surface it is drawing.
 */
export function roleFromTeams(teams: TeamMembership[], workspaceOrg?: string): AlphaRole | undefined {
  /**
   * Only the workspace's own teams.
   *
   * A GitHub account belongs to every org its owner has ever joined — this one
   * is in ten, holding `developer` in one sandbox, `product-owner` in another
   * and `project-managers` in the workspace that matters. Pooling them picks
   * whichever rank happens to be highest, which answered `pm` here by luck and
   * would answer `dev` for someone whose sandbox membership outranked their
   * real one.
   *
   * Without a workspace to scope by there is no answer worth giving, so none is
   * given.
   */
  if (!workspaceOrg) return undefined;

  const scoped = teams.filter(t => t.org.toLowerCase() === workspaceOrg.toLowerCase());

  let best: AlphaRole | undefined;
  for (const team of scoped) {
    const hit = TEAM_ROLES.find(r => r.match.test(team.slug));
    if (hit && (!best || ROLE_RANK[hit.role] > ROLE_RANK[best])) best = hit.role;
  }
  return best;
}

/**
 * The organisation this installation works in.
 *
 * Configuration now, not inference. This used to count `githubOrg` across
 * existing projects and take the majority, which had two defects that only
 * showed up together:
 *
 *  1. It was circular on a fresh install. Resolving an org needed a project,
 *     creating a project needed a role, and a role needed an org. A brand new
 *     deployment could never leave that loop.
 *  2. The `undefined` it returned in that state silently disabled the access
 *     gate below — `workspaceOrg && !role` is false when there is no org — so
 *     every signed-in account was granted, and then handed `admin` by the
 *     `?? 'admin'` default in workspaceRegistry.ensureMember.
 *
 * Alpha serves exactly one organisation, so the org is a deployment fact. It
 * belongs in the environment beside the GitHub App that reads that org's teams.
 */
function resolveWorkspaceOrg(): string {
  return ALPHA_ORG;
}

/** Teams the signed-in account belongs to. Empty when GitHub is unreachable. */
async function fetchTeams(): Promise<TeamMembership[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', 'user/teams', '--paginate', '--jq', '.[] | .organization.login + "/" + .slug'],
      { timeout: 15_000, env: ghEnvironment() }
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [org, slug] = line.split('/');
        return { org, slug };
      });
  } catch {
    // Not signed in, no read:org scope, or offline. A role of undefined is the
    // honest result; the caller decides what to show.
    return [];
  }
}

/**
 * Break-glass admin, by GitHub login.
 *
 * The `admins` team in TEAM_ROLES is the real mechanism and the one to use.
 * This exists because that team does not exist yet, and the change that adds
 * it also removes the `?? 'admin'` default that was the only thing granting
 * admin before — leaving a window in which the organisation has no
 * administrator at all and nobody can add members or manage agents.
 *
 * It is also the way back in when GitHub itself is the problem: team deleted,
 * org restrictions revoked, a token that cannot read teams. A permission
 * system whose only recovery path runs through the thing that broke is not a
 * recovery path.
 *
 * Deliberately env-only and unset by default. Once the `admins` team exists,
 * clear ALPHA_ADMINS and this returns undefined for everyone.
 */
function breakGlassAdmin(login: string): AlphaRole | undefined {
  const allowed = ALPHA_ADMINS.map(l => l.toLowerCase());
  return allowed.includes(login.toLowerCase()) ? 'admin' : undefined;
}

/**
 * Team memberships over the REST API, for a token rather than for `gh`.
 *
 * `fetchTeams()` shells out to the CLI, which is right on a workstation and
 * impossible in a container: there is no `gh`, and no single signed-in user
 * for it to be. A browser session has an OAuth token instead, and this is the
 * same question asked with it.
 *
 * Paginated because `per_page` caps at 100 and an account in many
 * organisations will exceed that — this one is already in sixteen teams across
 * six orgs. Stopping at the first page would silently drop memberships and
 * hand somebody a lower role than they hold, or none.
 */
export async function fetchTeamsWithToken(token: string): Promise<TeamMembership[]> {
  const teams: TeamMembership[] = [];

  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/user/teams?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'alpha-orchestrator'
      }
    });
    if (!res.ok) {
      /**
       * Not fatal, and not silently empty either.
       *
       * A 403 here usually means the organisation has third-party application
       * restrictions and has not approved this app — in which case every
       * member resolves to no role and is refused, and the only way to tell
       * that apart from "genuinely in no team" is this line.
       */
      logError(`GitHub team lookup failed (${res.status}) — roles cannot be resolved from teams.`);
      break;
    }

    const batch = (await res.json()) as Array<{ slug: string; organization: { login: string } }>;
    for (const team of batch) {
      if (team?.slug && team.organization?.login) {
        teams.push({ org: team.organization.login, slug: team.slug });
      }
    }
    if (batch.length < 100) break;
  }

  return teams;
}

/**
 * The Alpha role for a login and its team memberships.
 *
 * Shared by both identity paths so they cannot drift: the desktop resolves it
 * from `gh`, a browser session from an OAuth token, and both must agree about
 * what a given set of teams means. Break-glass is checked first for the same
 * reason it is in `resolve()` — the failure it recovers from includes reading
 * teams.
 */
export function roleForLogin(login: string, teams: TeamMembership[]): AlphaRole | undefined {
  return breakGlassAdmin(login) ?? roleFromTeams(teams, ALPHA_ORG);
}

export interface Identity {
  /** GitHub login, or the OS username when GitHub is unavailable. */
  login: string;
  /** Display name when GitHub supplies one. */
  name?: string;
  source: IdentitySource;
  /** Every team this account belongs to, across organisations. */
  teams: TeamMembership[];
  /**
   * The role those teams imply, or undefined when nothing said.
   *
   * Undefined is a real answer — no GitHub, no matching team, or an org whose
   * teams are named something this does not recognise. The UI falls back
   * rather than being handed a role that was guessed.
   */
  role?: AlphaRole;
  /**
   * The organisation this installation's projects belong to.
   *
   * Read from the projects rather than configured: they already record a
   * `githubOrg`, and the org their repositories live in is what a workspace
   * means today. Undefined when nothing is attached yet.
   */
  workspaceOrg?: string;
  /**
   * Whether this person may use Alpha at all.
   *
   * `no_team` is the one situation worth refusing: a GitHub account, in a known
   * workspace organisation, belonging to no team that grants a role. The three
   * other ways a role can be absent are not refusals —
   *
   *   - identity still resolving, which would flash a lockout on every boot
   *   - no GitHub sign-in, which is solo use and Alpha's original mode
   *   - no workspace organisation yet, which is a fresh install
   *
   * Decided here because the daemon is what can tell those apart. Leaving the
   * UI to infer it from a missing role would collapse all four into one.
   */
  access: 'granted' | 'no_team';
  /**
   * Why GitHub is unavailable, when it is.
   *
   * `missing` and `signed_out` need different things from the person — one
   * installs a tool, the other runs a command — and a packaged app that says
   * only "no GitHub" leaves them to guess which. A teammate who downloads the
   * installer and nothing else lands squarely in `missing`, because `gh` is not
   * bundled and every GitHub call in the daemon shells out to it.
   */
  github: 'ok' | 'missing' | 'signed_out';
}

let cached: Identity | null = null;
let inFlight: Promise<Identity> | null = null;

/**
 * Why `gh` did not answer, set by the last resolve.
 *
 * Held here rather than passed around because `localIdentity` is the fallback
 * for several different failures and the reason is what the UI needs.
 */
let githubState: 'ok' | 'missing' | 'signed_out' = 'signed_out';

/** The OS user, as the last honest answer. */
function localIdentity(): Identity {
  let login = 'local';
  try {
    login = os.userInfo().username || 'local';
  } catch {
    // Some sandboxes have no passwd entry. 'local' is still true enough.
  }
  // No GitHub means no teams, so no role. Not 'client', not 'dev' — unknown.
  return { login, source: 'local', teams: [], access: 'granted', github: githubState };
}

async function resolve(): Promise<Identity> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login + "\\t" + (.name // "")'], {
      // A hung `gh` must not hold up the first issue anyone creates.
      timeout: 10_000,
      // As Alpha's own account, not whichever one the terminal is signed into.
      env: ghEnvironment()
    });
    const [login, name] = stdout.trim().split('\t');
    if (login) {
      const workspaceOrg = resolveWorkspaceOrg();
      const teams = await fetchTeams();
      const scopedTeams = teams.filter(t => t.org.toLowerCase() === workspaceOrg.toLowerCase());
      /**
       * Break-glass first, so it still works when team reads are the failure.
       * An allowlisted login that cannot reach GitHub's team API would
       * otherwise resolve to no role and be refused by the gate below — which
       * is exactly the situation the break-glass is for.
       */
      const role = breakGlassAdmin(login) ?? roleFromTeams(teams, workspaceOrg);
      logInfo(
        `Alpha identity: ${login} (github)` +
          (workspaceOrg ? `, workspace ${workspaceOrg}` : ', no workspace org') +
          (role ? `, role ${role}` : ', no role')
      );
      /**
       * Strict: only a team that maps to a role counts.
       *
       * An organisation with exactly two teams by design has no third answer,
       * and someone in an unrecognised team receiving a default role is how
       * permissions arrive that nobody granted. The cost is that adding a team
       * later needs a line in TEAM_ROLES — a loud failure rather than a quiet
       * one, which is the intended trade.
       */
      /**
       * Now a real gate, where it used to be unreachable.
       *
       * The old expression was `workspaceOrg && !role`, and `workspaceOrg` was
       * inferred from project rows — so on any install without projects it was
       * undefined, the whole condition was false, and access was granted to
       * anyone `gh` could name. With ALPHA_ORG pinned this is simply `!role`.
       *
       * The cost is real and intended: an organisation member who belongs to no
       * team that maps to a role is refused. Adding them to a team is the fix,
       * and a loud refusal is better than a quiet grant of permissions nobody
       * issued.
       *
       * One caveat this cannot yet tell apart: `fetchTeams()` also returns []
       * when the token lacks `read:org`, or when the organisation has
       * third-party application restrictions and has not approved this app. A
       * whole org would then be refused as "no team". The GitHub App in the
       * next change reads team membership as an installation rather than as the
       * user, which removes that failure mode; until then the log line below is
       * the only way to tell the two apart.
       */
      const access = role ? ('granted' as const) : ('no_team' as const);
      if (!role) {
        logInfo(
          `No role for ${login} in ${workspaceOrg}: ${scopedTeams.length} team(s) matched. ` +
            (scopedTeams.length === 0
              ? 'Either they are in no team, or this token cannot read org teams.'
              : `Teams found: ${scopedTeams.map(t => t.slug).join(', ')} — none maps to a role.`)
        );
      }

      githubState = 'ok';
      return { login, name: name || undefined, source: 'github', teams, role, workspaceOrg, access, github: 'ok' };
    }
  } catch (err: any) {
    /**
     * Missing and signed-out are different problems.
     *
     * ENOENT means the binary is not there — the state a teammate who installed
     * only the packaged app is in, since `gh` is not bundled. Anything else
     * means `gh` ran and refused, which is a sign-in.
     */
    const notFound =
      err?.code === 'ENOENT' ||
      /not recognized as an internal|command not found|No such file or directory/i.test(
        `${err?.stderr ?? ''} ${err?.message ?? ''}`
      );
    githubState = notFound ? 'missing' : 'signed_out';
    logInfo(`GitHub identity unavailable (${githubState}); using the OS user.`);
  }

  const local = localIdentity();
  logInfo(`Alpha identity: ${local.login} (local)`);
  return local;
}

/**
 * The current identity, resolved once.
 *
 * Concurrent callers share one lookup rather than each spawning `gh` — a
 * cold start that creates several issues at once would otherwise fire several
 * subprocesses for the same answer.
 */
export async function currentIdentity(): Promise<Identity> {
  if (cached) return cached;
  inFlight ??= resolve().then(identity => {
    cached = identity;
    inFlight = null;
    return identity;
  });
  return inFlight;
}

/**
 * The identity if it is already known, without waiting.
 *
 * For paths that cannot be async and must not block — a synchronous write that
 * would rather record nothing than stall. Returns undefined until the first
 * `currentIdentity()` has resolved, which `warmIdentity()` does at boot.
 */
export function knownIdentity(): Identity | undefined {
  return cached ?? undefined;
}

/** Resolve at startup so the synchronous accessor is populated before use. */
export function warmIdentity(): void {
  currentIdentity().catch(err => logError('Identity resolution failed:', err));
}

/** Forget the cached answer, for after a sign-in or sign-out. */
export function refreshIdentity(): Promise<Identity> {
  cached = null;
  inFlight = null;
  return currentIdentity();
}
