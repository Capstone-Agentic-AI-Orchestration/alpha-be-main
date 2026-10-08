import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';

import { createSupabaseTestDatabase } from '../store/testDatabase.js';

// Local Postgres rehearsal only. Provider products remain stubs, not evidence
// of working hosted Auth, Storage, email or recovery coverage.
const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../supabase-staging/baseline-manifest.json'), 'utf8')) as {
  localFile: string; sha256: string; normalizedRemoteMd5: string; targetProject: string; sourceProject: string;
};
const source = readFileSync(resolve(__dirname, '../../supabase-staging', manifest.localFile), 'utf8');
const catalogQuery = readFileSync(resolve(__dirname, '../../supabase-staging/catalog.sql'), 'utf8');
const expectedCatalog = JSON.parse(readFileSync(resolve(__dirname, '../../supabase-staging/live-catalog.json'), 'utf8')) as {
  objects: { kind: string; name: string; fingerprint: string }[];
};
let db: PGlite;

beforeAll(async () => {
  db = await createSupabaseTestDatabase();
  await db.exec('begin');
  try { await db.exec(source); await db.exec('commit'); }
  catch (error) { await db.exec('rollback'); throw error; }
});
afterAll(async () => { await db?.close(); });

describe('approved deployed-baseline rehearsal', () => {
  it('pins the observed staging version and exact reviewed SQL without aliasing live', () => {
    expect(manifest.targetProject).toBe('pvbppmajgsbkrnvxlzrn');
    expect(manifest.targetProject).not.toBe(manifest.sourceProject);
    expect(createHash('sha256').update(source).digest('hex')).toBe(manifest.sha256);
    const normalized = source.replaceAll('\r\n', '\n').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
    expect(createHash('md5').update(normalized).digest('hex')).toBe(manifest.normalizedRemoteMd5);
  });

  it('matches the captured live application catalog, not just the migration ledger', async () => {
    const actual = (await db.query<{ kind: string; name: string; fingerprint: string }>(catalogQuery)).rows;
    const expected = new Map(expectedCatalog.objects.map(row => [`${row.kind}:${row.name}`, row.fingerprint]));
    const changed = actual.filter(row => expected.get(`${row.kind}:${row.name}`) !== row.fingerprint).map(row => `${row.kind}:${row.name}`);
    const observed = new Set(actual.map(row => `${row.kind}:${row.name}`));
    const missing = [...expected.keys()].filter(key => !observed.has(key));
    expect({ changed, missing, count: actual.length }).toEqual({ changed: [], missing: [], count: expected.size });
  });

  it('reconstructs 21 application tables with RLS, without later pending migrations', async () => {
    const { rows } = await db.query<{ schema_name: string; table_name: string; rls: boolean }>(`
      select n.nspname schema_name,c.relname table_name,c.relrowsecurity rls
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','alpha','alpha_private') and c.relkind in ('r','p')
      order by 1,2
    `);
    expect(rows).toHaveLength(21);
    expect(rows.every(table => table.rls)).toBe(true);
    expect(rows).toContainEqual({ schema_name: 'alpha_private', table_name: 'sessions', rls: true });
    expect((await db.query("select to_regclass('alpha_private.hosting_audit') absent")).rows[0]).toEqual({ absent: null });
    const policies = (await db.query<{ policyname: string }>("select policyname from pg_policies where schemaname='public' and tablename='agents'")).rows.map(row => row.policyname);
    expect(policies).toContain('developers add agents');
    expect(policies).not.toContain('internal members add agents');
  });

  it('contains only the 15 reviewed source migrations and no records/secrets export', () => {
    const versions = [...source.matchAll(/^-- Recorded source: (\d{14}) /gm)].map(match => match[1]);
    expect(versions).toHaveLength(15);
    expect(new Set(versions).size).toBe(15);
    expect(versions[0]).toBe('20260921145036');
    expect(versions.at(-1)).toBe('20260924151814');
    expect(source).not.toMatch(/^\s*(copy\s|insert\s+into\s+(?:auth\.|storage\.|workspaces\b|workspace_members\b))/im);
    expect(source).not.toMatch(/\b(?:service_role_key|sb_secret_|SUPABASE_ACCESS_TOKEN)\b/);
  });

  it('starts with empty application records rather than copying live identities or projects', async () => {
    for (const table of ['workspaces', 'workspace_members', 'projects', 'issues', 'alpha_private.sessions']) {
      expect((await db.query(`select count(*)::int total from ${table}`)).rows[0]).toEqual({ total: 0 });
    }
  });

  it('refuses replay over existing work and leaves the original schema intact', async () => {
    await db.exec('begin');
    try { await expect(db.exec(source)).rejects.toThrow(/requires empty application schemas/); }
    finally { await db.exec('rollback'); }
    expect((await db.query("select to_regclass('public.projects') present")).rows[0]).toEqual({ present: 'projects' });
  });

  it('rolls back the whole fresh baseline if a later statement fails', async () => {
    const fresh = await createSupabaseTestDatabase();
    try {
      await fresh.exec('begin');
      await expect(fresh.exec(source + '\nselect missing_baseline_verification_function();')).rejects.toThrow();
      await fresh.exec('rollback');
      expect((await fresh.query("select to_regclass('public.projects') present")).rows[0]).toEqual({ present: null });
      expect((await fresh.query("select to_regnamespace('alpha') present")).rows[0]).toEqual({ present: null });
    } finally { await fresh.close(); }
  });

  it('keeps native provider JWTs outside the internal Alpha issuer boundary', async () => {
    await db.exec('begin');
    try {
      await db.exec(`
        insert into workspaces(id,name,slug) values ('staging-test-ws','Synthetic workspace','staging-test-ws');
        grant usage on schema public,auth,alpha to authenticated;
        grant select on auth._claims to authenticated;
        grant select on public.workspaces to authenticated;
      `);
      await db.query('update auth._claims set v=$1::jsonb', [JSON.stringify({
        sub: 'synthetic-client', iss: 'https://provider.example/auth/v1',
        workspace_id: 'staging-test-ws', alpha_role: 'pm',
      })]);
      await db.exec('set local role authenticated');
      expect((await db.query('select * from public.workspaces')).rows).toHaveLength(0);
      expect((await db.query('select alpha.login() login,alpha.workspace() workspace,alpha.alpha_role() role')).rows[0])
        // Existing Alpha SQL defaults the label to "client" on absent claims;
        // a label alone must not produce a login, workspace or data access.
        .toEqual({ login: null, workspace: null, role: 'client' });
      await db.exec('reset role');
    } finally { await db.exec('rollback'); }
  });
});
