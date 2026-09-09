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
 * The risk in that change is over-refusing. A role is absent in four
 * situations and only one of them is "GitHub answered, and the answer was
 * nobody". Refusing on a missing role instead would flash a lockout during
 * every boot, break solo offline use, and brick a fresh install with no
 * projects attached — three regressions in exchange for one fix.
 */
let tmp: string;
let opened: { close(): void }[] = [];

/** Start the daemon's identity layer with `gh` and the projects table faked. */
async function startWith(opts: {
  ghUser?: string;
  teams?: string[];
  projectOrg?: string;
  ghFails?: boolean;
}) {
  process.env.ALPHA_HOME = tmp;
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

  // --- the three that must never be refused ---

  it('grants a machine with no GitHub sign-in', async () => {
    // Solo use, and Alpha's original mode. Locking this out would make the
    // product unusable without an organisation.
    const me = await startWith({ ghFails: true, projectOrg: ORG });
    expect(me.source).toBe('local');
    expect(me.access).toBe('granted');
  });

  it('grants a fresh install with no projects attached', async () => {
    // Nothing to scope a team to yet, so there is no question to answer.
    const me = await startWith({ ghUser: 'LloydLim1', teams: [`${ORG}/project-managers`] });
    expect(me.workspaceOrg).toBeUndefined();
    expect(me.access).toBe('granted');
  });

  it('grants when GitHub is signed in but the workspace org is unknown', async () => {
    const me = await startWith({ ghUser: 'someone', teams: [] });
    expect(me.access).toBe('granted');
  });
});
