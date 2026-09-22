import { NextFunction, Request, Response, Router } from 'express';
import { githubService } from '../services/githubService.js';
import { createScaffoldedRepository } from '../services/repoScaffoldService.js';
import { sqliteService } from '../services/sqliteService.js';
import { SUPPORTED_STACKS } from '../services/scaffoldBuilder.js';
import path from 'node:path';
import { requireEntityWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { CORS_ORIGIN, ALPHA_ORG } from '../config/env.js';
import { fetchTeamsWithToken, roleForLogin } from '../services/identityService.js';
import { sessionService } from '../services/sessionService.js';
import { SESSION_COOKIE, clearedSessionCookie, readCookie, sessionCookie } from './sessionContext.js';
import { logInfo, logError } from '../utils/logger.js';

export const githubRouter = Router();

githubRouter.get('/github/auth', async (req: Request, res: Response) => {
  const auth = await githubService.checkAuth();
  res.json(auth);
});

/**
 * Begin the device-code login. Returns the one-time code for the UI to display;
 * the caller then polls GET /github/auth until `authenticated` flips true.
 */
githubRouter.post('/github/auth/login', async (req: Request, res: Response) => {
  try {
    res.json(await githubService.startDeviceLogin());
  } catch (err: any) {
    res.status(503).json({ error: err?.message ?? 'Could not start GitHub login' });
  }
});

githubRouter.post('/github/auth/logout', async (req: Request, res: Response) => {
  try {
    await githubService.logout();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not sign out of GitHub' });
  }
});

// ─── Hosted Web OAuth 2.0 Web Flow ──────────────────────────────────────────

/** Get OAuth Login URL for browser redirect */
githubRouter.get('/github/oauth/url', (req: Request, res: Response) => {
  try {
    const data = githubService.getOAuthLoginUrl();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'OAuth is not configured' });
  }
});

/**
 * Handle OAuth callback from GitHub, and open a session.
 *
 * This used to throw the credential away. `handleOAuthCallback` returned
 * `{ username, token }`, the token was dropped, and the browser was redirected
 * to `/#github_connected=true&username=...` — a name in a URL fragment, which
 * is not authentication and which nothing in the frontend read anyway. Both
 * ends of the flow were inert, which is consistent with `.env` having always
 * been empty: it has never once run.
 *
 * Now: the token stays on the server, encrypted, and the browser receives an
 * opaque httpOnly cookie. A cookie that leaks is a revocable session; a token
 * that leaks is every private repository the user can reach.
 */
githubRouter.get('/github/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string | undefined;
  if (!code) {
    return res.status(400).send('Missing "code" parameter');
  }

  const redirectOrigin = CORS_ORIGIN.split(',')[0].trim();

  try {
    // state is validated inside; a missing or unknown value is rejected.
    const result = await githubService.handleOAuthCallback(code, state);

    /**
     * The role is decided once, here, and cached on the session.
     *
     * Deriving it per request would put a GitHub team lookup on every API
     * call — hundreds of milliseconds, on a service whose free tier already
     * cold-starts. The cost is that a team change takes effect at next
     * sign-in rather than immediately, which is the right trade for a
     * membership that changes a few times a year.
     */
    const teams = await fetchTeamsWithToken(result.token);
    const role = roleForLogin(result.username, teams);

    if (!role) {
      /**
       * Refused before a session exists, so there is nothing to revoke.
       *
       * Sent back to the app with a reason rather than a bare 403 page: the
       * person needs to know it is their team membership that is missing, not
       * their password.
       */
      logInfo(`Sign-in refused for ${result.username}: no team in ${ALPHA_ORG} maps to a role.`);
      return res.redirect(`${redirectOrigin}/#alpha_error=no_team`);
    }

    const { cookieValue } = await sessionService.create({
      login: result.username,
      role,
      githubToken: result.token
    });

    res.setHeader('Set-Cookie', sessionCookie(cookieValue));
    return res.redirect(`${redirectOrigin}/#alpha_signed_in=1`);
  } catch (err: any) {
    logError('OAuth callback failed:', err?.message || err);
    // Back to the app, not a JSON blob in the address bar: this is a browser
    // navigation, and the person needs somewhere to retry from.
    return res.redirect(`${redirectOrigin}/#alpha_error=oauth_failed`);
  }
});

/** The signed-in user, or 401. The frontend's "who am I" on boot. */
githubRouter.get('/github/session', (req: Request, res: Response) => {
  if (!req.session) return res.status(401).json({ error: 'Not signed in.' });
  const { login, name, role, expiresAt } = req.session;
  // Deliberately not the GitHub token. It never leaves this process.
  return res.json({ login, name, role, expiresAt });
});

