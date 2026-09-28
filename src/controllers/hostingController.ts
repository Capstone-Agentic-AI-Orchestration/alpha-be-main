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
 * Reading needs `deployment.read`; setting up needs `deployment.manage`.
 */
export const hostingRouter = Router();

/** Setting up creates services and waits for the platforms; longer than a plain relay. */
const SET_UP_TIMEOUT_MS = 180_000;

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

function runHosting(access: Access, ctx: HostingContext) {
  return access === 'write' ? setUpHosting(ctx) : getHostingStatus(ctx);
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
      if (err instanceof GitHubApiError) {
        res.status([401, 403, 404].includes(err.status) ? err.status : 502).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

// ─── Repo-keyed: the cloud's own ────────────────────────────────────────────

function repoKeyed(access: Access) {
  return handle(async (req, res) => {
    if (!requireWorkspaceCapability(req, res, capabilityFor(access))) return;
    const { owner, name } = req.params;
    const repo = `${owner}/${name}`;
    const source = access === 'write' ? req.body ?? {} : req.query;
    const stack = text(source.stack);
    const partner = text(source.partner);

    if (!IS_CLOUD) {
      if (await relayToCloud(req, res, access === 'write' ? { timeoutMs: SET_UP_TIMEOUT_MS } : {})) return;
      res.json(noCloud(repo, stack, partner));
      return;
    }

    if (!(await authorizeRepo(res, owner, name, access))) return;
    const project = await projectForRepo(req.workspace!.workspaceId, repo);
    res.json(
      await runHosting(access, {
        repo,
        project,
        ...(stack ? { stackHint: stack } : {}),
        ...(partner ? { partnerHint: partner } : {})
      })
    );
  });
}

hostingRouter.get('/hosting/:owner/:name', repoKeyed('read'));
hostingRouter.post('/hosting/:owner/:name', repoKeyed('write'));

// ─── Project-scoped: what the app calls ─────────────────────────────────────

function projectScoped(access: Access) {
  return handle(async (req, res) => {
    const { id, owner, name } = req.params;
    if (!requireProjectWorkspace(req, res, id)) return;
    if (!requireWorkspaceCapability(req, res, capabilityFor(access))) return;

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
      if (!(await authorizeRepo(res, owner, name, access))) return;
      res.json(await runHosting(access, { repo, project }));
      return;
    }

    // A desktop: hand the cloud what this project knows, on the repo-keyed route.
    const hints = hostingHintsFor(project, repo);
    if (!usesCloudDirectory()) {
      res.json(noCloud(repo, hints.stack, hints.partner));
      return;
    }
    const [repoOwner, repoName] = repo.split('/');
    const path = `/hosting/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`;
    const query = new URLSearchParams(hints).toString();
    await relayToCloud(
      req,
      res,
      access === 'write'
        ? { path, body: hints, timeoutMs: SET_UP_TIMEOUT_MS }
        : { path: query ? `${path}?${query}` : path }
    );
  });
}

hostingRouter.get('/projects/:id/repos/:owner/:name/hosting', projectScoped('read'));
hostingRouter.post('/projects/:id/repos/:owner/:name/hosting', projectScoped('write'));
