import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent bridge: a run's tools reach only that run's repositories, a
 * read-only run changes nothing, everything is forwarded as the agent, and
 * production waits for a person who may change it. The cloud relay and the
 * workspace guards are faked; the run grants are real.
 */

const CAN: Record<string, string[]> = {
  'deployment.read': ['dev', 'pm', 'admin'],
  'deployment.manage': ['admin']
};

async function startApi(options: { role?: string; cloud?: boolean } = {}) {
  vi.resetModules();
  const calls: any[] = [];
  vi.doMock('../services/cloudWorkspaces.js', () => ({
    usesCloudDirectory: () => options.cloud ?? true,
    cloudRequest: async (path: string, init: any) => {
      calls.push({ path, ...init });
      return { status: 200, body: { relayed: true } };
    }
  }));
  vi.doMock('./workspaceContext.js', () => ({
    requireWorkspaceCapability: (req: any, res: any, capability: string) => {
      const ok = (CAN[capability] ?? []).includes(req.workspace.role);
      if (!ok) res.status(403).json({ error: 'no' });
      return ok;
    }
  }));
  vi.doMock('../services/workspaceRegistry.js', () => ({
    workspaceRegistry: { can: (role: string, capability: string) => (CAN[capability] ?? []).includes(role) }
  }));

  const bridge = await import('../services/runBridge.js');
  const { agentBridgeRouter } = await import('./agentBridgeController.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).workspace = { workspaceId: 'ws-desktop', role: options.role ?? 'admin', userId: 'u1' };
    next();
  });
  app.use('/api', agentBridgeRouter);

  const token = (access: 'read' | 'write' = 'write') =>
    bridge.mintRunGrant({
      runId: `run-${access}`,
      agentId: 'agent-operator',
      workspaceId: 'ws-run',
      repos: { 'example-org/shop-fe': { repo: 'example-org/shop-fe', stack: 'react', partner: 'example-org/shop-be' } },
      access
    });
  return { app, calls, token, bridge };
}

async function call(app: express.Express, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, body: (await res.json()) as any };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

afterEach(() => {
  for (const mod of ['../services/cloudWorkspaces.js', './workspaceContext.js', '../services/workspaceRegistry.js']) vi.doUnmock(mod);
  vi.resetModules();
});

const REPO = 'example-org/shop-fe';
const vars = [{ key: 'VITE_FLAG', value: 'on-secret' }];

describe('a run’s hosting tools', () => {
  it('refuses a call without a live run token', async () => {
    const { app, calls } = await startApi();

    const res = await call(app, 'POST', '/api/agent-bridge/hosting/status', { repo: REPO }, { 'X-Alpha-Run-Token': 'f'.repeat(64) });

    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('refuses a repository outside the run’s project', async () => {
    const { app, calls, token } = await startApi();

    const res = await call(app, 'POST', '/api/agent-bridge/hosting/status', { repo: 'example-org/payroll' }, { 'X-Alpha-Run-Token': token() });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('forwards a read to the cloud as the agent, in the run’s workspace', async () => {
    const { app, calls, token } = await startApi();

    await call(app, 'POST', '/api/agent-bridge/hosting/logs', { repo: REPO, branch: 'uat', level: 'error', minutes: 30 }, { 'X-Alpha-Run-Token': token('read') });

    const url = new URL(`http://x${calls[0].path}`);
    expect(url.pathname).toBe(`/hosting/${REPO}/logs`);
    expect(url.searchParams.get('branch')).toBe('uat');
    expect(url.searchParams.get('level')).toBe('error');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      workspaceId: 'ws-run',
      headers: { 'X-Alpha-Actor': 'agent', 'X-Alpha-Run-Id': 'run-read', 'X-Alpha-Agent-Id': 'agent-operator' }
    });
  });

  it('keeps a read-only run from changing anything', async () => {
    const { app, calls, token } = await startApi();

    const res = await call(app, 'POST', '/api/agent-bridge/hosting/env/set', { repo: REPO, environment: 'uat', vars }, { 'X-Alpha-Run-Token': token('read') });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('applies a uat change straight away', async () => {
    const { app, calls, token } = await startApi();

    await call(app, 'POST', '/api/agent-bridge/hosting/env/set', { repo: REPO, environment: 'uat', vars }, { 'X-Alpha-Run-Token': token() });

    expect(calls[0]).toMatchObject({ path: expect.stringContaining(`/hosting/${REPO}/env`), method: 'PUT', body: { environment: 'uat', vars, redeploy: true } });
  });
});

describe('production changes from an agent', () => {
  it('are held for approval, not forwarded, and the answer carries no value', async () => {
    const { app, calls, token } = await startApi({ role: 'admin' });

    const res = await call(app, 'POST', '/api/agent-bridge/hosting/env/set', { repo: REPO, environment: 'main', vars }, { 'X-Alpha-Run-Token': token() });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'pending_approval', keys: ['VITE_FLAG'] });
    expect(JSON.stringify(res.body)).not.toContain('on-secret');
    expect(calls).toEqual([]);
  });

  it('are refused outright when the person the run acts for cannot change production', async () => {
    const { app, token } = await startApi({ role: 'dev' });

    const res = await call(app, 'POST', '/api/agent-bridge/hosting/env/set', { repo: REPO, environment: 'main', vars }, { 'X-Alpha-Run-Token': token() });

    expect(res.status).toBe(403);
  });

  it('go to the cloud once approved, still recorded as the agent’s', async () => {
    const { app, calls, token } = await startApi({ role: 'admin' });
    const held = await call(app, 'POST', '/api/agent-bridge/hosting/env/set', { repo: REPO, environment: 'main', vars }, { 'X-Alpha-Run-Token': token() });

    const listed = await call(app, 'GET', '/api/runs/run-write/hosting-approvals');
    expect(listed.body.approvals.map((a: any) => a.keys)).toEqual([['VITE_FLAG']]);
    expect(JSON.stringify(listed.body)).not.toContain('on-secret');

    const approved = await call(app, 'POST', `/api/runs/run-write/hosting-approvals/${held.body.id}/approve`);

    expect(approved.status).toBe(200);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      body: { environment: 'main', vars },
      headers: { 'X-Alpha-Actor': 'agent', 'X-Alpha-Run-Id': 'run-write' }
    });
    // Decided once.
    expect((await call(app, 'POST', `/api/runs/run-write/hosting-approvals/${held.body.id}/approve`)).status).toBe(404);
  });

  it('are dropped, values and all, when rejected', async () => {
    const { app, calls, token } = await startApi({ role: 'admin' });
    const held = await call(app, 'POST', '/api/agent-bridge/hosting/env/set', { repo: REPO, environment: 'main', vars }, { 'X-Alpha-Run-Token': token() });

    expect((await call(app, 'POST', `/api/runs/run-write/hosting-approvals/${held.body.id}/reject`)).body).toEqual({ status: 'rejected', keys: ['VITE_FLAG'] });
    expect((await call(app, 'GET', '/api/runs/run-write/hosting-approvals')).body.approvals).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('may not be removed by an agent at all', async () => {
    const { app, token } = await startApi({ role: 'admin' });

    const res = await call(app, 'POST', '/api/agent-bridge/hosting/env/delete', { repo: REPO, environment: 'main', key: 'VITE_FLAG' }, { 'X-Alpha-Run-Token': token() });

    expect(res.status).toBe(403);
  });
});
