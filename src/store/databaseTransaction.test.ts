import type pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

import { DatabaseCommitError, DatabaseError, fromPool, type Sql } from './database.js';

function fixture() {
  const query = vi.fn(async (text: string, _params?: unknown[]) => ({
    rows: [{ value: 7 }], command: text === 'COMMIT' ? 'COMMIT' : text
  }));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const pooledQuery = vi.fn();
  // This fixture supplies just the promise methods the adapter uses.
  const db = fromPool({ connect, query: pooledQuery } as unknown as Pick<pg.Pool, 'connect' | 'query'>);
  return { db, query, release, connect, pooledQuery };
}

describe('database-only transactions', () => {
  it('uses one checked-out connection for all statements and returns the result', async () => {
    const f = fixture();
    const params = Object.freeze(['one']);
    const result = await f.db.transaction(async tx => {
      await tx.query('insert first', params);
      return (await tx.query<{ value: number }>('select second')).rows[0].value;
    });
    expect(result).toBe(7);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.pooledQuery).not.toHaveBeenCalled();
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'insert first', 'select second', 'COMMIT']);
    expect(f.query.mock.calls[1][1]).toEqual(params);
    expect(f.query.mock.calls[1][1]).not.toBe(params);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps ordinary queries outside a transaction on the existing pool path', async () => {
    const f = fixture();
    f.pooledQuery.mockResolvedValue({ rows: [{ value: 9 }] });
    expect(await f.db.query('select value', [9])).toEqual({ rows: [{ value: 9 }] });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.pooledQuery).toHaveBeenCalledExactlyOnceWith('select value', [9]);
  });

  it('rolls back on a business refusal and preserves the original error', async () => {
    const f = fixture();
    const error = new Error('stale ticket version');
    await expect(f.db.transaction(async tx => {
      await tx.query('insert audit');
      throw error;
    })).rejects.toBe(error);
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'insert audit', 'ROLLBACK']);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('does not report success when a callback catches a failed SQL statement', async () => {
    const f = fixture();
    f.query.mockImplementation(async text => {
      if (text === 'bad write') throw Object.assign(new Error('private driver detail'), { code: '23505' });
      return { rows: [], command: text };
    });
    await expect(f.db.transaction(async tx => {
      await tx.query('bad write').catch(() => undefined);
      return 'must not commit';
    })).rejects.toMatchObject({ name: 'DatabaseError', sqlState: '23505' });
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'bad write', 'ROLLBACK']);
  });

  it('discards a connection when rollback fails without hiding the cause', async () => {
    const f = fixture();
    const error = new Error('original refusal');
    f.query.mockImplementation(async text => {
      if (text === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [], command: text };
    });
    await expect(f.db.transaction(async () => { throw error; })).rejects.toBe(error);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('sanitizes connection acquisition failures and never invokes work', async () => {
    const f = fixture();
    f.connect.mockRejectedValue(new Error('password and private host'));
    const work = vi.fn();
    await expect(f.db.transaction(work)).rejects.toThrow('The database could not complete that request.');
    expect(work).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it('discards a failed BEGIN connection and never invokes work', async () => {
    const f = fixture();
    f.query.mockRejectedValue(new Error('begin connection failure'));
    const work = vi.fn();
    await expect(f.db.transaction(work)).rejects.toBeInstanceOf(DatabaseError);
    expect(work).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['connection failure', 'unacknowledged rollback'])('does not automatically retry an uncertain commit: %s', async reason => {
    const f = fixture();
    const work = vi.fn(async () => 'saved');
    f.query.mockImplementation(async text => {
      if (text === 'COMMIT') {
        if (reason === 'connection failure') throw new Error('private commit detail');
        return { rows: [], command: 'ROLLBACK' };
      }
      return { rows: [], command: text };
    });
    await expect(f.db.transaction(work)).rejects.toMatchObject({ name: 'DatabaseCommitError', outcome: 'unknown' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not disclose infrastructure details in an uncertain commit error', () => {
    const cause = new Error('private password and host');
    const error = new DatabaseCommitError(cause);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).not.toContain('private');
    expect(error.cause).toBe(cause);
  });

  it('refuses use of a transaction handle after it is released', async () => {
    const f = fixture();
    let leaked: Sql | undefined;
    await f.db.transaction(async tx => { leaked = tx; });
    await expect(leaked!.query('late write')).rejects.toThrow('no longer active');
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'COMMIT']);
  });

  it('separates concurrent transaction callbacks onto their own clients', async () => {
    const f = fixture();
    const secondQuery = vi.fn(async (text: string) => ({ rows: [], command: text }));
    const secondRelease = vi.fn();
    f.connect.mockResolvedValueOnce({ query: f.query, release: f.release });
    f.connect.mockResolvedValueOnce({ query: secondQuery, release: secondRelease });
    await Promise.all([
      f.db.transaction(async tx => { await tx.query('first'); }),
      f.db.transaction(async tx => { await tx.query('second'); })
    ]);
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'first', 'COMMIT']);
    expect(secondQuery.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'second', 'COMMIT']);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back an actual failed middle write in isolated Postgres', async () => {
    const local = new PGlite();
    try {
      await local.exec('create table ticket_fixture (id int primary key); create table audit_fixture (id int primary key);');
      const release = vi.fn();
      const query = async (text: string, params?: unknown[]) => {
        const result = await local.query(text, params);
        return { rows: result.rows, command: text === 'COMMIT' ? 'COMMIT' : text };
      };
      // One PGlite instance models a single checked-out client, not a pool.
      const db = fromPool({ connect: async () => ({ query, release }) } as unknown as Pick<pg.Pool, 'connect' | 'query'>);
      await expect(db.transaction(async tx => {
        await tx.query('insert into ticket_fixture values ($1)', [1]);
        await tx.query('insert into audit_fixture values ($1)', [1]);
        await tx.query('insert into ticket_fixture values ($1)', [1]);
      })).rejects.toMatchObject({ sqlState: '23505' });
      expect((await local.query('select * from ticket_fixture')).rows).toEqual([]);
      expect((await local.query('select * from audit_fixture')).rows).toEqual([]);
      await db.transaction(async tx => {
        await tx.query('insert into ticket_fixture values ($1)', [2]);
        await tx.query('insert into audit_fixture values ($1)', [2]);
      });
      expect((await local.query('select * from ticket_fixture')).rows).toEqual([{ id: 2 }]);
      expect((await local.query('select * from audit_fixture')).rows).toEqual([{ id: 2 }]);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      await local.close();
    }
  });
});
