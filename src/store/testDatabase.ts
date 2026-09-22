import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

import { DatabaseError, type Sql } from './database.js';

/**
 * A real Postgres for tests: PGlite, with every migration applied.
 *
 * PGlite is Postgres compiled to WebAssembly -- the real planner, the real
 * constraints and the real policy machinery, with no container to start. The
 * stores' SQL runs against the same tables production has, so a statement
 * that names a column the migrations never created fails here, not on Render.
 *
 * Test support only; nothing the server runs imports it.
 */

const MIGRATIONS = path.resolve(__dirname, '../../supabase/migrations');

/**
 * What Supabase provides that plain Postgres does not, and the migrations
 * lean on by name.
 *
 * `auth.jwt()` reads a one-row table, so a test can swap the caller's claims
 * between statements -- the policies are functions of the token. `realtime`
 * is the surface 0006 writes its policies on: a private channel's joins and
 * sends are checked as SELECT and INSERT on `realtime.messages`, with the
 * channel name in `realtime.topic()`.
 */
const SUPABASE_STUBS = `
  create schema if not exists auth;
  create table auth._claims (v jsonb);
  insert into auth._claims values ('{}'::jsonb);
  create function auth.jwt() returns jsonb
    language sql stable as $$ select v from auth._claims limit 1 $$;

  create role anon nologin;
  create role authenticated nologin;

  create schema if not exists realtime;
  create table realtime.messages (
    topic text not null,
    extension text not null,
    event text,
    payload jsonb,
    private boolean default true
  );
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text
    language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
`;

/** A fresh database, migrated. Close it in `afterAll`. */
export async function createTestDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  // Every migration, in order -- a hard-coded list silently skips the next one.
  for (const file of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

/**
 * The test database, as the stores see a connection.
 *
 * Failures are wrapped exactly as the production pool wraps them. PGlite
 * reports the same `code`, `detail` and `constraint` as `pg`, so a test can
 * exercise what the API answers for a duplicate or an outage -- which it
 * cannot if the harness throws a different shape than the real thing.
 */
export function sqlFor(db: PGlite): Sql {
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      try {
        const result = await db.query<T>(text, [...params]);
        return { rows: result.rows };
      } catch (err) {
        throw new DatabaseError(err);
      }
    }
  };
}
