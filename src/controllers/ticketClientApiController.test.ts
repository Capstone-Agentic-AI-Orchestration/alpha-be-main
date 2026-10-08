import { afterEach, describe, expect, it, vi } from 'vitest';

const subject = { kind: 'client' as const, userId: 'client-a', sessionId: 'session-a' };
const cookie = '__Secure-alpha_client_session=session-secret; alpha_client_csrf=csrf-secret';
const timestamp = '2026-10-08T03:00:00.000Z';

async function setup() {
  vi.resetModules();
  vi.doMock('../config/env.js', () => ({ IS_CLOUD: true }));
  vi.doMock('./ticketRequestAuth.js', () => ({
    opaqueTicketRequestValue: (value: unknown) => typeof value === 'string'
      && value.length > 0 && value.length <= 200 && value.trim() === value,
  }));
  const { createTicketClientApiRouter } = await import('./ticketClientApiController.js');
  const app = {
    authenticate: vi.fn(async (session: unknown, csrf: unknown, header: unknown, requireCsrf: boolean) => {
      if (session !== 'session-secret') return { kind: 'expired' };
      if (requireCsrf && (csrf !== 'csrf-secret' || header !== 'csrf-secret')) return { kind: 'csrf_invalid' };
      return { kind: 'authenticated', subject };
    }),
    listWorkspaces: vi.fn(async () => [{ workspaceId: 'workspace-a', displayName: 'Client workspace', privateMetadata: 'secret' }]),
    getIntakeContext: vi.fn(async () => ({
      intakeContextId: 'context-a', canCreate: true,
      sharedProjects: [{ optionId: 'option-a', displayName: 'Shared project', privateProjectId: 'secret' }],
    })),
    list: vi.fn(async () => ({
      items: [{ id: 'ticket-a', reference: 'T-1', title: 'Request', status: 'received',
        createdAt: timestamp, updatedAt: timestamp, closedAt: null, readOnly: false,
        writesAvailable: true, requestedAction: null }],
      nextCursor: null, counters: { kind: 'client', open: 1, needsClient: 0 },
    })),
    detail: vi.fn(), deliveryManifest: vi.fn(), deliveryContent: vi.fn(), conversation: vi.fn(),
    reply: vi.fn(), execute: vi.fn(), lookup: vi.fn(),
    create: vi.fn(async () => ({ ticketId: 'ticket-a', operationId: 'operation-a', version: 1,
      status: 'received', reference: 'T-1', privateMetadata: 'secret' })),
    lookupCreation: vi.fn(),
  };
  const router = createTicketClientApiRouter(app as any, {
    secure: true, allowedOrigins: ['https://alpha.example'],
  });

  function routeHandler(method: string, path: string) {
    const layer = (router as any).stack.find((item: any) => item.route?.path === path
      && item.route.methods[method.toLowerCase()]);
    if (!layer) throw new Error(`Missing client API route ${method} ${path}`);
    return layer.route.stack[0].handle;
  }

  function invoke(method: string, path: string, overrides: Record<string, unknown> = {}) {
    const headers: Record<string, string> = {
      cookie, origin: 'https://alpha.example', 'x-csrf-token': 'csrf-secret',
      ...((overrides.headers as Record<string, string> | undefined) ?? {}),
    };
    const req = {
      method, params: {}, query: {}, body: undefined,
      ...overrides,
      headers,
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
      const responseHeaders: Record<string, string> = {};
      let status = 200;
      const res = {
        setHeader(name: string, value: string) { responseHeaders[name.toLowerCase()] = String(value); return this; },
        status(value: number) { status = value; return this; },
        json(body: unknown) { resolve({ status, headers: responseHeaders, body }); return this; },
        end(body?: unknown) { resolve({ status, headers: responseHeaders, body }); return this; },
      };
      routeHandler(method, path)(req, res, reject);
    });
  }

  return { app, router, invoke };
}

afterEach(() => { vi.doUnmock('../config/env.js'); vi.doUnmock('./ticketRequestAuth.js'); vi.resetModules(); });

describe('client ticket API contract boundary', () => {
  it('exposes the same workspace, intake, ticket, message and delivery routes used by the browser API', async () => {
    const { router } = await setup();
    const routes = (router as any).stack.filter((layer: any) => layer.route)
      .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

    expect(routes).toEqual([
      'GET /workspaces',
      'GET /workspaces/:workspaceId/intake-context',
      'GET /workspaces/:workspaceId/tickets',
      'GET /tickets/operations/:operationId',
      'POST /tickets',
      'GET /workspaces/:workspaceId/tickets/:ticketId/operations/:operationId',
      'GET /workspaces/:workspaceId/tickets/:ticketId/messages',
      'GET /workspaces/:workspaceId/tickets/:ticketId/deliveries/:deliveryId',
      'GET /workspaces/:workspaceId/tickets/:ticketId/deliveries/:deliveryId/files/:fileId',
      'GET /workspaces/:workspaceId/tickets/:ticketId',
      'POST /workspaces/:workspaceId/tickets/:ticketId/messages',
      'POST /workspaces/:workspaceId/tickets/:ticketId/commands',
    ]);
  });

  it('projects only public workspace and project-option fields for the intake form', async () => {
    const f = await setup();
    const workspaces = await f.invoke('GET', '/workspaces');
    expect(workspaces.body).toEqual({ items: [{ workspaceId: 'workspace-a', displayName: 'Client workspace' }] });
    expect(JSON.stringify(workspaces.body)).not.toContain('secret');
    expect(f.app.listWorkspaces).toHaveBeenCalledWith(subject);

    const context = await f.invoke('GET', '/workspaces/:workspaceId/intake-context', {
      params: { workspaceId: 'workspace-a' },
    });
    expect(context.body).toEqual({ intakeContextId: 'context-a', canCreate: true,
      sharedProjects: [{ optionId: 'option-a', displayName: 'Shared project' }] });
    expect(JSON.stringify(context.body)).not.toContain('secret');
    expect(f.app.getIntakeContext).toHaveBeenCalledWith('workspace-a', subject);
  });

  it('binds ticket creation to the authenticated client, validates CSRF, and removes the context selector before service parsing', async () => {
    const f = await setup();
    const input = { schemaVersion: 1, operationId: 'operation-a', title: 'A request', description: 'Requested work.' };
    const result = await f.invoke('POST', '/tickets', {
      body: { ...input, intakeContextId: 'context-a' },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ticketId: 'ticket-a', operationId: 'operation-a', version: 1,
      status: 'received', reference: 'T-1' });
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(f.app.authenticate).toHaveBeenCalledWith('session-secret', 'csrf-secret', 'csrf-secret', true);
    expect(f.app.create).toHaveBeenCalledWith('context-a', subject, input);
  });

  it('refuses an expired session before revealing workspace data', async () => {
    const f = await setup();
    f.app.authenticate.mockResolvedValue({ kind: 'expired' } as any);
    const result = await f.invoke('GET', '/workspaces');

    expect(result.status).toBe(401);
    expect(f.app.listWorkspaces).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin ticket write before authenticating or creating anything', async () => {
    const f = await setup();
    const result = await f.invoke('POST', '/tickets', {
      headers: { cookie, origin: 'https://attacker.example', 'x-csrf-token': 'csrf-secret' },
      body: { intakeContextId: 'context-a', schemaVersion: 1, operationId: 'operation-a', title: 'A request', description: 'Requested work.' },
    });

    expect(result.status).toBe(403);
    expect(f.app.authenticate).not.toHaveBeenCalled();
    expect(f.app.create).not.toHaveBeenCalled();
  });
});
