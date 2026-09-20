import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Who Alpha refuses, and — more importantly — who it must not.
 *
 * An organisation member on no team used to fall through to `pm`, the most
 * permissive role in the product, so the absence of a decision granted more
 * than any decision would have. They are now refused.
 *
 * The risk in that change is over-refusing. A role is absent in several
 * situations and only one of them is "GitHub answered, and the answer was
 * nobody". Refusing on any missing role would flash a lockout during every
 * boot and break solo offline use — regressions in exchange for one fix.
 *
 * One of those situations has since stopped existing. "A fresh install with no
 * projects attached" used to mean the workspace organisation was unknown,
 * because it was counted from project rows; that unknown org silently disabled
 * the refusal, which is how every unrecognised account was being granted. The
 * org is pinned in configuration now, so it is never unknown and a fresh
 * install is decided on teams like any other.
 */
let tmp: string;
let opened: { close(): void }[] = [];

/**
 * Start the daemon's identity layer with `gh` and the projects table faked.
 *
 * `projectOrg` seeds a project row. It used to be what decided the workspace
 * organisation — `resolveWorkspaceOrg()` counted `githubOrg` across projects —
 * and so it drove every access decision in this file. The org is now pinned in
 * configuration, so the parameter only seeds a row and no longer affects any
 * assertion here.
 */
async function startWith(opts: {
  ghUser?: string;
  teams?: string[];
  projectOrg?: string;
  ghFails?: boolean;
  /** Break-glass logins, as ALPHA_ADMINS would supply them. */
  admins?: string[];
}) {
  process.env.ALPHA_HOME = tmp;
  if (opts.admins) process.env.ALPHA_ADMINS = opts.admins.join(',');
  vi.resetModules();

  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
      ...actual,
      execFile: (cmd: string, args: string[], _o: unknown, cb: Function) => {
        if (opts.ghFails) return cb(Object.assign(new Error('not signed in'), { code: 1 }));
        const arg = args.join(' ');
        if (arg.includes('api user/teams')) return cb(null, { stdout: (opts.teams ?? []).join('\n') }, '');
        if (arg.includes('api user')) return cb(null, { stdout: `${opts.ghUser ?? 'octocat'}\t` }, '');
        return cb(null, { stdout: '' }, '');
      }
    };
  });

  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);
  if (opts.projectOrg) {
    (sql.sqliteService as any).createProject({
      id: 'p1', name: 'Repo', key: 'ALF', githubOrg: opts.projectOrg
    });
  }

  const identity = await import('./identityService.js');
  return identity.currentIdentity();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-access-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  delete process.env.ALPHA_ADMINS;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
});

const ORG = 'Capstone-Agentic-AI-Orchestration';

describe('team-based access', () => {
  it('grants a project manager', async () => {
    const me = await startWith({
      ghUser: 'LloydLim1',
      teams: [`${ORG}/project-managers`],
      projectOrg: ORG
    });
    expect(me.role).toBe('pm');
    expect(me.access).toBe('granted');
  });

  it('grants a developer', async () => {
    const me = await startWith({
      ghUser: 'ZaneZamoraC1Cs',
      teams: [`${ORG}/developers`],
      projectOrg: ORG
    });
    expect(me.role).toBe('dev');
    expect(me.access).toBe('granted');
  });

  /** The case this exists for: in the org, on no team. */
  it('refuses an organisation member on no team', async () => {
    const me = await startWith({ ghUser: 'Pineapple-2005', teams: [], projectOrg: ORG });
    expect(me.role).toBeUndefined();
    expect(me.access).toBe('no_team');
  });

  /**
   * Strict, deliberately.
   *
   * An unrecognised team granting a default role is how permissions arrive
   * that nobody assigned. The trade is that a new team needs a line in
   * TEAM_ROLES — a loud failure rather than a silent grant.
   */
  it('refuses a member of a team Alpha does not recognise', async () => {
    const me = await startWith({ ghUser: 'someone', teams: [`${ORG}/qa-team`], projectOrg: ORG });
    expect(me.access).toBe('no_team');
  });

  it('ignores teams in other organisations when deciding', async () => {
    // This account is in ten organisations; only the workspace one may decide.
    const me = await startWith({
      ghUser: 'LloydLim1',
      teams: ['St-Peter-Sandbox/developer', 'Alpha-Explora/team-lead'],
      projectOrg: ORG
    });
    expect(me.access).toBe('no_team');
  });

  // --- the ones that must never be refused ---

  it('grants a machine with no GitHub sign-in', async () => {
    // Solo use, and Alpha's original mode. Locking this out would make the
    // product unusable without an organisation.
    const me = await startWith({ ghFails: true, projectOrg: ORG });
    expect(me.source).toBe('local');
    expect(me.access).toBe('granted');
  });

  /**
   * The circular dependency, gone.
   *
   * This used to assert `workspaceOrg` was undefined here, because the org was
   * counted from project rows and a fresh install has none. That was the bug,
   * not the contract: resolving an org needed a project, creating a project
   * needed a role, and a role needed an org — a loop a new deployment could
   * never leave. Worse, the undefined org disabled the `no_team` gate, so this
   * "grant" was the hole every unknown account walked through.
   *
   * The org is configuration now, so a fresh install resolves it immediately
   * and decides on teams alone. The intent the old test protected — a fresh
   * install must not be bricked — still holds, and now holds for a better
   * reason.
   */
  it('grants a fresh install with no projects attached', async () => {
    const me = await startWith({ ghUser: 'LloydLim1', teams: [`${ORG}/project-managers`] });
    expect(me.workspaceOrg).toBe(ORG);
    expect(me.role).toBe('pm');
    expect(me.access).toBe('granted');
  });

  /**
   * Break-glass, for the window before the `admins` team exists.
   *
   * No team maps to `admin` in the organisation yet, and the change that reads
   * one also removed the `?? 'admin'` default that previously granted admin to
   * every arriving account. Without this there is no administrator at all and
   * nobody can add members.
   *
   * Checked before teams deliberately: the situation it recovers from includes
   * "team reads are what broke", so it must not depend on one succeeding.
   */
  it('grants admin to a break-glass login with no teams at all', async () => {
    const me = await startWith({ ghUser: 'LloydLim1', teams: [], admins: ['LloydLim1'] });
    expect(me.role).toBe('admin');
    expect(me.access).toBe('granted');
  });

  it('leaves everyone not named in ALPHA_ADMINS to the team rules', async () => {
    const me = await startWith({ ghUser: 'Pineapple-2005', teams: [], admins: ['LloydLim1'] });
    expect(me.role).toBeUndefined();
    expect(me.access).toBe('no_team');
  });

  it('reads the admins team as admin once it exists', async () => {
    const me = await startWith({ ghUser: 'LloydLim1', teams: [`${ORG}/admins`] });
    expect(me.role).toBe('admin');
  });

  /** Highest rank wins, so a second membership cannot demote an admin. */
  it('prefers admin over a lower role held at the same time', async () => {
    const me = await startWith({
      ghUser: 'LloydLim1',
      teams: [`${ORG}/developers`, `${ORG}/admins`]
    });
    expect(me.role).toBe('admin');
  });
});
