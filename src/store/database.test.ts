import { describe, it, expect } from 'vitest';

import { DatabaseError, database, poolConfig } from './database.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

describe('the database connection settings', () => {
  it('takes the pooler URL apart, decoding the password', () => {
    // Generated database passwords contain characters a URL has to escape.
    const config = poolConfig('postgresql://postgres.abcdef:p%40ss%2Fw%23rd@pooler.example.com:5432/postgres', CA);
    expect(config).toMatchObject({
      host: 'pooler.example.com',
      port: 5432,
      user: 'postgres.abcdef',
      password: 'p@ss/w#rd',
      database: 'postgres'
    });
  });

  /**
   * The connection carries the database password. Verifying the server is
   * the only thing that keeps it from whoever sits in the path.
   */
  it('verifies the server against the configured authority', () => {
    expect(poolConfig('postgres://u:p@h/db', CA).ssl).toEqual({ ca: CA, rejectUnauthorized: true });
  });

  it('refuses to connect without an authority, rather than skipping verification', () => {
    expect(() => poolConfig('postgres://u:p@h/db', '')).toThrow(/DATABASE_CA_CERT/);
    expect(() => poolConfig('postgres://u:p@h/db', 'not a certificate')).toThrow(/DATABASE_CA_CERT/);
  });

  /** An `sslmode` pasted in the URL must not quietly override the decision above. */
  it('ignores TLS settings in the URL', () => {
    const config = poolConfig('postgres://u:p@h/db?sslmode=disable', CA);
    expect(config.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
  });

  it('reads a one-line certificate with escaped newlines', () => {
    const oneLine = CA.replaceAll('\n', String.raw`\n`);
    expect(poolConfig('postgres://u:p@h/db', oneLine).ssl).toEqual({ ca: CA, rejectUnauthorized: true });
  });

  it('refuses a URL that is not Postgres', () => {
    expect(() => poolConfig('https://example.com', CA)).toThrow(/postgres:\/\//);
    expect(() => poolConfig('not a url', CA)).toThrow(/not a valid URL/);
  });
});

describe('database errors', () => {
  it('reads an unreachable server as unavailable', () => {
    expect(new DatabaseError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).unavailable).toBe(true);
    expect(new DatabaseError({ code: '08006' }).unavailable).toBe(true);
    // Too many clients: the pooler's cap, not the caller's fault.
    expect(new DatabaseError({ code: '53300' }).unavailable).toBe(true);
  });

  it('reads a refused statement as a failure, not an outage', () => {
    const err = new DatabaseError({ code: '23505' });
    expect(err.sqlState).toBe('23505');
    expect(err.unavailable).toBe(false);
  });

  /** The driver's text names the pooler host and database user. */
  it('carries its own message, keeping the driver error for the log', () => {
    const cause = new Error('password authentication failed for user "postgres.abcdef"');
    const err = new DatabaseError(cause);
    expect(err.message).not.toContain('postgres.abcdef');
    expect(err.cause).toBe(cause);
  });
});

describe('who may connect', () => {
  /** This connection is the tables' owner; RLS does not apply to it. */
  it('refuses outside cloud mode', () => {
    expect(() => database()).toThrow(/Only the cloud/);
  });
});
