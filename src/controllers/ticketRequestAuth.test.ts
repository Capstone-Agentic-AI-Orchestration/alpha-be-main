import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSubjectResolver() {
  vi.resetModules();
  const requireWorkspaceCapability = vi.fn((req: any, res: any, capability: string) => {
    if (capability === 'issue.read' && req.workspace?.role === 'dev') return true;
    res.status(403).json({ error: 'forbidden' });
    return false;
  });
  vi.doMock('../config/env.js', () => ({ IS_CLOUD: true }));
  vi.doMock('./cloudRelay.js', () => ({ relayToCloud: vi.fn() }));
  vi.doMock('./workspaceContext.js', () => ({ requireWorkspaceCapability }));
  const { assignedWorkTicketSubject } = await import('./ticketRequestAuth.js');
  return { assignedWorkTicketSubject, requireWorkspaceCapability };
}

function response() {
  let statusCode = 200;
  let body: unknown;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(value: unknown) { body = value; return res; },
  };
  return { res, get statusCode() { return statusCode; }, get body() { return body; } };
}

afterEach(() => {
  vi.doUnmock('../config/env.js');
  vi.doUnmock('./cloudRelay.js');
  vi.doUnmock('./workspaceContext.js');
});

describe('assigned-work ticket authentication', () => {
  it('derives the developer subject from the server workspace and verified session', async () => {
    const { assignedWorkTicketSubject, requireWorkspaceCapability } = await loadSubjectResolver();
    const req: any = {
      workspace: { workspaceId: 'ws-1', userId: 'dev-1', role: 'dev' },
      session: { ticketAuthentication: { kind: 'session', sessionId: 'session-1' } },
      body: { userId: 'attacker', workspaceId: 'other-ws' },
    };
    const res = response();

    expect(assignedWorkTicketSubject(req, res.res)).toEqual({
      kind: 'internal', userId: 'dev-1', authentication: { kind: 'session', sessionId: 'session-1' },
    });
    expect(requireWorkspaceCapability).toHaveBeenCalledWith(req, res.res, 'issue.read');
    expect(res.statusCode).toBe(200);
  });

  it('does not resolve an identity for a role without issue.read', async () => {
    const { assignedWorkTicketSubject, requireWorkspaceCapability } = await loadSubjectResolver();
    const req: any = { workspace: { workspaceId: 'ws-1', userId: 'client-1', role: 'client' } };
    const res = response();

    expect(assignedWorkTicketSubject(req, res.res)).toBeNull();
    expect(requireWorkspaceCapability).toHaveBeenCalledWith(req, res.res, 'issue.read');
    expect(res.statusCode).toBe(403);
  });

  it('requires a verified internal session or bearer context', async () => {
    const { assignedWorkTicketSubject } = await loadSubjectResolver();
    const req: any = { workspace: { workspaceId: 'ws-1', userId: 'dev-1', role: 'dev' }, session: {} };
    const res = response();

    expect(assignedWorkTicketSubject(req, res.res)).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});
