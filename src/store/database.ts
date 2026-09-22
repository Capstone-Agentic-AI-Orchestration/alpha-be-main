import pg from 'pg';

import { DATABASE_CA_CERT, DATABASE_POOL_MAX, DATABASE_URL, IS_CLOUD } from '../config/env.js';
import { logError } from '../utils/logger.js';

/**
 * The cloud's connection to Postgres.
 *
 * Plain SQL with numbered parameters, rather than the Supabase client, because
 * of how it can be tested. The same statements run in production through a
 * `pg` pool and in the test suite through PGlite -- the real Postgres planner,
 * against the real migrations. A client library would have to be mocked
 * there, and a mock is a test that supplies its own answers: it passes against
 * a table that does not exist.
 */

/** The part of a Postgres client the stores use. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/**
 * A database call that failed, with the driver's error kept for the log.
 *
 * The API's error handler answers a 500 with the error's own message, which
 * for a driver error names the pooler's host and the database user -- the
 * shape of the infrastructure, handed to whoever triggered the failure. This
 * carries a sentence meant for them instead, and the original for the log.
 */
export class DatabaseError extends Error {
  /** Postgres's SQLSTATE, when the server answered; absent when it could not be reached. */
  readonly sqlState?: string;

  constructor(readonly cause: unknown) {
    super('The database could not complete that request.');
    this.name = 'DatabaseError';
    const code = (cause as { code?: unknown })?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) this.sqlState = code;
  }

  /**
   * Whether the database was unreachable, rather than refusing the request.
   *
   * No SQLSTATE means the server never answered: a refused or dropped
   * connection, a timeout, a DNS failure. Class 08 is a connection failure the
   * server reported, 53 is resources exhausted (the pooler's client cap), 57
   * is an operator shutdown. All of them pass; none is the caller's fault.
   */
  get unavailable(): boolean {
    return !this.sqlState || /^(08|53|57)/.test(this.sqlState);
  }
}

/**
 * Connection settings from `DATABASE_URL`, with TLS decided here.
 *
 * The URL is taken apart rather than handed to `pg` whole, because `pg` lets
 * an `sslmode` in the URL override the `ssl` option. TLS should be one
 * decision in this file, not whatever the pasted URL happens to say -- and the
 * decision is: verified, against the authority in DATABASE_CA_CERT, or no
 * connection at all.
 */
export function poolConfig(url: string, caCert: string, max = 5): pg.PoolConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must be a postgres:// URL, not ${parsed.protocol}//.`);
  }

  const ca = caCert.replaceAll(String.raw`\n`, '\n').trim();
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      'DATABASE_CA_CERT is not set to a PEM certificate. The database connection is only made verified; ' +
        "download Supabase's from Database settings → SSL Configuration."
    );
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    // Percent-encoded in the URL: generated database passwords contain `@`, `/` and `#`.
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres',
    // Node checks the chain against `ca` and the certificate's name against `host`.
    ssl: { ca, rejectUnauthorized: true },
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  };
}

let pool: pg.Pool | null = null;

/**
 * The cloud's database. Opened on first use, so importing a module that
 * needs it costs nothing until a request does.
 *
 * Refuses outside cloud mode. This connection is the tables' owner, which
 * row-level security does not restrict, so a desktop holding it would make
 * every policy advisory. A code path that reaches here on the desktop is a
 * bug, and should fail where it can be seen.
 */
export function database(): Sql {
  if (!IS_CLOUD) {
    throw new Error(
      'Only the cloud connects to Postgres directly. The desktop reaches it through the Data API, as one signed-in user.'
    );
  }
  if (!pool) {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    pool = new pg.Pool(poolConfig(DATABASE_URL, DATABASE_CA_CERT, DATABASE_POOL_MAX));
    // An idle connection the server drops emits here. Unlistened, `pg` rethrows
    // it and takes the whole process down with it.
    pool.on('error', err => logError('A pooled database connection failed while idle:', err.message));
  }
  return fromPool(pool);
}

function fromPool(p: pg.Pool): Sql {
  return {
    async query<T>(text: string, params: readonly unknown[] = []) {
      try {
        const result = await p.query(text, [...params]);
        return { rows: result.rows as T[] };
      } catch (err) {
        throw new DatabaseError(err);
      }
    }
  };
}

/**
 * Prove the database is reachable and migrated, before accepting traffic.
 *
 * Checked at boot so a bad `DATABASE_URL` or a missing migration fails the
 * deploy -- which Render then does not promote, leaving the previous version
 * serving -- rather than passing the health check and failing each sign-in.
 */
export async function verifyDatabase(): Promise<void> {
  try {
    await database().query('select 1 from alpha_private.sessions limit 1');
  } catch (err) {
    const cause = err instanceof DatabaseError ? err.cause : err;
    const state = err instanceof DatabaseError ? err.sqlState : undefined;
    const detail = (cause as { message?: string })?.message ?? String(cause);
    const rawCode = (cause as { code?: unknown })?.code;
    const code = typeof rawCode === 'string' ? rawCode : '';
    let hint =
      'Check DATABASE_URL: it should be the Supabase session pooler URL, with the database password.';
    // 3F000 no such schema, 42P01 no such table: reachable, but not migrated.
    if (state === '3F000' || state === '42P01') {
      hint = 'The database is reachable but not migrated: apply supabase/migrations in order, through 0007.';
    } else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) {
      hint =
        "The database's certificate did not verify against DATABASE_CA_CERT. Use the certificate from " +
        "Supabase's Database settings → SSL Configuration, and the pooler's hostname in DATABASE_URL.";
    }
    throw new Error(`${hint} (${detail})`);
  }
}

/** For tests, and a clean shutdown. */
export async function closeDatabase(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}
