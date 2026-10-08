import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransactionalSql } from '../store/database.js';

async function withReadOnlyPmRouter(work: (handler: any, db: TransactionalSql) => Promise<void>) {
  vi.resetModules();
  const db = {
    query: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async () => { throw new Error('Unsupported database transaction should not run.'); }),
  } as unknown as TransactionalSql;
  const { createTicketPmReadRouteBoundary } = await import('./ticketPmReadRouteFactory.js');
  const router = createTicketPmReadRouteBoundary(db);
  await work((router as any).stack.at(-1).handle, db);
}

async function invoke(handler: any) {
  const headers: Record<string, string> = {};
  return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
      status(value: number) { this.statusCode = value; return this; },
      json(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
    };
    handler({ method: 'POST', originalUrl: '/api/tickets/ticket-1/commands' }, res, reject);
  });
}

afterEach(() => vi.resetModules());

describe('PM read-only ticket route composition', () => {
  it('keeps workflow mutations unavailable without touching persistence', async () => {
    await withReadOnlyPmRouter(async (handler, db) => {
      const response = await invoke(handler);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Ticket changes are not enabled yet.' });
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(db.query).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  it('keeps unimplemented ticket write paths fail-closed', async () => {
    await withReadOnlyPmRouter(async (handler, db) => {
      const response = await invoke(handler);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Ticket changes are not enabled yet.' });
      expect(db.query).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
});
