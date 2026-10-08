import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createSupabaseTestDatabase } from '../store/testDatabase.js';

// Synthetic local Postgres only. Never connects to hosted Supabase.
const root = resolve(__dirname, '../../supabase-staging');
const manifest = JSON.parse(readFileSync(resolve(root, 'baseline-manifest.json'), 'utf8')) as { localFile: string };
const baseline = readFileSync(resolve(root, manifest.localFile), 'utf8');
const migrationDir = resolve(root, 'supabase/migrations');
const candidates = readdirSync(migrationDir).filter(name => /^\d{14}_pin_project_owner_search_path\.sql$/.test(name));
if (candidates.length !== 1) throw new Error('Expected one tracked project-owner hardening migration');
const hardening = readFileSync(resolve(migrationDir, candidates[0]), 'utf8');
const catalog = readFileSync(resolve(root, 'catalog.sql'), 'utf8');
const access = readFileSync(resolve(root, 'access.sql'), 'utf8');
const metadata = `select oid::text oid,prosrc body,prosecdef definer,proacl::text acl,
  proowner::text owner,proconfig configuration from pg_proc
  where oid='alpha.keep_project_owner()'::regprocedure`;
type GuardMetadata = {
  oid: string; body: string; definer: boolean; acl: string | null;
  owner: string; configuration: string[] | null;
};
let db: PGlite;

beforeAll(async () => {
  db = await createSupabaseTestDatabase();
  await db.exec('begin');
  try { await db.exec(baseline); await db.exec('commit'); }
  catch (error) { await db.exec('rollback'); throw error; }
});
afterAll(async () => { await db?.close(); });

async function rehearsal(work: () => Promise<void>) {
  await db.exec('begin');
  try { await work(); } finally { await db.exec('rollback'); }
}
async function syntheticProject() {
  await db.exec(`insert into public.workspaces(id,name,slug) values ('hardening-ws','Synthetic','hardening-ws');
    insert into public.projects(id,workspace_id,name,key,created_by)
    values ('hardening-project','hardening-ws','Synthetic','HARDENING','synthetic-pm');`);
}

describe('staging project-owner guard hardening', () => {
  it('pins only the search path, preserving identity, body, grants, owner and invoker mode', async () => {
    await rehearsal(async () => {
      const before = (await db.query<GuardMetadata>(metadata)).rows[0];
      await db.exec(hardening);
      const after = (await db.query<GuardMetadata>(metadata)).rows[0];
      expect(before.configuration).toBeNull();
      expect(after).toEqual({ ...before, configuration: ['search_path=""'] });
      expect(after.definer).toBe(false);
    });
  });

  it('changes exactly one catalog entry and no effective table/schema permissions', async () => {
    await rehearsal(async () => {
      const before = (await db.query<{ kind: string; name: string; fingerprint: string }>(catalog)).rows;
      const permissions = (await db.query(access)).rows;
      await db.exec(hardening);
      const after = (await db.query<{ kind: string; name: string; fingerprint: string }>(catalog)).rows;
      expect(after).toHaveLength(before.length);
      expect(after.filter((row, i) => row.fingerprint !== before[i].fingerprint)
        .map(row => `${row.kind}:${row.name}`)).toEqual(['function:alpha.keep_project_owner()']);
      expect((await db.query(access)).rows).toEqual(permissions);
    });
  });

  it('allows ordinary edits and an unchanged owner under a caller-controlled search path', async () => {
    await rehearsal(async () => {
      await db.exec(hardening);
      await syntheticProject();
      await db.exec('create schema untrusted_caller; set local search_path=untrusted_caller,public');
      await db.exec(`update public.projects set name='Edited',created_by='synthetic-pm' where id='hardening-project'`);
      expect((await db.query("select name,created_by from public.projects where id='hardening-project'")).rows[0])
        .toEqual({ name: 'Edited', created_by: 'synthetic-pm' });
      expect((await db.query('show search_path')).rows[0]).toEqual({ search_path: 'untrusted_caller, public' });
    });
  });

  it.each(["'different-pm'", 'null'])('still rejects changing an existing owner to %s', async owner => {
    await rehearsal(async () => {
      await db.exec(hardening);
      await syntheticProject();
      await db.exec('set local search_path=pg_temp,public');
      await expect(db.exec(`update public.projects set created_by=${owner} where id='hardening-project'`))
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  it('rolls back hardening when a later statement fails', async () => {
    const before = (await db.query<GuardMetadata>(metadata)).rows[0];
    await rehearsal(async () => {
      await expect(db.exec(hardening + '\nselect missing_hardening_rehearsal_function();')).rejects.toThrow();
    });
    expect((await db.query(metadata)).rows[0]).toEqual(before);
  });
});
