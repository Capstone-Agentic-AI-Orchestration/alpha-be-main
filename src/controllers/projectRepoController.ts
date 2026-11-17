import { NextFunction, Request, Response, Router } from 'express';

import { projectStore } from '../store/stores.js';
import { GitHubApiError } from '../services/githubApi.js';
import { reposForProject } from '../services/githubIssueMapping.js';
import {
  compareBranches,
  getFile,
  getTree,
  listBranches,
  listPullRequests,
  promote,
  RepoWorkspaceError
} from '../services/githubRepoWorkspace.js';
import { getRepoArchitecture } from '../services/githubRepoArchitecture.js';
import { budgetMemory, projectMemory } from '../services/repositoryMemory.js';
import { REPOSITORY_MEMORY_LIMITS } from '../config/constants.js';
import { actionsRuns, actionsWorkflows, actionsRun, actionsJobs, actionsJobLogs, actionsArtifacts,
  actionsArtifactDownload, type ActionsOptions } from '../services/projectActionsService.js';
import { deleteProjectRepository, RepoDeletionError } from '../services/repoDeletionService.js';
import { productionReadiness } from '../services/productionReadiness.js';
import type { Project } from '../models/index.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

/**
 * A project's repositories, as the web app and desktop see them: branches,
 * files at any branch, differences, pull requests, CI runs, and promotion.
 *
 * Every route is scoped to a project the caller works in, and to a repository
 * attached to that project -- the caller's own GitHub token could reach more,
 * but a project page is not a general GitHub browser.
 */
export const projectRepoRouter = Router();

type Handler = (req: Request, res: Response, repo: string, project: Project) => Promise<unknown>;

/** Resolve the project and the attached repository, then run `handler` with it. */
function withProjectRepo(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id, owner, name } = req.params;
      if (!requireProjectWorkspace(req, res, id)) return;
      const project = await projectStore().get(req.workspace!.workspaceId, id);
      if (!project) {
        res.status(404).json({ error: 'Project not found in the active workspace.' });
        return;
      }
      const wanted = `${owner}/${name}`.toLowerCase();
      const repo = reposForProject(project).find(candidate => candidate.toLowerCase() === wanted);
      if (!repo) {
        res.status(404).json({ error: `${owner}/${name} is not a repository of this project.` });
        return;
      }
      await handler(req, res, repo, project);
    } catch (err) {
      if (!sendKnownError(res, err)) next(err);
    }
  };
}

/** Answer an error this router knows the meaning of; false leaves it to Express. */
function sendKnownError(res: Response, err: unknown): boolean {
  if (err instanceof RepoDeletionError) {
    res.status(err.status).json({ error: err.message, ...(err.hosting ? { hosting: err.hosting } : {}) });
    return true;
  }
  if (err instanceof RepoWorkspaceError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  if (err instanceof GitHubApiError) {
    // GitHub's own status says what happened: 404 unknown ref, 401 signed out.
    const status = [401, 403, 404, 409, 410, 422, 429].includes(err.status) ? err.status : 502;
    if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(status).json({ error: err.message, ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}) });
    return true;
  }
  return false;
}

const query = (req: Request, key: string): string | undefined =>
  typeof req.query[key] === 'string' && req.query[key] ? String(req.query[key]) : undefined;

/** The repositories attached to a project, e.g. a paired project's -be and -fe. */
projectRepoRouter.get('/projects/:id/repos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireProjectWorkspace(req, res, req.params.id)) return;
    const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found in the active workspace.' });
    return res.json({ repositories: reposForProject(project) });
  } catch (err) {
    next(err);
  }
});

projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/branches',
  withProjectRepo(async (_req, res, repo) => res.json({ branches: await listBranches(repo) }))
);

projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/tree',
  withProjectRepo(async (req, res, repo) => res.json(await getTree(repo, query(req, 'ref') ?? 'dev')))
);

/**
 * The project's repository memory: each repository's AGENTS.md as agents receive
 * it, for developers and PMs to see what every agent is told first. Clients never
 * see it. `?refresh=1` skips the short GitHub cache.
 */
projectRepoRouter.get('/projects/:id/memory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!requireProjectWorkspace(req, res, id)) return;
    if (req.workspace?.role === 'client') {
      res.status(403).json({ error: 'Project memory is shared with the project team only.' });
      return;
    }
    const project = await projectStore().get(req.workspace!.workspaceId, id);
    if (!project) {
      res.status(404).json({ error: 'Project not found in the active workspace.' });
      return;
    }
    const entries = await projectMemory(project, { refresh: query(req, 'refresh') === '1' });
    const sent = budgetMemory(entries);
    res.json({
      limits: REPOSITORY_MEMORY_LIMITS,
      sentCharacters: sent.reduce((total, entry) => total + entry.text.length, 0),
      repositories: entries.map((entry, index) => ({
        repository: entry.repository,
        ...(entry.file ? { file: entry.file } : {}),
        text: entry.text,
        characters: entry.text.length,
        sentCharacters: sent[index].text.length,
        shortened: sent[index].shortened,
        origin: entry.origin,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}),
        ...(entry.stale ? { stale: true } : {})
      }))
    });
  } catch (err) {
    if (!sendKnownError(res, err)) next(err);
  }
});

projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/architecture',
  withProjectRepo(async (req, res, repo) => {
    if (req.workspace?.role !== 'dev') {
      return res.status(403).json({ error: 'Architecture diagrams are available to developers only.' });
    }
    return res.json(await getRepoArchitecture(repo));
  })
);

projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/file',
  withProjectRepo(async (req, res, repo) => {
    const path = query(req, 'path');
    if (!path) return res.status(400).json({ error: 'A file "path" is required.' });
    return res.json(await getFile(repo, path, query(req, 'ref')));
  })
);

projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/compare',
  withProjectRepo(async (req, res, repo) => {
    const base = query(req, 'base');
    const head = query(req, 'head');
    if (!base || !head) return res.status(400).json({ error: '"base" and "head" branches are required.' });
    return res.json(await compareBranches(repo, base, head, { patches: query(req, 'patches') === '1' }));
  })
);

projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/pulls',
  withProjectRepo(async (req, res, repo) => {
    const state = query(req, 'state') ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) {
      return res.status(400).json({ error: '"state" must be open, closed or all.' });
    }
    return res.json({ pullRequests: await listPullRequests(repo, state as 'open' | 'closed' | 'all') });
  })
);

projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/runs',
  withProjectRepo(async (req, res, repo) => res.json(await actionsRuns(repo, actionsOptions(req))))
);

function actionsOptions(req: Request): ActionsOptions {
  const options: ActionsOptions = {};
  for (const key of ['page', 'perPage', 'branch', 'workflow', 'status', 'event', 'from', 'to', 'attempt'] as const) {
    const value = req.query[key];
    if (value !== undefined && typeof value !== 'string') throw new RepoWorkspaceError(`Invalid ${key} filter.`, 400);
    if (value) options[key] = value;
  }
  return options;
}
projectRepoRouter.get('/projects/:id/repos/:owner/:name/workflows',
  withProjectRepo(async (req, res, repo) => res.json(await actionsWorkflows(repo, actionsOptions(req)))));
projectRepoRouter.get('/projects/:id/repos/:owner/:name/runs/:runId',
  withProjectRepo(async (req, res, repo) => res.json(await actionsRun(repo, req.params.runId))));
projectRepoRouter.get('/projects/:id/repos/:owner/:name/runs/:runId/jobs',
  withProjectRepo(async (req, res, repo) => res.json(await actionsJobs(repo, req.params.runId, actionsOptions(req)))));
projectRepoRouter.get('/projects/:id/repos/:owner/:name/runs/:runId/jobs/:jobId/logs',
  withProjectRepo(async (req, res, repo) => res.json(await actionsJobLogs(repo, req.params.runId, req.params.jobId))));
projectRepoRouter.get('/projects/:id/repos/:owner/:name/runs/:runId/artifacts',
  withProjectRepo(async (req, res, repo) => res.json(await actionsArtifacts(repo, req.params.runId, actionsOptions(req)))));
projectRepoRouter.get('/projects/:id/repos/:owner/:name/runs/:runId/artifacts/:artifactId/download',
  withProjectRepo(async (req, res, repo) => {
    const result = await actionsArtifactDownload(repo, req.params.runId, req.params.artifactId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${result.name}"`);
    res.type('application/zip').send(result.bytes);
  }));

/**
 * Open the next promotion PR: `{ from: 'dev', to: 'uat' }` or `{ from: 'uat', to: 'main' }`.
 * Answers 201 opened, 200 with the PR already open, or 200 nothing to promote.
 *
 * Production also needs the client: for a project a client can see, the
 * client's latest UAT round for the commit now on uat must have passed, or the
 * promotion is refused with 409 and the reason.
 */
projectRepoRouter.post(
  '/projects/:id/repos/:owner/:name/promote',
  withProjectRepo(async (req, res, repo, project) => {
    const { from, to } = req.body ?? {};
    if (!requireWorkspaceCapability(req, res, from === 'dev' && to === 'uat' ? 'project.promote_uat' : 'project.promote')) return;
    if (typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ error: '"from" and "to" branches are required.' });
    }
    if (from === 'uat' && to === 'main') {
      const readiness = await productionReadiness(req.workspace!.workspaceId, project.id, repo);
      if (readiness.state === 'not_approved') return res.status(409).json({ error: readiness.reason, readiness });
      const result = await promote(repo, from, to);
      return res.status(result.status === 'opened' ? 201 : 200).json({ ...result, readiness });
    }
    const result = await promote(repo, from, to);
    return res.status(result.status === 'opened' ? 201 : 200).json(result);
  })
);

/**
 * Whether this repository's uat commit (or `?sha=`) may go to production:
 * `approved`, `not_approved` with the reason, or `no_client`. For the
 * production promotion screen, and how a desktop asks the cloud.
 */
projectRepoRouter.get(
  '/projects/:id/repos/:owner/:name/production-readiness',
  withProjectRepo(async (req, res, repo, project) => {
    if (!requireWorkspaceCapability(req, res, 'project.promote')) return;
    const sha = typeof req.query.sha === 'string' && req.query.sha ? req.query.sha : undefined;
    return res.json(await productionReadiness(req.workspace!.workspaceId, project.id, repo, sha));
  })
);

/**
 * Delete one of the project's repositories: its Render and Vercel hosting,
 * the repository on GitHub, and the project's link to it.
 *
 * `?confirm=<owner/name>` must name the repository, the way GitHub asks for
 * it to be typed -- a delete that cannot be undone is never one stray
 * request away. PM-only, like creating one, and GitHub's own admin check
 * runs before anything is removed.
 */
projectRepoRouter.delete(
  '/projects/:id/repos/:owner/:name',
  withProjectRepo(async (req, res, repo, project) => {
    if (!requireWorkspaceCapability(req, res, 'project.provision_repository')) return;
    if (query(req, 'confirm')?.toLowerCase() !== repo.toLowerCase()) {
      return res.status(400).json({ error: `Type ${repo} to confirm deleting it.` });
    }
    return res.json(await deleteProjectRepository({ workspaceId: req.workspace!.workspaceId, project, repo }));
  })
);
