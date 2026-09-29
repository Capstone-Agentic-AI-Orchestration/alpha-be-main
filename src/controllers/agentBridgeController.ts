import { NextFunction, Request, Response, Router } from 'express';

import { usesCloudDirectory } from '../services/cloudWorkspaces.js';
import {
  describePending,
  grantedRepo,
  grantForToken,
  holdHostingChange,
  pendingForRun,
  takePending,
  type RunGrant
} from '../services/runBridge.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { relayToCloud } from './cloudRelay.js';
import { desktopOnly } from './desktopOnly.js';
import { requireWorkspaceCapability } from './workspaceContext.js';

/**
 * The agent bridge: how an agent's hosting tools reach the cloud, and how a
 * person approves what an agent wants to change in production.
 *
 * Desktop only -- runs happen on the desktop, and so do their tools. A tool
 * call arrives from the `alpha-hosting` server with the run's token; it is
 * checked against that run's grant (its project's repositories, its access)
 * and forwarded to the cloud's own hosting routes as the person signed in
 * here, labelled as the agent. Production changes are never forwarded from
 * a tool: they wait here for someone who may change production.
 */
export const agentBridgeRouter = Router();

const NO_CLOUD = 'This desktop has no Alpha cloud configured, and hosting only runs in the cloud.';
/** Changes redeploy, which can outlast the default relay timeout. */
const SLOW_TIMEOUT_MS = 180_000;
const ENVIRONMENTS = new Set(['main', 'uat', 'dev']);

interface BridgeRequest {
  grant: RunGrant;
  repo: string;
  hints: { stack?: string; partner?: string };
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The run's grant and the repository asked about, or an answer explaining why not. */
function authorize(req: Request, res: Response, write: boolean): BridgeRequest | null {
  const grant = grantForToken(req.header('X-Alpha-Run-Token'));
  if (!grant) {
    res.status(401).json({ error: 'This tool call is not part of a running Alpha run.' });
    return null;
  }
  const repo = text(req.body?.repo);
  const entry = repo ? grantedRepo(grant, repo) : null;
  if (!entry) {
    res.status(403).json({
      error: `This run can reach only its project's repositories: ${Object.values(grant.repos).map(r => r.repo).join(', ') || 'none'}.`
    });
    return null;
  }
  if (write && grant.access !== 'write') {
    res.status(403).json({ error: 'This run has read-only access. Describe the change for a person to make.' });
    return null;
  }
  const { repo: canonical, ...hints } = entry;
  return { grant, repo: canonical, hints };
}

function agentHeaders(grant: RunGrant): Record<string, string> {
  return {
    'X-Alpha-Actor': 'agent',
    'X-Alpha-Run-Id': grant.runId,
    ...(grant.agentId ? { 'X-Alpha-Agent-Id': grant.agentId } : {})
  };
}

/** Forward to the cloud's repo-keyed hosting route, as the agent working this run. */
async function forward(
  req: Request,
  res: Response,
  call: BridgeRequest,
  cloud: { method: 'GET' | 'PUT' | 'DELETE'; suffix: string; query?: Record<string, string>; body?: unknown; slow?: boolean }
): Promise<void> {
  if (!usesCloudDirectory()) {
    res.status(503).json({ error: NO_CLOUD });
    return;
  }
  const [owner, name] = call.repo.split('/');
  const query = new URLSearchParams({ ...call.hints, ...(cloud.query ?? {}) }).toString();
  await relayToCloud(req, res, {
    path: `/hosting/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${cloud.suffix}${query ? `?${query}` : ''}`,
    method: cloud.method,
    ...(cloud.body !== undefined ? { body: cloud.body } : {}),
    ...(call.grant.workspaceId ? { workspaceId: call.grant.workspaceId } : {}),
    headers: agentHeaders(call.grant),
    ...(cloud.slow ? { timeoutMs: SLOW_TIMEOUT_MS } : {})
  });
}

function route(write: boolean, fn: (req: Request, res: Response, call: BridgeRequest) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const call = authorize(req, res, write);
      if (call) await fn(req, res, call);
    } catch (err) {
      next(err);
    }
  };
}

// ─── Tool calls ─────────────────────────────────────────────────────────────

agentBridgeRouter.post(
  '/agent-bridge/hosting/status',
  desktopOnly,
  route(false, (req, res, call) => forward(req, res, call, { method: 'GET', suffix: '' }))
);

