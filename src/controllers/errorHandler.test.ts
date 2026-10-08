import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

import { jsonErrorHandler } from './errorHandler.js';
import { DatabaseCommitError, DatabaseError } from '../store/database.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { PublicTicketIntakeError } from '../ticketing/publicIntake.js';
import * as logger from '../utils/logger.js';

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
    setHeader: vi.fn(),
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
  it.each([
    ['entry_unavailable', 404], ['writes_disabled', 503], ['not_verified', 403], ['rate_limited', 429],
    ['operation_conflict', 409], ['outcome_unknown', 409], ['unavailable', 503],
  ] as const)('redacts public intake failure %s and never logs contact/provider details', (code, status) => {
    const spy = vi.spyOn(logger, 'logError');
    try {
      const error = Object.assign(new PublicTicketIntakeError(code, code === 'rate_limited' ? 30 : undefined), { message: 'private SQL email secret', cause: 'private body' });
      const result = handle(error);
      expect(result.statusCode).toBe(status); expect(result.body.code).toBe(`ticket_intake_${code}`);
      expect(JSON.stringify(result.body)).not.toMatch(/private|SQL|secret/); expect(spy).not.toHaveBeenCalled();
      if (code === 'rate_limited') expect(result.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    } finally { spy.mockRestore(); }
  });
  it.each([400, 403, 404, 409, 503] as const)('preserves safe ticket rule status %s without logging ticket data', status => {
    const spy = vi.spyOn(logger, 'logError');
    try {
      const error = Object.assign(new TicketWorkflowError(status, 'ticket_test_refusal', 'Safe public instruction.'), { facts: 'private-facts', command: 'private-body' });
      const res = handle(error);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ error: 'Safe public instruction.', code: 'ticket_test_refusal' });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('redacts inconsistent ticket rows, even if diagnostic fields were attached', () => {
    const spy = vi.spyOn(logger, 'logError').mockImplementation(() => {});
    try {
      const error = Object.assign(new TicketReadInvariantError(), { message: 'private SQL host', cause: 'private-note' });
      const res = handle(error);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'The ticket view could not be verified.', code: 'ticket_view_unavailable' });
      expect(spy).toHaveBeenCalledExactlyOnceWith('Ticket read invariant failed; no ticket content was returned.');
    } finally { spy.mockRestore(); }
  });

  it('delegates after response headers have been sent', () => {
    const res = collect(); res.headersSent = true;
    const next = vi.fn(); const error = new TicketReadInvariantError();
    jsonErrorHandler(error, {} as Request, res, next);
    expect(next).toHaveBeenCalledWith(error);
    expect(res.statusCode).toBe(0);
  });

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

  it.each([undefined, '23505'])('requires reconciliation rather than a blind retry after uncertain COMMIT (%s)', code => {
    const cause = Object.assign(new Error('private host and password'), { code, detail: 'Key (secret)=(private) already exists.' });
    const res = handle(new DatabaseCommitError(cause));
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('transaction_outcome_unknown');
    expect(res.body.reconciliationRequired).toBe(true);
    expect(res.body.error).toMatch(/check the operation before retrying/i);
    expect(JSON.stringify(res.body)).not.toMatch(/private|secret|already taken|try again/i);
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
