import { NextFunction, Request, Response, Router } from 'express';

import { ALPHA_ORG, IS_CLOUD } from '../config/env.js';
import { githubApi, GitHubApiError } from '../services/githubApi.js';
import { reposForProject } from '../services/githubIssueMapping.js';
import {
  getHostingStatus,
  hostingHintsFor,
  platformForStack,
  roleForStack,
  setUpHosting,
  unavailableHostingStatus,
  type HostingContext
} from '../services/hosting/hostingService.js';
import { normalizeProjectStack } from '../services/scaffoldBuilder.js';
import { previewsFor } from '../services/hosting/hostingPreviews.js';
import { checkHealth } from '../services/hosting/healthCheck.js';
import { getHostingLogs } from '../services/hosting/hostingLogs.js';
import { parseDeploymentLogsQuery } from '../services/hosting/logCursor.js';
import { deleteHostingEnv, EnvRequestError, listHostingEnv, setHostingEnv } from '../services/hosting/hostingEnv.js';
import type { HostingActor } from '../services/hosting/hostingAudit.js';
import type { HostingBranch } from '../services/hosting/hostingService.js';
import type { WorkspaceCapability } from '../services/workspaceRegistry.js';
import { usesCloudDirectory } from '../services/cloudWorkspaces.js';
import { projectStore } from '../store/stores.js';
import type { Project } from '../models/index.js';
import { relayToCloud } from './cloudRelay.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

/**
 * Render/Vercel hosting of a project's repositories.
 *
 * Only the cloud holds platform credentials, so the cloud is the only place
 * hosting is ever read or changed. Two shapes of route lead there:
 *
 *  - `/hosting/:owner/:name` -- keyed by repository. The cloud's own, and what
 *    a desktop forwards to: a desktop's project id means nothing to the
 *    cloud, so it sends what it knows about the repository (its stack and
 *    pair) instead.
 *  - `/projects/:id/repos/:owner/:name/hosting` -- what the app calls. In the
 *    cloud it answers directly; on a desktop it forwards to the route above.
 *
 * Every operation is served both ways -- status, set-up, previews, and a
 * backend's health -- from one table, so the rules above are written once.
 * Reading needs `deployment.read`; setting up needs `deployment.manage`.
 */
export const hostingRouter = Router();

/** Setting up waits for both platforms, and a health check for a cold start; both outlast a plain relay. */
const SLOW_TIMEOUT_MS = 180_000;

type Access = 'read' | 'write';

function capabilityFor(access: Access) {
  return access === 'write' ? ('deployment.manage' as const) : ('deployment.read' as const);
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * May this caller act on `owner/name` in the cloud?
 *
 * The organisation Alpha is pinned to, and a repository the caller's own
 * GitHub token can reach (push access to change its hosting) -- so a
 * repo-keyed route can never be pointed at a repository the caller could not
 * touch on GitHub anyway.
 */
async function authorizeRepo(res: Response, owner: string, name: string, access: Access): Promise<boolean> {
  if (!ALPHA_ORG || owner.toLowerCase() !== ALPHA_ORG.toLowerCase()) {
    res.status(404).json({ error: `${owner}/${name} is not a repository of this organization.` });
    return false;
  }
  try {
    const repo = await githubApi().get<{ permissions?: { push?: boolean } }>(`/repos/${owner}/${name}`);
    if (access === 'write' && !repo.permissions?.push) {
      res.status(403).json({ error: `Changing hosting needs push access to ${owner}/${name}.` });
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 403)) {
      res.status(404).json({ error: `${owner}/${name} was not found, or you cannot see it.` });
      return false;
    }
    throw err;
  }
}

/** The project in this workspace that `repo` belongs to, if any -- the authoritative stack and pair when there is one. */
async function projectForRepo(workspaceId: string, repo: string): Promise<Project | null> {
  const wanted = repo.toLowerCase();
  const projects = await projectStore().list(workspaceId);
  return projects.find(project => reposForProject(project).some(r => r.toLowerCase() === wanted)) ?? null;
}

/**
 * The answer for a desktop that has no cloud to forward to: the same shape
 * as every other status, saying why nothing can be done here.
 */
