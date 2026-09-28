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
  listWorkflowRuns,
  promote,
  RepoWorkspaceError
} from '../services/githubRepoWorkspace.js';
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

type Handler = (req: Request, res: Response, repo: string) => Promise<unknown>;

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
      await handler(req, res, repo);
    } catch (err) {
      if (err instanceof RepoWorkspaceError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof GitHubApiError) {
        // GitHub's own status says what happened: 404 unknown ref, 401 signed out.
        const status = [401, 403, 404, 409, 422].includes(err.status) ? err.status : 502;
        res.status(status).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
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
  withProjectRepo(async (req, res, repo) => res.json({ runs: await listWorkflowRuns(repo, query(req, 'branch')) }))
);

/**
 * Open the next promotion PR: `{ from: 'dev', to: 'uat' }` or `{ from: 'uat', to: 'main' }`.
 * Answers 201 opened, 200 with the PR already open, or 200 nothing to promote.
 */
projectRepoRouter.post(
  '/projects/:id/repos/:owner/:name/promote',
  withProjectRepo(async (req, res, repo) => {
    if (!requireWorkspaceCapability(req, res, 'project.promote')) return;
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ error: '"from" and "to" branches are required.' });
    }
    const result = await promote(repo, from, to);
    return res.status(result.status === 'opened' ? 201 : 200).json(result);
  })
);
