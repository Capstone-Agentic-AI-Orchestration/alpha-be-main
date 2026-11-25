import { afterEach, describe, expect, it, vi } from 'vitest';

const subject = { kind: 'client' as const, userId: 'client-a', sessionId: 'session-a' };
const cookie = '__Secure-alpha_client_session=session-secret; alpha_client_csrf=csrf-secret';
const timestamp = '2026-10-08T03:00:00.000Z';

async function setup(withProposals = false, extra: Record<string, unknown> = {}) {
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
    workflowCapabilities: vi.fn(() => ({ phaseWorkflowEnabled: true })),
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
  const proposals = {
    list: vi.fn(async () => ({items:[]})),
    submit: vi.fn(async () => ({id:'proposal-a'})),
    reply: vi.fn(async (_subject: unknown, id: string, input: {operationId: string}) => ({id,operationId:input.operationId,status:'pending' as const})),
  };
  const emailFor = vi.fn(async () => 'verified@example.test');
  const router = createTicketClientApiRouter({...app, ...(withProposals ? {projectProposals:proposals,emailFor} : {}), ...extra} as any, {
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

  return { app, router, invoke, proposals, emailFor };
}

afterEach(() => { vi.doUnmock('../config/env.js'); vi.doUnmock('./ticketRequestAuth.js'); vi.resetModules(); });

describe('client ticket API contract boundary', () => {
  it('exposes the same workspace, intake, ticket, message and delivery routes used by the browser API', async () => {
    const { router } = await setup();
    const routes = (router as any).stack.filter((layer: any) => layer.route)
      .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

    expect(routes).toEqual([
      'GET /workspaces',
      'GET /workflow-capabilities',
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

  it('exposes only the rollout capability required to gate newer portal actions', async () => {
    const f = await setup();
    const result = await f.invoke('GET', '/workflow-capabilities');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ phaseWorkflowEnabled: true });
    expect(f.app.workflowCapabilities).toHaveBeenCalledOnce();
    expect(f.app.authenticate).not.toHaveBeenCalled();
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

describe('project proposal client API',()=>{
 it('uses the authenticated subject and server verified email',async()=>{
  const f=await setup(true);
  const body={schemaVersion:1,operationId:'10000000-0000-4000-8000-000000000001',title:'Project',description:'Outcome',requestedDeadline:null};
  expect((await f.invoke('POST','/project-proposals',{body})).status).toBe(201);
  expect(f.emailFor).toHaveBeenCalledWith(subject);
  expect(f.proposals.submit).toHaveBeenCalledWith(subject,'verified@example.test',body);
  expect((await f.invoke('GET','/project-proposals')).body).toEqual({items:[]});
  expect(f.proposals.list).toHaveBeenCalledWith(subject);
 });
 it('accepts a client clarification reply only through the authenticated CSRF-protected route',async()=>{
  const f=await setup(true);
  const body={schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000001',body:'The first release is for existing customers.'};
  const result=await f.invoke('POST','/project-proposals/:proposalId/reply',{params:{proposalId:'proposal-a'},body});
  expect(result.status).toBe(200);
  expect(result.body).toEqual({id:'proposal-a',operationId:body.operationId,status:'pending'});
  expect(f.proposals.reply).toHaveBeenCalledWith(subject,'proposal-a',body);
 });
 it('rejects missing session, invalid CSRF and foreign origins before proposal access',async()=>{
  const f=await setup(true);
  expect((await f.invoke('GET','/project-proposals',{headers:{cookie:''}})).status).toBe(401);
  expect((await f.invoke('POST','/project-proposals',{headers:{'x-csrf-token':'wrong'}})).status).toBe(403);
  expect((await f.invoke('POST','/project-proposals',{headers:{origin:'https://foreign.example'}})).status).toBe(403);
  const reply={schemaVersion:1,operationId:'20000000-0000-4000-8000-000000000002',body:'A reply'};
  expect((await f.invoke('POST','/project-proposals/:proposalId/reply',{
   params:{proposalId:'proposal-a'},headers:{'x-csrf-token':'wrong'},body:reply,
  })).status).toBe(403);
  expect((await f.invoke('POST','/project-proposals/:proposalId/reply',{
   params:{proposalId:'proposal-a'},headers:{origin:'https://foreign.example'},body:reply,
  })).status).toBe(403);
  expect(f.proposals.submit).not.toHaveBeenCalled();
  expect(f.proposals.list).not.toHaveBeenCalled();
  expect(f.proposals.reply).not.toHaveBeenCalled();
 });
});

describe('client project stage routes', () => {
  async function stageSetup() {
    const stages = {
      summary: vi.fn(async () => ({ stage: 'poc' })),
      operation: vi.fn(async () => ({ receipt: { operationId: 'op' } })),
      signContract: vi.fn(async () => ({ receipt: { action: 'contract_signed' } })),
    };
    const projectPortal = { projects: vi.fn(), requests: vi.fn(), messages: vi.fn(), reply: vi.fn(), operation: vi.fn() };
    return { ...(await setup(false, { projectPortal, projectStages: stages })), stages };
  }
  const params = { workspaceId: 'workspace-a', projectId: 'project-a' };

  it('reads the stage for the signed-in client only, with the project from the path', async () => {
    const f = await stageSetup();
    const response = await f.invoke('GET', '/projects/:workspaceId/:projectId/stage', { params });
    expect(response.body).toEqual({ stage: 'poc' });
    expect(f.stages.summary).toHaveBeenCalledWith({ workspaceId: 'workspace-a', projectId: 'project-a' }, subject);
  });

  it('signs a contract only with the CSRF check passed', async () => {
    const f = await stageSetup();
    const body = { schemaVersion: 1, operationId: 'op', contentHash: 'a'.repeat(64), fullName: 'Juan', consent: true };
    const refused = await f.invoke('POST', '/projects/:workspaceId/:projectId/stage/contract/:contractId/sign',
      { params: { ...params, contractId: 'contract-1' }, body, headers: { 'x-csrf-token': 'wrong' } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(f.stages.signContract).not.toHaveBeenCalled();
    const accepted = await f.invoke('POST', '/projects/:workspaceId/:projectId/stage/contract/:contractId/sign',
      { params: { ...params, contractId: 'contract-1' }, body });
    expect(accepted.body).toEqual({ receipt: { action: 'contract_signed' } });
    expect(f.stages.signContract).toHaveBeenCalledWith({ workspaceId: 'workspace-a', projectId: 'project-a' }, subject, 'contract-1', body);
  });
});