function noCloud(repo: string, stack: string | undefined, partner: string | undefined) {
  const canonical = stack ? normalizeProjectStack(stack) : null;
  return unavailableHostingStatus(
    repo,
    canonical ? roleForStack(canonical) : null,
    canonical ? platformForStack(canonical) : null,
    'This desktop has no Alpha cloud configured, and hosting only runs in the cloud.',
    partner ?? null
  );
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof EnvRequestError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof GitHubApiError) {
        res.status([401, 403, 404].includes(err.status) ? err.status : 502).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

type Hints = { stack?: string; partner?: string };

/** A DELETE carries its arguments in the query: the relay sends no body on one. */
function hasBody(op: { method: string }): boolean {
  return op.method === 'post' || op.method === 'put';
}

interface Operation {
  /** Appended to `/hosting/:owner/:name` and to `/projects/:id/repos/:owner/:name/hosting`. */
  suffix: '' | '/previews' | '/health' | '/logs' | '/env';
  method: 'get' | 'post' | 'put' | 'delete';
  access: Access;
  /** When the capability depends on the request (which environment a variable change is for). */
  capability?: (req: Request) => WorkspaceCapability;
  /** Outlasts the default relay timeout. */
  slow?: boolean;
  /** In the cloud: the answer. */
  run(ctx: HostingContext, req: Request): Promise<unknown>;
  /** On a desktop with no cloud: the same shape, saying nothing can be done here. */
  offline(repo: string, hints: Hints, req: Request): unknown;
}

const OPERATIONS: Operation[] = [
  {
    suffix: '',
    method: 'get',
    access: 'read',
    run: ctx => getHostingStatus(ctx),
    offline: (repo, hints) => noCloud(repo, hints.stack, hints.partner)
  },
  {
    suffix: '',
    method: 'post',
    access: 'write',
    slow: true,
    run: ctx => setUpHosting(ctx),
    offline: (repo, hints) => noCloud(repo, hints.stack, hints.partner)
  },
  {
    suffix: '/previews',
    method: 'get',
    access: 'read',
    run: async ctx => previewsFor(await getHostingStatus(ctx)),
    offline: (repo, hints) => previewsFor(noCloud(repo, hints.stack, hints.partner))
  },
  {
    suffix: '/health',
    method: 'get',
    access: 'read',
    slow: true,
    run: async (ctx, req) => {
      const branch = text(req.query.branch);
      const status = await getHostingStatus(ctx);
      const env = status.environments.find(e => e.branch === branch);
      if (!env?.url) {
        return { url: null, ok: false, status: null, latencyMs: 0, error: `${branch ?? 'That branch'} has no address yet.` };
      }
      return checkHealth(env.url);
    },
    offline: () => ({
      url: null,
      ok: false,
      status: null,
      latencyMs: 0,
      error: 'This desktop has no Alpha cloud configured, and hosting only runs in the cloud.'
    })
  },
  {
    suffix: '/logs',
    method: 'get',
    access: 'read',
    run: (ctx, req) => getHostingLogs(ctx, text(req.query.branch), logsQuery(req)),
    offline: () => ({
      source: 'unavailable',
      reason: 'This desktop has no Alpha cloud configured, and hosting only runs in the cloud.',
      logs: [],
      hasMore: false,
      next: null,
      filters: []
    })
  },
  {
    suffix: '/env',
    method: 'get',
    access: 'read',
    run: ctx => listHostingEnv(ctx),
    offline: repo => ({ repo, role: null, state: 'unavailable', error: NO_CLOUD, environments: [], vars: [] })
  },
  {
    suffix: '/env',
    method: 'put',
    access: 'write',
    slow: true,
    capability: req => envCapability(text(req.body?.environment)),
    run: (ctx, req) =>
      setHostingEnv(
        ctx,
        { environment: text(req.body?.environment) as HostingBranch, vars: req.body?.vars, redeploy: req.body?.redeploy !== false },
        actorOf(req),
        req.workspace!.workspaceId
      ),
    offline: () => {
      throw new EnvRequestError(NO_CLOUD);
    }
  },
  {
    suffix: '/env',
    method: 'delete',
    access: 'write',
    slow: true,
    capability: req => envCapability(text(req.query.environment)),
    run: (ctx, req) =>
      deleteHostingEnv(
        ctx,
        text(req.query.environment) as HostingBranch,
        text(req.query.key) ?? '',
        { redeploy: req.query.redeploy !== 'false' },
        actorOf(req),
        req.workspace!.workspaceId
      ),
    offline: () => {
      throw new EnvRequestError(NO_CLOUD);
    }
  }
];

const NO_CLOUD = 'This desktop has no Alpha cloud configured, and hosting only runs in the cloud.';

/** Production is a release decision; the preview environments are a developer's to change too. */
function envCapability(environment: string | undefined): WorkspaceCapability {
  return environment === 'uat' || environment === 'dev' ? 'deployment.env_preview' : 'deployment.manage';
}

/**
 * Who a change is recorded as: the signed-in person, or an agent working a
 * run for them. The agent label arrives from the desktop's agent bridge; it
 * can only make a change read as the agent's rather than the person's, never
 * grant anything, so it is taken as given.
 */
function actorOf(req: Request): HostingActor {
  const login = req.session?.login ?? req.workspace?.userId ?? 'unknown';
  if (req.header('X-Alpha-Actor') !== 'agent') return { login, kind: 'user' };
  const runId = text(req.header('X-Alpha-Run-Id'));
  const agentId = text(req.header('X-Alpha-Agent-Id'));
  return { login, kind: 'agent', ...(runId ? { runId } : {}), ...(agentId ? { agentId } : {}) };
}

/** The log query parameters, as the logs route and its desktop forward both read them. */
const LOG_QUERY_KEYS = ['startTime', 'endTime', 'direction', 'limit', 'type', 'level', 'text', 'instance'] as const;

function logsQuery(req: Request) {
  const raw = Object.fromEntries(LOG_QUERY_KEYS.map(key => [key, text(req.query[key])])) as Record<
    (typeof LOG_QUERY_KEYS)[number],
    string | undefined
  >;
  return parseDeploymentLogsQuery(raw);
}

function hintsFrom(source: Record<string, unknown>): Hints {
  const stack = text(source.stack);
  const partner = text(source.partner);
  return { ...(stack ? { stack } : {}), ...(partner ? { partner } : {}) };
}

/** Query parameters an operation passes through unchanged: the branch, and a log query's filters and window. */
function passThroughQuery(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['branch', 'environment', 'key', 'redeploy', ...LOG_QUERY_KEYS]) {
    const value = text(req.query[key]);
    if (value) out[key] = value;
  }
  return out;
}

