import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresWorkspaceDirectory } from './postgresWorkspaceDirectory.js';
import { SqliteWorkspaceDirectory } from './sqliteWorkspaceDirectory.js';
import type { WorkspaceDirectory } from './workspaceDirectory.js';

/**
 * One contract, two stores.
 *
 * The desktop keeps workspaces in SQLite and the cloud in Postgres, and the
 * routes above them cannot tell which they have. So the rules that decide
 * access -- who is enrolled, at what role, who may join, whose membership an
 * admin ended -- are stated once here and run against both. A rule that holds
 * on a laptop and not on Render would be a permission bug nobody sees until
 * it is in production.
 *
 * Postgres is PGlite with the real migrations: the same tables, constraints
 * and defaults Supabase has.
 */

const DEFAULT_WS = 'ws-default';

interface Backend {
  name: string;
  /** A directory over an empty store. */
  open(): Promise<WorkspaceDirectory>;
  /** Write a row the directory itself would refuse to. */
  exec(sql: string, params?: unknown[]): Promise<void>;
}

let pg: PGlite;
let tmp: string;
const openSqlite: Database.Database[] = [];

beforeAll(async () => {
  pg = await createTestDatabase();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-directory-'));
}, 60_000);

afterAll(async () => {
  for (const db of openSqlite) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  await pg?.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

let sqliteDb: Database.Database;
let pgDirectory: PostgresWorkspaceDirectory;

const backends: Backend[] = [
  {
    name: 'sqlite',
    async open() {
      sqliteDb = new Database(path.join(tmp, `ws-${openSqlite.length}.db`));
      openSqlite.push(sqliteDb);
      return new SqliteWorkspaceDirectory(sqliteDb, DEFAULT_WS);
    },
    async exec(sql, params = []) {
      sqliteDb.prepare(sql).run(...(params as never[]));
    }
  },
  {
    name: 'postgres',
    async open() {
      await pg.exec(`truncate workspaces, workspace_members, workspace_project_assignments,
                     workspace_squad_owners, workspace_squad_projects cascade`);
      // A new instance per test: the default workspace is seeded once per
      // instance, and the truncate above has just removed it.
      pgDirectory = new PostgresWorkspaceDirectory(sqlFor(pg), DEFAULT_WS);
      return pgDirectory;
    },
    async exec(sql, params = []) {
      await pg.query(sql, params as never[]);
    }
  }
];

describe.each(backends)('the workspace directory ($name)', backend => {
  it('enrols a first-time caller in the default workspace, at the role GitHub gave them', async () => {
    const directory = await backend.open();

    const workspaces = await directory.listForUser('Lloyd1020', 'dev');
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ id: DEFAULT_WS, role: 'dev', memberCount: 1 });
  });

  /**
   * `?? 'admin'` used to sit on that role, which made every account this
   * function had not seen before a workspace administrator.
   */
  it('enrols nobody without a role, rather than guessing one', async () => {
    const directory = await backend.open();

    expect(await directory.listForUser('Stranger', undefined)).toEqual([]);
    expect(await directory.resolve('Stranger')).toBeNull();
  });

  it('does not re-enrol someone whose membership was ended', async () => {
    const directory = await backend.open();
    await directory.listForUser('Lloyd1020', 'dev');
    const [member] = await directory.listMembers(DEFAULT_WS);
    await directory.updateMember(DEFAULT_WS, member.id, { status: 'removed' });

    expect(await directory.listForUser('Lloyd1020', 'dev')).toEqual([]);
  });

  it('reports what the caller may reach, in one snapshot', async () => {
    const directory = await backend.open();
    await directory.listForUser('Dev1', 'dev');
    await directory.assignProject(DEFAULT_WS, 'p1', 'Dev1');
    await directory.assignProject(DEFAULT_WS, 'p2', 'Someone-else');
    await directory.bindSquadOwner(DEFAULT_WS, 'squad-1', 'Dev1');
    await directory.assignSquadProject(DEFAULT_WS, 'squad-1', 'p1', 'assigned');

    const context = await directory.resolve('Dev1', DEFAULT_WS, 'dev');
    expect([...context!.access.assignedProjectIds]).toEqual(['p1']);
    expect(context!.access.squadOwners.get('squad-1')).toBe('Dev1');
    expect(context!.access.squadProjects).toEqual([{ squadId: 'squad-1', projectId: 'p1' }]);
    expect(context!.teamRole).toBe('dev');
  });

  it('refuses a workspace the caller does not belong to', async () => {
    const directory = await backend.open();
    await directory.listForUser('Admin1', 'admin');
    const other = await directory.createWorkspace('Admin1', { name: 'Private' });

    await directory.listForUser('Dev1', 'dev');
    expect(await directory.resolve('Dev1', other.id, 'dev')).toBeNull();
  });

  it('makes a workspace creator its admin, and keeps slugs unique', async () => {
    const directory = await backend.open();
    const first = await directory.createWorkspace('Admin1', { name: 'Team Alpha' });
    const second = await directory.createWorkspace('Admin1', { name: 'Team Alpha' });

    expect(first.slug).toBe('team-alpha');
    expect(second.slug).toBe('team-alpha-2');
    expect(first.role).toBe('admin');
    expect((await directory.listMembers(first.id))[0]).toMatchObject({ userId: 'Admin1', role: 'admin' });
  });

  /** The code is the only thing standing between an account and a workspace. */
  it('joins by invite code, and by nothing else', async () => {
    const directory = await backend.open();
    const workspace = await directory.createWorkspace('Admin1', { name: 'Team Alpha' });

    await expect(directory.joinWorkspace('Dev1', workspace.slug, 'dev')).rejects.toThrow(/invite code/);
    await expect(directory.joinWorkspace('Dev1', workspace.id, 'dev')).rejects.toThrow(/invite code/);
    await expect(directory.joinWorkspace('Dev1', 'not-a-code', 'dev')).rejects.toThrow(/invite code/);

    const joined = await directory.joinWorkspace('Dev1', workspace.joinCode!, 'dev');
    expect(joined).toMatchObject({ id: workspace.id, role: 'dev' });
  });

  it('will not let an old invite code undo a removal', async () => {
    const directory = await backend.open();
    const workspace = await directory.createWorkspace('Admin1', { name: 'Team Alpha' });
    await directory.joinWorkspace('Dev1', workspace.joinCode!, 'dev');

    const member = (await directory.listMembers(workspace.id)).find(m => m.userId === 'Dev1')!;
    await directory.updateMember(workspace.id, member.id, { status: 'removed' });

    await expect(directory.joinWorkspace('Dev1', workspace.joinCode!, 'dev')).rejects.toThrow(/removed/);
  });

  it('keeps the role an admin set when someone re-joins', async () => {
    const directory = await backend.open();
    const workspace = await directory.createWorkspace('Admin1', { name: 'Team Alpha' });
    await directory.joinWorkspace('Dev1', workspace.joinCode!, 'dev');

    const member = (await directory.listMembers(workspace.id)).find(m => m.userId === 'Dev1')!;
    await directory.updateMember(workspace.id, member.id, { role: 'pm' });

    expect(await directory.joinWorkspace('Dev1', workspace.joinCode!, 'dev')).toMatchObject({ role: 'pm' });
  });

  /** An invite code is an admin's to hand out; everyone else is shown nothing. */
  it('shows the invite code to admins only', async () => {
    const directory = await backend.open();
    const workspace = await directory.createWorkspace('Admin1', { name: 'Team Alpha' });
    const joined = await directory.joinWorkspace('Dev1', workspace.joinCode!, 'dev');

    expect(workspace.joinCode).toBeTruthy();
    expect(joined.joinCode).toBeUndefined();
    expect((await directory.listForUser('Dev1'))[0].joinCode).toBeUndefined();
  });

  it('counts only active members', async () => {
    const directory = await backend.open();
    const workspace = await directory.createWorkspace('Admin1', { name: 'Team Alpha' });
    await directory.joinWorkspace('Dev1', workspace.joinCode!, 'dev');
    expect((await directory.listForUser('Admin1'))[0].memberCount).toBe(2);

    const member = (await directory.listMembers(workspace.id)).find(m => m.userId === 'Dev1')!;
    await directory.updateMember(workspace.id, member.id, { status: 'suspended' });
    expect((await directory.listForUser('Admin1'))[0].memberCount).toBe(1);
  });

  it('assigns a project and takes it away again', async () => {
    const directory = await backend.open();
    await directory.listForUser('Dev1', 'dev');

    const assignment = await directory.assignProject(DEFAULT_WS, 'p1', 'Dev1');
    expect(assignment).toMatchObject({ projectId: 'p1', userId: 'Dev1', status: 'active' });
    expect(await directory.listProjectAssignments(DEFAULT_WS, 'p1')).toHaveLength(1);

    expect(await directory.removeProjectAssignment(DEFAULT_WS, 'p1', 'Dev1')).toBe(true);
    expect(await directory.removeProjectAssignment(DEFAULT_WS, 'p1', 'Dev1')).toBe(false);
    const context = await directory.resolve('Dev1', DEFAULT_WS, 'dev');
    expect([...context!.access.assignedProjectIds]).toEqual([]);
  });

  /**
   * One owner per squad. Ownership is what lets a developer see a squad at
   * all, so a second owner row would be a second answer to that question --
   * which is why Postgres's key had to be corrected in 0008.
   */
  it('replaces a squad owner rather than adding one', async () => {
    const directory = await backend.open();
    await directory.listForUser('Dev1', 'dev');
    await directory.bindSquadOwner(DEFAULT_WS, 'squad-1', 'Dev1');
    await directory.bindSquadOwner(DEFAULT_WS, 'squad-1', 'Dev2');

    const context = await directory.resolve('Dev1', DEFAULT_WS, 'dev');
    expect(context!.access.squadOwners.get('squad-1')).toBe('Dev2');
    expect(context!.access.squadOwners.size).toBe(1);
  });

  it('gives up the owner when a squad is deleted', async () => {
    const directory = await backend.open();
    await directory.listForUser('Dev1', 'dev');
    await directory.bindSquadOwner(DEFAULT_WS, 'squad-1', 'Dev1');
    await directory.releaseSquadOwner('squad-1');

    const context = await directory.resolve('Dev1', DEFAULT_WS, 'dev');
    expect(context!.access.squadOwners.size).toBe(0);
  });

  it('assigns a squad to a project, and removes it', async () => {
    const directory = await backend.open();
    await directory.listForUser('Dev1', 'dev');

    const assignment = await directory.assignSquadProject(DEFAULT_WS, 'squad-1', 'p1', 'owned');
    expect(assignment).toMatchObject({ squadId: 'squad-1', projectId: 'p1', relationship: 'owned' });
    expect(await directory.listSquadProjectAssignments(DEFAULT_WS, 'p1')).toHaveLength(1);

    expect(await directory.removeSquadProject(DEFAULT_WS, 'squad-1', 'p1')).toBe(true);
    expect(await directory.removeSquadProject(DEFAULT_WS, 'squad-1', 'p1')).toBe(false);
  });

  it('renames a workspace, and refuses a slug already taken', async () => {
    const directory = await backend.open();
    await directory.createWorkspace('Admin1', { name: 'Team Alpha' });
    const other = await directory.createWorkspace('Admin1', { name: 'Team Beta' });

    const renamed = await directory.updateWorkspace(other.id, { name: 'Team Gamma' }, 'admin');
    expect(renamed).toMatchObject({ name: 'Team Gamma', role: 'admin' });

    await expect(directory.updateWorkspace(other.id, { slug: 'team-alpha' }, 'admin')).rejects.toThrow(/already in use/);
    expect(await directory.updateWorkspace('no-such-workspace', { name: 'x' }, 'admin')).toBeNull();
  });
});

/**
 * A membership row whose role is not one of the four.
 *
 * Unrecognised used to read as `admin`, which is the wrong direction for a
 * value that decides access. Postgres refuses such a row outright -- its
 * column is constrained -- so the fail-closed reading only has to hold where
 * a row like this can exist at all, which is SQLite.
 */
describe('a role the directory does not recognise (sqlite)', () => {
  it('grants nothing', async () => {
    const directory = await backends[0].open();
    await directory.listForUser('Lloyd1020', 'dev');
    await backends[0].exec("UPDATE workspace_members SET role = 'superuser' WHERE user_id = 'Lloyd1020'");

    expect(await directory.listForUser('Lloyd1020')).toEqual([]);
    expect(await directory.resolve('Lloyd1020')).toBeNull();
  });

  it('is refused outright by Postgres', async () => {
    const directory = await backends[1].open();
    // Enrol properly first, so the workspace exists and only the role differs.
    await directory.listForUser('Lloyd1020', 'dev');

    await expect(
      backends[1].exec(
        `insert into workspace_members (id, workspace_id, user_id, role, status)
         values ('m1', 'ws-default', 'Someone', 'superuser', 'active')`
      )
    ).rejects.toThrow(/violates check constraint/);
  });
});
