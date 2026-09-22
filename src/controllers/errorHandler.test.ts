import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

import { jsonErrorHandler } from './errorHandler.js';
import { DatabaseError } from '../store/database.js';

/**
 * What a failure tells the person who hit it.
 *
 * The rule is the same for every branch: enough to act on, and nothing about
 * the shape of the infrastructure. A driver error names the pooler's host and
 * the database user, and a stack trace names absolute paths on the server —
 * neither is any use in a toast, and both are a gift to anyone probing.
 *
 * The store driver made this a question with two answers: the same duplicate
 * is a SQLite constraint on a desktop and a Postgres one in the cloud, and
 * the person should not be able to tell which they are talking to.
 */

function collect() {
  const res = {
    statusCode: 0,
    body: null as any,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

const handle = (err: unknown) => {
  const res = collect();
  jsonErrorHandler(err, {} as Request, res, vi.fn());
  return res;
};

describe('the API error handler', () => {
  it('answers a Postgres duplicate the way it answers a SQLite one', () => {
    const sqlite = handle(
      Object.assign(new Error('UNIQUE constraint failed: projects.key'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
    );
    const postgres = handle(
      new DatabaseError({ code: '23505', detail: 'Key (key)=(CHK) already exists.' })
    );

    expect(sqlite.statusCode).toBe(409);
    expect(postgres.statusCode).toBe(409);
    expect(postgres.body.error).toBe(sqlite.body.error);
    expect(postgres.body.error).toMatch(/key is already taken/);
  });

  it('says a database that cannot be reached is worth retrying', () => {
    const res = handle(new DatabaseError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })));

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/try again/i);
  });

  /** The driver's own text names the pooler host and the database user. */
  it('never repeats the driver’s message back to the caller', () => {
    const res = handle(
      new DatabaseError(
        Object.assign(new Error('password authentication failed for user "postgres.abcdefgh"'), { code: '28P01' })
      )
    );

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('postgres.abcdefgh');
  });
});