// ─── Repo-keyed: the cloud's own ────────────────────────────────────────────

function repoKeyed(op: Operation) {
  return handle(async (req, res) => {
    if (!requireWorkspaceCapability(req, res, op.capability?.(req) ?? capabilityFor(op.access))) return;
    const { owner, name } = req.params;
    const repo = `${owner}/${name}`;
    const hints = hintsFrom(hasBody(op) ? req.body ?? {} : (req.query as Record<string, unknown>));

    if (!IS_CLOUD) {
      if (await relayToCloud(req, res, op.slow ? { timeoutMs: SLOW_TIMEOUT_MS } : {})) return;
      res.json(await op.offline(repo, hints, req));
      return;
    }

    if (!(await authorizeRepo(res, owner, name, op.access))) return;
    const project = await projectForRepo(req.workspace!.workspaceId, repo);
    res.json(
      await op.run(
        { repo, project, ...(hints.stack ? { stackHint: hints.stack } : {}), ...(hints.partner ? { partnerHint: hints.partner } : {}) },
        req
      )
    );
  });
}

// ─── Project-scoped: what the app calls ─────────────────────────────────────

function projectScoped(op: Operation) {
  return handle(async (req, res) => {
    const { id, owner, name } = req.params;
    if (!requireProjectWorkspace(req, res, id)) return;
    if (!requireWorkspaceCapability(req, res, op.capability?.(req) ?? capabilityFor(op.access))) return;

    const project = await projectStore().get(req.workspace!.workspaceId, id);
    if (!project) {
      res.status(404).json({ error: 'Project not found in the active workspace.' });
      return;
    }
    const repo = reposForProject(project).find(r => r.toLowerCase() === `${owner}/${name}`.toLowerCase());
    if (!repo) {
      res.status(404).json({ error: `${owner}/${name} is not a repository of this project.` });
      return;
    }

    if (IS_CLOUD) {
      if (!(await authorizeRepo(res, owner, name, op.access))) return;
      res.json(await op.run({ repo, project }, req));
      return;
    }

    // A desktop: hand the cloud what this project knows, on the repo-keyed route.
    const hints = hostingHintsFor(project, repo);
    if (!usesCloudDirectory()) {
      res.json(await op.offline(repo, hints, req));
      return;
    }
    const [repoOwner, repoName] = repo.split('/');
    const path = `/hosting/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}${op.suffix}`;
    const timeout = op.slow ? { timeoutMs: SLOW_TIMEOUT_MS } : {};
    if (hasBody(op)) {
      await relayToCloud(req, res, { path, body: { ...(req.body ?? {}), ...hints }, ...timeout });
      return;
    }
    const query = new URLSearchParams({ ...hints, ...passThroughQuery(req) }).toString();
    await relayToCloud(req, res, { path: query ? `${path}?${query}` : path, ...timeout });
  });
}

for (const op of OPERATIONS) {
  hostingRouter[op.method](`/hosting/:owner/:name${op.suffix}`, repoKeyed(op));
  hostingRouter[op.method](`/projects/:id/repos/:owner/:name/hosting${op.suffix}`, projectScoped(op));
}