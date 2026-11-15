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
  it('mounts command and private-note routes only when Phase 2 triage is enabled', async () => {
    const { createTicketPmReadRouteBoundary } = await import('./ticketPmReadRouteFactory.js');
    const db = { query: vi.fn(), transaction: vi.fn() } as unknown as TransactionalSql;
    const relay = vi.fn(async () => false);
    function paths(router: any): string[] {
      return router.stack.flatMap((layer: any) => layer.route ? [layer.route.path]
        : layer.handle?.stack ? paths(layer.handle) : []);
    }
    const readOnly = paths(createTicketPmReadRouteBoundary(db, relay));
    const triage = paths(createTicketPmReadRouteBoundary(db, relay, true, true));
    expect(readOnly).toContain('/inquiry-code');
    expect(readOnly).not.toContain('/:ticketId/commands');
    expect(triage).toContain('/:ticketId/commands');
    expect(triage).toContain('/operations/:operationId');
    expect(triage).toContain('/:ticketId/invitations');
    expect(triage.indexOf('/intakes')).toBeLessThan(triage.indexOf('/:ticketId'));
    // GET /:ticketId would read "clients" as a ticket id if it came first.
    for (const routes of [readOnly, triage]) {
      expect(routes).toContain('/clients');
      expect(routes.indexOf('/clients')).toBeLessThan(routes.indexOf('/:ticketId'));
    }
    expect(triage).not.toContain('/:ticketId/scope');
    expect(db.query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

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

  it('returns only the published inquiry code from the currently authorized PM workspace', async () => {
    const { createTicketPmReadRouteBoundary } = await import('./ticketPmReadRouteFactory.js');
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const sql = {
      async query(text: string, values: unknown[] = []) {
        statements.push({ text, values });
        return statements.length === 1
          ? { rows: [{ time_zone: 'UTC', write_mode: 'enabled' }] }
          : { rows: [{ slug: 'workspace-intake', entry_write_mode: 'enabled', workspace_write_mode: 'enabled' }] };
      },
    };
    const db = { transaction: async (work: (value: typeof sql) => Promise<unknown>) => work(sql) } as unknown as TransactionalSql;
    const relay = vi.fn(async () => false);
    const router = createTicketPmReadRouteBoundary(db, relay);
    const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/inquiry-code')?.route.stack[0].handle;
    expect(handler).toBeTypeOf('function');

    const response = await new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const res = {
        statusCode: 200,
        setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
        status(value: number) { this.statusCode = value; return this; },
        json(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
      };
      handler({ method: 'GET', originalUrl: '/api/tickets/inquiry-code', path: '/inquiry-code',
        workspace: { workspaceId: 'workspace-1', userId: 'pm-1', role: 'pm' },
        session: { ticketAuthentication: { kind: 'session', sessionId: 'session-1' } } }, res,
      (error: unknown) => reject(error));
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.body).toEqual({ code: 'workspace-intake', submissionEnabled: true });
    expect(statements[1]?.values).toEqual(['workspace-1']);
    expect(JSON.stringify(response.body)).not.toContain('workspace_id');
  });
});