/**
 * Sign out: revoke server-side, and clear the cookie.
 *
 * The cookie is cleared first, whatever the revoke does: a browser asked to
 * sign out should forget the session even when the server could not reach
 * its store to end it.
 */
githubRouter.post('/github/session/logout', async (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Set-Cookie', clearedSessionCookie());
  try {
    await sessionService.revoke(readCookie(req, SESSION_COOKIE));
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ─── GitHub App Integration ──────────────────────────────────────────────────

/** Get GitHub App installation URL */
githubRouter.get('/github/app/install-url', (req: Request, res: Response) => {
  res.json({ url: githubService.getGitHubAppInstallUrl() });
});

/** GitHub App Webhook receiver */
githubRouter.post('/github/app/webhook', async (req: Request, res: Response) => {
  const event = req.header('X-GitHub-Event') || 'unknown';
  const signature = req.header('X-Hub-Signature-256');

  try {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const result = await githubService.handleGitHubAppWebhook(event, req.body, signature, rawBody);
    res.json({ success: true, result });
  } catch (err: any) {
    // 401, not 400: an unverified delivery is an auth failure, not bad input.
    res.status(401).json({ error: err?.message ?? 'Webhook rejected' });
  }
});

// ─── Organizations & Repositories ───────────────────────────────────────────

/** Organizations the signed-in user can be offered as a repository owner. */
githubRouter.get('/github/orgs', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  res.json(await githubService.listOrganizations());
});

githubRouter.get('/github/repos', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  const repos = await githubService.listRepositories();
  res.json(repos);
});

githubRouter.get('/github/runs', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.read')) return;
  const cwd = (req.query.cwd as string) || path.resolve('..');
  const runs = await githubService.getWorkflowRuns(cwd);
  res.json(runs);
});

githubRouter.post('/github/dispatch', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.manage')) return;
  const { projectId, cwd, workflow, ref, inputs } = req.body ?? {};
  if (!projectId || typeof projectId !== 'string') {
    return res.status(400).json({ error: 'A workspace projectId is required.' });
  }
  if (!requireEntityWorkspace(req, res, 'projects', projectId)) return;
  if (!cwd || typeof cwd !== 'string') {
    return res.status(400).json({ error: 'A project workspace "cwd" is required.' });
  }
  if (workflow !== undefined && typeof workflow !== 'string') {
    return res.status(400).json({ error: 'Workflow must be a string when provided.' });
  }
  if (ref !== undefined && typeof ref !== 'string') {
    return res.status(400).json({ error: 'Workflow ref must be a string when provided.' });
  }
  if (inputs !== undefined &&
      (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs) ||
       Object.values(inputs).some(value => typeof value !== 'string'))) {
    return res.status(400).json({ error: 'Workflow inputs must be an object of string values.' });
  }

  try {
    const result = await githubService.dispatchWorkflow({ cwd, workflow, ref, inputs });
    return res.status(201).json(result);
  } catch (err: any) {
    const detail = err?.message || 'Failed to dispatch GitHub Actions workflow';
    const status = /not a Git repository|no GitHub repository|No (active )?GitHub Actions workflow|not a valid/i.test(detail)
      ? 400
      : 502;
    return res.status(status).json({ error: detail });
  }
});

githubRouter.get('/github/runs/:id/logs', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.read')) return;
  const cwd = (req.query.cwd as string) || path.resolve('..');
  const logs = await githubService.getFailedWorkflowLogs(cwd, req.params.id);
  res.json({ logs });
});

githubRouter.post('/github/pr', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.manage')) return;
  try {
    const { cwd = path.resolve('..'), title, body, base = 'main', headBranch } = req.body;
    const prUrl = await githubService.createPullRequest(cwd, title, body, base, headBranch);
    res.status(201).json({ prUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create PR' });
  }
});

githubRouter.post('/github/merge', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.manage')) return;
  try {
    const { cwd = path.resolve('..'), prUrl, method = 'squash' } = req.body;
    const result = await githubService.mergePullRequest(cwd, prUrl, method);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to merge PR' });
  }
});

// ─── Repository provisioning ─────────────────────────────────────────────────

/**
 * POST /api/github/repos
 * Create a GitHub repository.
 * Body: { name, visibility?, description?, org?, sourceDir?, initReadme? }
 */
