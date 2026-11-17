import { describe, expect, it, vi } from 'vitest';

import { createTicketQueueRouter, type PmTicketQueueApplication } from './ticketQueueController.js';
import type { TicketQueueClientSummary } from '../store/ticketQueueStore.js';

const summary: TicketQueueClientSummary = {
  key: 'client:a', displayName: 'Ana Cruz', company: 'Resort Co', access: 'active',
  tickets: { needsPm: 1, waitingClient: 0, open: 2, closed: 1, unlinkedOpen: 1, accessRevoked: 0, unreadReplies: 1 },
  projects: [{ projectId: 'gh-repo-1', name: 'Resort Website', previewPublished: true }],
  lastActivityAt: '2026-11-15T10:00:00.000Z',
};

function app(clients: unknown, relay = vi.fn(async () => false)) {
  const application = {
    list: vi.fn(), listClientGroups: vi.fn(),
    listClients: vi.fn(async () => clients),
  } as unknown as PmTicketQueueApplication & { listClients: ReturnType<typeof vi.fn> };
  const router = createTicketQueueRouter(application, relay as never);
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/clients');
  return { application, relay, handler: layer.route.stack[0].handle as (req: unknown, res: unknown, next: (err?: unknown) => void) => void };
}

function call(handler: ReturnType<typeof app>['handler'], query: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  return new Promise<{ status: number; body: unknown; error?: unknown }>(resolve => {
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
      status(value: number) { this.statusCode = value; return this; },
      json(body: unknown) { resolve({ status: this.statusCode, body }); return this; },
    };
    const req = {
      method: 'GET', originalUrl: '/api/tickets/clients', query,
      workspace: { workspaceId: 'workspace-a', userId: 'pm', role: 'pm' },
      session: { ticketAuthentication: { kind: 'session', sessionId: 'pm-session' } },
    };
    handler(req, res, error => resolve({ status: -1, body: null, error }));
  });
}

describe('GET /tickets/clients', () => {
  it('relays on a desktop and never reads locally', async () => {
    const relay = vi.fn(async (_req: unknown, res: any) => { res.status(200).json({ items: [] }); return true; });
    const { handler, application } = app([summary], relay);
    const response = await call(handler);
    expect(response).toMatchObject({ status: 200, body: { items: [] } });
    expect(application.listClients).not.toHaveBeenCalled();
  });

  it('returns only the documented fields', async () => {
    const { handler } = app([{ ...summary, email: 'ana@example.test', projects: [{ ...summary.projects[0], repository: 'org/repo' }] }]);
    const response = await call(handler);
    if (response.status === -1) return expect(response.error).toBeUndefined();
    expect(response.body).toEqual({ items: [summary] });
  });

  it('rejects query parameters', async () => {
    const { handler, application } = app([summary]);
    const response = await call(handler, { limit: '5' });
    expect(response.status === 400 || (response.error as { status?: number })?.status === 400).toBe(true);
    expect(application.listClients).not.toHaveBeenCalled();
  });

  it('refuses an unverified inquiry key from the application', async () => {
    const { handler } = app([{ ...summary, key: 'ticket:t1' }]);
    const response = await call(handler);
    expect(response.status).toBe(-1);
    expect(response.error).toBeInstanceOf(Error);
  });
});
