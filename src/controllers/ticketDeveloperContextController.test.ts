import { afterEach, describe, expect, it, vi } from 'vitest';

async function startApi(role = 'dev', correction: unknown = null) {
  vi.resetModules();
  vi.doMock('./ticketRequestAuth.js', () => ({
    relayPmTicketRequest: async () => false,
    opaqueTicketRequestValue: (value: unknown) => typeof value === 'string' && value.length > 0 && value.trim() === value,
    assignedWorkTicketSubject: (req: any, res: any) => {
      if (req.workspace?.role !== 'dev') {
        res.status(403).json({ error: 'You cannot view assigned work.' });
        return null;
      }
      return { kind: 'internal', userId: req.workspace.userId, authentication: { kind: 'session', sessionId: 'session-1' } };
    },
  }));
  const { createTicketDeveloperContextRouter } = await import('./ticketDeveloperContextController.js');
  const read = vi.fn(async () => ({
    ticketReference: 'TCK-101', ticketVersion: 3, issueId: 'issue-1', projectId: 'project-1',
    issueRevisionId: 'revision-1', scopeVersionId: 'scope-1', brief: 'Implement the approved change.', correction,
    clientEmail: 'private@example.com', privateNotes: ['internal note'],
  } as any));
  const router = createTicketDeveloperContextRouter({ read });
  const handler = (router as any).stack[0].route.stack[0].handle;
  async function request(overrides: Record<string, unknown> = {}) {
    return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const req = {
        method: 'GET', url: '/issues/issue-1/work-context',
        params: { issueId: 'issue-1' }, query: {}, headers: {},
        workspace: { workspaceId: 'ws-server', userId: 'dev-server', role },
        ...overrides,
      };
      const res = {
        statusCode: 200,
        setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
        status(value: number) { this.statusCode = value; return this; },
        json(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
      };
      handler(req, res, reject);
    });
  }
  return { read, request };
}

afterEach(() => {
  vi.doUnmock('./ticketRequestAuth.js');
});

describe('ticket developer context route', () => {
  it('allowlists correction instructions and timestamp without leaking private audit fields', async () => {
    const api = await startApi('dev', { instructions: 'Fix the agreed validation behavior.', authorizedAt: '2026-10-08T03:00:00.000Z',
      clientEmail: 'private@example.test', authorizedByPmId: 'private-pm-id', previousRevisionId: 'private-revision' });
    const response = await api.request();
    expect(response.body).toMatchObject({ workContext: { correction: {
      instructions: 'Fix the agreed validation behavior.', authorizedAt: '2026-10-08T03:00:00.000Z',
    } } });
    expect((response.body as any).workContext.correction).not.toHaveProperty('clientEmail');
    expect((response.body as any).workContext.correction).not.toHaveProperty('authorizedByPmId');
    expect((response.body as any).workContext.correction).not.toHaveProperty('previousRevisionId');
  });

  it.each([{}, { instructions: ' ', authorizedAt: '2026-10-08T03:00:00Z' }, { instructions: 'Fix', authorizedAt: 'invalid' }])('refuses invalid correction projection %s', async correction => {
    const api = await startApi('dev', correction);
    await expect(api.request()).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
  });
  it('uses authenticated workspace identity and returns only the explicit work DTO', async () => {
    const api = await startApi();
    const response = await api.request({ query: { workspaceId: 'attacker' }, headers: { 'X-Workspace-Id': 'attacker' } });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).toEqual({ workContext: {
        ticketReference: 'TCK-101', ticketVersion: 3, issueId: 'issue-1', projectId: 'project-1',
        issueRevisionId: 'revision-1', scopeVersionId: 'scope-1', brief: 'Implement the approved change.', correction: null,
    } });
    expect(api.read).toHaveBeenCalledWith('ws-server', 'issue-1', {
      kind: 'internal', userId: 'dev-server', authentication: { kind: 'session', sessionId: 'session-1' },
    });
  });

  it('rejects non-developer roles before reading any work context', async () => {
    const api = await startApi('client');
    const response = await api.request();
    expect(response.status).toBe(403);
    expect(api.read).not.toHaveBeenCalled();
  });
});