githubRouter.post('/github/repos', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
  const { name, visibility, description, org, sourceDir, initReadme } = req.body ?? {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'A repository "name" is required.' });
  }
  if (visibility && !['private', 'public', 'internal'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility must be private, public or internal.' });
  }

  try {
    const repo = await githubService.createRepository({
      name, visibility, description, org, sourceDir, initReadme
    });
    return res.status(201).json(repo);
  } catch (err: any) {
    const msg = err?.message ?? 'Failed to create repository';
    const status = /already exists/i.test(msg) ? 409 : 500;
    return res.status(status).json({ error: msg });
  }
});

/**
 * POST /api/github/repos/scaffold
 *
 * Create an organization repository that starts with a project structure.
 * Body: { projectId, repoName, stack, org?, visibility?, shape?, includeDocker? }
 *
 * The organization is resolved from the project, not from the caller: the first
 * repository may set it, every later one inherits it. `org` is required at this
 * layer rather than only in the UI — the daemon listens on localhost and any
 * process on the machine can post here, so a policy enforced in the form alone
 * is not enforced at all.
 */
githubRouter.post('/github/repos/scaffold', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
  const { projectId, repoName, stack, org, visibility, shape, includeDocker } = req.body ?? {};

  if (!projectId || typeof projectId !== 'string') {
    return res.status(400).json({ error: 'A "projectId" is required.' });
  }
  if (!repoName || typeof repoName !== 'string') {
    return res.status(400).json({ error: 'A repository "repoName" is required.' });
  }
  if (!stack || !SUPPORTED_STACKS.includes(stack)) {
    return res.status(400).json({
      error: `"stack" must be one of: ${SUPPORTED_STACKS.join(', ')}.`
    });
  }
  if (visibility && !['private', 'public'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility must be private or public.' });
  }

  if (!requireEntityWorkspace(req, res, 'projects', projectId)) return;
  const project = sqliteService.getProjects().find(p => p.id === projectId);
  if (!project) {
    return res.status(404).json({ error: `Project not found: ${projectId}` });
  }

  const effectiveOrg = (project.githubOrg || (typeof org === 'string' ? org : '') || '').trim();
  if (!effectiveOrg) {
    return res.status(400).json({
      error:
        'This project has no GitHub organization set. Choose one — Alpha does not create personal repositories.'
    });
  }

  try {
    const result = await createScaffoldedRepository({
      projectKey: project.key,
      repoName,
      org: effectiveOrg,
      stack,
      visibility: visibility ?? 'private',
      repoShape: shape ?? 'standalone',
      includeDocker: Boolean(includeDocker),
      ...(project.description ? { description: project.description } : {})
    });

    // Remember the organization on first use so later repositories in this
    // project cannot silently land somewhere else.
    if (!project.githubOrg) {
      sqliteService.updateProject(project.id, { githubOrg: effectiveOrg });
    }

    return res.status(201).json(result);
  } catch (err: any) {
    const msg = err?.message ?? 'Failed to scaffold repository';
    const isConflict = /already exists/i.test(msg);
    const isClientError =
      /^Invalid /i.test(msg) || /is not supported yet/i.test(msg) || /is required/i.test(msg);

    let status = 500;
    if (isConflict) status = 409;
    else if (isClientError) status = 400;

    return res.status(status).json({ error: msg });
  }
});

/**
 * POST /api/github/repos/clone
 * Body: { repo: "owner/name", intoDir }
 */
githubRouter.post('/github/repos/clone', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
  const { repo, intoDir } = req.body ?? {};
  if (!repo || !intoDir) {
    return res.status(400).json({ error: '"repo" and "intoDir" are required.' });
  }

  try {
    const localPath = await githubService.cloneRepository(repo, intoDir);
    return res.status(201).json({ path: localPath });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Failed to clone repository' });
  }
});

/**
 * POST /api/github/repos/fork
 * Body: { repo: "owner/name", cloneInto? }
 */
githubRouter.post('/github/repos/fork', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
  const { repo, cloneInto } = req.body ?? {};
  if (!repo) return res.status(400).json({ error: '"repo" is required.' });

  try {
    const result = await githubService.forkRepository(repo, cloneInto);
    return res.status(201).json({ result });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Failed to fork repository' });
  }
});

/**
 * GET /api/github/inspect?cwd=...
 */
githubRouter.get('/github/inspect', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  const raw = req.query.cwd;
  const cwd = typeof raw === 'string' ? raw : '';
  if (!cwd) return res.status(400).json({ error: 'A "cwd" query parameter is required.' });

  try {
    return res.json(await githubService.inspectLocalRepo(cwd));
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Failed to inspect repository' });
  }
});