agentBridgeRouter.post(
  '/agent-bridge/hosting/logs',
  desktopOnly,
  route(false, async (req, res, call) => {
    const branch = text(req.body?.branch);
    const minutes = Math.min(Math.max(Number(req.body?.minutes) || 60, 1), 1440);
    const now = Date.now();
    await forward(req, res, call, {
      method: 'GET',
      suffix: '/logs',
      query: {
        ...(branch ? { branch } : {}),
        startTime: new Date(now - minutes * 60_000).toISOString(),
        endTime: new Date(now).toISOString(),
        direction: 'backward',
        limit: '100',
        ...(text(req.body?.type) ? { type: text(req.body?.type)! } : {}),
        ...(text(req.body?.level) ? { level: text(req.body?.level)! } : {}),
        ...(text(req.body?.text) ? { text: text(req.body?.text)! } : {})
      }
    });
  })
);

agentBridgeRouter.post(
  '/agent-bridge/hosting/env/list',
  desktopOnly,
  route(false, (req, res, call) => forward(req, res, call, { method: 'GET', suffix: '/env' }))
);

agentBridgeRouter.post(
  '/agent-bridge/hosting/env/set',
  desktopOnly,
  route(true, async (req, res, call) => {
    const environment = text(req.body?.environment);
    if (!environment || !ENVIRONMENTS.has(environment)) {
      res.status(400).json({ error: 'environment must be main, uat or dev.' });
      return;
    }
    const vars = Array.isArray(req.body?.vars) ? req.body.vars : [];
    const redeploy = req.body?.redeploy !== false;

    if (environment === 'main') {
      /*
       * Production is a release decision. The person this run acts for must
       * be able to make it; if they can, it still waits for them to.
       */
      if (!req.workspace || !workspaceRegistry.can(req.workspace.role, 'deployment.manage')) {
        res.status(403).json({
          error: 'Production variables can only be changed by a project manager or admin. Tell the user what to set, and where.'
        });
        return;
      }
      const held = holdHostingChange({
        runId: call.grant.runId,
        agentId: call.grant.agentId,
        workspaceId: call.grant.workspaceId,
        repo: call.repo,
        hints: call.hints,
        environment: 'main',
        vars: vars.map((v: any) => ({ key: String(v?.key ?? ''), value: String(v?.value ?? '') })),
        redeploy
      });
      res.status(202).json({
        status: 'pending_approval',
        id: held.id,
        keys: held.vars.map(v => v.key),
        message: 'Queued for approval: production variables change only once a person approves this in the run view.'
      });
      return;
    }

    await forward(req, res, call, { method: 'PUT', suffix: '/env', body: { ...call.hints, environment, vars, redeploy }, slow: true });
  })
);

agentBridgeRouter.post(
  '/agent-bridge/hosting/env/delete',
  desktopOnly,
  route(true, async (req, res, call) => {
    const environment = text(req.body?.environment);
    if (environment !== 'uat' && environment !== 'dev') {
      res.status(403).json({ error: 'An agent removes variables from uat or dev only. Ask a person to change production.' });
      return;
    }
    await forward(req, res, call, {
      method: 'DELETE',
      suffix: '/env',
      query: { environment, key: text(req.body?.key) ?? '', redeploy: String(req.body?.redeploy !== false) },
      slow: true
    });
  })
);

// ─── Approvals, for people ──────────────────────────────────────────────────

/** Production changes an agent asked for in this run, without their values. */
agentBridgeRouter.get('/runs/:runId/hosting-approvals', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.read')) return;
  res.json({ approvals: pendingForRun(req.params.runId).map(describePending) });
});

agentBridgeRouter.post('/runs/:runId/hosting-approvals/:id/reject', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.manage')) return;
  const change = takePending(req.params.runId, req.params.id);
  if (!change) return res.status(404).json({ error: 'That change is no longer waiting for approval.' });
  return res.json({ status: 'rejected', keys: change.vars.map(v => v.key) });
});

/** Approve: the held change goes to the cloud now, still recorded as the agent's. */
agentBridgeRouter.post('/runs/:runId/hosting-approvals/:id/approve', desktopOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'deployment.manage')) return;
    if (!usesCloudDirectory()) return void res.status(503).json({ error: NO_CLOUD });
    const change = takePending(req.params.runId, req.params.id);
    if (!change) return void res.status(404).json({ error: 'That change is no longer waiting for approval.' });

    const [owner, name] = change.repo.split('/');
    await relayToCloud(req, res, {
      path: `/hosting/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/env`,
      method: 'PUT',
      body: { ...change.hints, environment: change.environment, vars: change.vars, redeploy: change.redeploy },
      ...(change.workspaceId ? { workspaceId: change.workspaceId } : {}),
      headers: {
        'X-Alpha-Actor': 'agent',
        'X-Alpha-Run-Id': change.runId,
        ...(change.agentId ? { 'X-Alpha-Agent-Id': change.agentId } : {})
      },
      timeoutMs: SLOW_TIMEOUT_MS
    });
  } catch (err) {
    next(err);
  }
});
