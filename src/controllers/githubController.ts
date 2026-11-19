import { NextFunction, Request, Response, Router } from 'express';
import { githubService } from '../services/githubService.js';
import { createPairedProject, createScaffoldedRepository } from '../services/repoScaffoldService.js';
import { projectStore } from '../store/stores.js';
import { SUPPORTED_STACKS } from '../services/scaffoldBuilder.js';
import path from 'node:path';
import { requireEntityWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { CORS_ORIGIN, ALPHA_ORG, GITHUB_CLIENT_ID, IS_CLOUD } from '../config/env.js';
import { GitHubApiError } from '../services/githubApi.js';
import { fetchTeamsWithToken, refreshIdentity, roleForLogin } from '../services/identityService.js';
import { supabaseService } from '../services/supabaseService.js';
import { sessionService } from '../services/sessionService.js';
import { SESSION_COOKIE, clearedSessionCookie, readCookie, sessionCookie } from './sessionContext.js';
import { logInfo, logError } from '../utils/logger.js';
import { desktopOnly } from './desktopOnly.js';
import { profileSummaries, removeProfile, switchToProfile } from '../services/alphaGitHubToken.js';

export const githubRouter = Router();

/**
 * Remembered desktop profiles. Only public account metadata is returned;
 * Alpha's active credential never crosses the local API boundary.
 */
githubRouter.get('/github/profiles', desktopOnly, (_req: Request, res: Response) => {
  res.json({ profiles: profileSummaries() });
});

githubRouter.post('/github/profiles/remove', desktopOnly, (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'A profile id is required.' });
  removeProfile(id);
  return res.json({ success: true });
});

/**
 * Switch to a remembered account without going to GitHub.
 *
 * Always 200 once the request is well formed: `switched: false` with a
 * `reason` is the answer, not an error -- the account was idle for a week, its
 * sign-in lapsed, or it could not be checked -- and the picker then asks GitHub
 * to authorize it instead. On a switch, the identity and the database token
 * held for the previous account are dropped, as sign-out drops them.
 */
githubRouter.post('/github/profiles/switch', desktopOnly, async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'A profile id is required.' });

  const result = await switchToProfile(id);
  if (!result.ok) {
    return res.json({ switched: false, reason: result.reason, ...(result.login ? { login: result.login } : {}) });
  }
  await refreshIdentity();
  supabaseService.forgetCredentials();
  return res.json({ switched: true, login: result.login });
});

/**
 * Renew a desktop's expiring GitHub token (cloud only).
 *
 * The desktop cannot hold the client secret GitHub requires for a refresh, so
 * it sends its refresh token here. Public: the refresh token is the proof, and
 * the desktop has no session to present.
 */
githubRouter.post('/github/oauth/desktop/refresh', async (req: Request, res: Response) => {
  const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (!refreshToken) return res.status(400).json({ error: 'A refresh token is required.' });
  try {
    return res.json(await githubService.refreshDesktopToken(refreshToken));
  } catch (err: any) {
    // Refused or expired: the desktop falls back to authorizing on GitHub.
    return res.status(401).json({ error: err?.message ?? 'GitHub would not renew the sign-in.' });
  }
});

githubRouter.get('/github/auth', async (req: Request, res: Response) => {
  const auth = await githubService.checkAuth();
  res.json(auth);
});

/**
 * Begin a fresh GitHub login. Hosted desktop builds receive an account-specific
 * OAuth URL; standalone/source builds receive a device code. The caller then
 * polls GET /github/auth until `authenticated` flips true.
 */
githubRouter.post('/github/auth/login', async (req: Request, res: Response) => {
  try {
    const profileLogin = typeof req.body?.profileLogin === 'string'
      ? req.body.profileLogin.trim()
      : undefined;
    res.json(await githubService.startDeviceLogin(profileLogin || undefined));
  } catch (err: any) {
    res.status(503).json({ error: err?.message ?? 'Could not start GitHub login' });
  }
});

/**
 * Which GitHub app a desktop should sign in to.
 *
 * An installed desktop carries only the four public settings baked into its
 * build, and a client id is not one of them -- so it asks the deployment it
 * belongs to rather than shipping a copy that would go stale if the app were
 * ever replaced. Public by construction: this id appears in every
 * authorisation URL GitHub ever shows a browser.
 */
githubRouter.get('/github/app/client', (_req: Request, res: Response) => {
  if (!GITHUB_CLIENT_ID) {
    res.status(503).json({ error: 'This deployment has no GitHub app configured.' });
    return;
  }
  res.json({ clientId: GITHUB_CLIENT_ID });
});

githubRouter.post('/github/auth/logout', async (req: Request, res: Response) => {
  try {
    await githubService.logout();
    /**
     * Forget who this was, not only the credential.
     *
     * The identity is resolved once and cached, so deleting the credential
     * changed nothing a request could see: the window reloaded onto the same
     * signed-in account, and every request went on being served as it, until
     * the app was restarted. Sign-out could not be done from the app at all.
     * Re-resolving now answers signed-out for an installed copy, and the
     * database token exchanged for the old account goes with it.
     */
    await refreshIdentity();
    supabaseService.forgetCredentials();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not sign out of GitHub' });
  }
});

/**
 * Start the browser OAuth flow for an installed desktop.
 *
 * The handoff token is generated by the local daemon and never appears in the
 * GitHub redirect. It is required to collect the one-time credential after
 * the hosted callback, so a copied OAuth state cannot be used to take it.
 */
githubRouter.post('/github/oauth/desktop/start', (req: Request, res: Response) => {
  try {
    const handoffToken = typeof req.body?.handoffToken === 'string' ? req.body.handoffToken.trim() : '';
    const profileLogin = typeof req.body?.login === 'string' ? req.body.login.trim() : undefined;
    if (!handoffToken) return res.status(400).json({ error: 'A desktop OAuth handoff token is required.' });
    return res.json(githubService.startDesktopOAuth(handoffToken, profileLogin || undefined));
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Could not start desktop GitHub authorization.' });
  }
});

/** Collect a completed desktop OAuth result once, or wait while GitHub is open. */
githubRouter.get('/github/oauth/desktop/result', (req: Request, res: Response) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const handoffToken = typeof req.query.handoff === 'string' ? req.query.handoff : '';
  if (!state || !handoffToken) return res.status(400).json({ error: 'The desktop OAuth handoff is incomplete.' });

  const result = githubService.takeDesktopOAuthResult(state, handoffToken);
  if (result.status === 'pending') return res.status(202).json(result);
  if (result.status === 'expired') return res.status(410).json({ error: result.message });
  if (result.status === 'failed') return res.status(400).json({ error: result.message });
  return res.json(result.credential);
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
  const desktopFlow = githubService.isDesktopOAuthState(state);

  try {
    // state is validated inside; a missing or unknown value is rejected.
    const result = await githubService.handleOAuthCallback(code, state);

    if (desktopFlow) {
      return res.status(200).type('html').send(
        '<!doctype html><html><head><title>Alpha authorization complete</title></head>' +
          '<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.5rem">' +
          '<h1>GitHub authorization complete</h1>' +
          '<p>You can close this tab and return to Alpha. The selected GitHub account is being loaded into the app.</p>' +
          '</body></html>'
      );
    }

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
    if (desktopFlow && state) githubService.failDesktopOAuth(state, err?.message ?? 'GitHub authorization failed.');
    // Back to the app, not a JSON blob in the address bar: this is a browser
    // navigation, and the person needs somewhere to retry from.
    return res.redirect(`${redirectOrigin}/#alpha_error=oauth_failed`);
  }
});

/** The signed-in user, or 401. The frontend's "who am I" on boot. */
githubRouter.get('/github/session', (req: Request, res: Response) => {
  if (!req.session) return res.status(401).json({ error: 'Not signed in.' });
  // Explicit public allowlist: never expose GitHub credentials or the
  // server-only ticket-authentication handle carried on this request.
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

githubRouter.get('/github/runs', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.read')) return;
  const cwd = (req.query.cwd as string) || path.resolve('..');
  const runs = await githubService.getWorkflowRuns(cwd);
  res.json(runs);
});

githubRouter.post('/github/dispatch', desktopOnly, async (req: Request, res: Response) => {
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

githubRouter.get('/github/runs/:id/logs', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.read')) return;
  const cwd = (req.query.cwd as string) || path.resolve('..');
  const logs = await githubService.getFailedWorkflowLogs(cwd, req.params.id);
  res.json({ logs });
});

githubRouter.post('/github/pr', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.manage')) return;
  try {
    const { cwd = path.resolve('..'), title, body, base = 'main', headBranch } = req.body;
    const prUrl = await githubService.createPullRequest(cwd, title, body, base, headBranch);
    res.status(201).json({ prUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create PR' });
  }
});

githubRouter.post('/github/merge', desktopOnly, async (req: Request, res: Response) => {
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
 * Create a GitHub repository. The workspace capability is PM-only: admins can
 * maintain projects, but repository provisioning belongs to the PM who
 * initiated the client work.
 * Body: { name, visibility?, description?, org?, sourceDir?, initReadme? }
 */
githubRouter.post('/github/repos', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.provision_repository')) return;
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
 * layer rather than only in the UI — the desktop daemon listens on localhost, where any
 * process on the machine can post here, and the hosted server faces the internet,
 * so the PM-only policy must be enforced at the route as well as in the form.
 */
githubRouter.post('/github/repos/scaffold', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.provision_repository')) return;
  const { projectId, repoName, stack, org, visibility, shape, includeDocker, deploy, frontendStack, backendStack } =
    req.body ?? {};
  const paired = shape === 'paired';

  if (!projectId || typeof projectId !== 'string') {
    return res.status(400).json({ error: 'A "projectId" is required.' });
  }
  if (!repoName || typeof repoName !== 'string') {
    return res.status(400).json({ error: 'A repository "repoName" is required.' });
  }
  if (paired) {
    if (!['react', 'nextjs'].includes(frontendStack) || !['nodejs', 'nestjs'].includes(backendStack)) {
      return res.status(400).json({
        error: 'A paired project needs "frontendStack" (react or nextjs) and "backendStack" (nodejs or nestjs).'
      });
    }
  } else if (!stack || !SUPPORTED_STACKS.includes(stack)) {
    return res.status(400).json({
      error: `"stack" must be one of: ${SUPPORTED_STACKS.join(', ')}.`
    });
  }
  if (deploy !== undefined && typeof deploy !== 'boolean') {
    return res.status(400).json({ error: '"deploy" must be true or false.' });
  }
  if (visibility && !['private', 'public'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility must be private or public.' });
  }

  if (!requireEntityWorkspace(req, res, 'projects', projectId)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, projectId);
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
  // On the hosted server this route faces the internet, not one machine: keep repositories in
  // Alpha's own organization, as hosting already does.
  if (IS_CLOUD && effectiveOrg.toLowerCase() !== ALPHA_ORG.toLowerCase()) {
    return res.status(403).json({ error: ALPHA_ORG
      ? `Repositories can only be created in ${ALPHA_ORG}.`
      : 'This server has no GitHub organization configured (ALPHA_ORG), so it cannot create repositories.' });
  }

  try {
    const common = {
      projectKey: project.key,
      repoName,
      org: effectiveOrg,
      visibility: visibility ?? 'private',
      includeDocker: Boolean(includeDocker),
      workspaceId: req.workspace!.workspaceId,
      ...(deploy === undefined ? {} : { deploy }),
      ...(project.description ? { description: project.description } : {})
    };
    // Standalone answers the repository itself, as before; paired answers both.
    const result = paired
      ? { shape: 'paired', repositories: await createPairedProject({ ...common, frontendStack, backendStack }) }
      : await createScaffoldedRepository({ ...common, stack, repoShape: shape ?? 'standalone' });

    // Record the repositories on the project here, in the same request, and remember the
    // organization on first use so later repositories cannot land somewhere else. The form
    // used to do the recording with a second request; when that was lost (a closed tab after
    // a slow scaffold), the repositories existed on GitHub with nothing in Alpha pointing at them.
    const created = 'repositories' in result ? result.repositories : [result];
    const stacks = paired ? [backendStack, frontendStack] : [stack];
    const known = new Set((project.resources ?? []).map(resource => resource.pathOrUrl.toLowerCase()));
    const stamp = Date.now();
    const added = created.filter(repo => !known.has(repo.url.toLowerCase())).map((repo, index) => ({
      id: `res-${stamp}-${index}`, type: 'github_repo' as const, name: repo.nameWithOwner, pathOrUrl: repo.url,
      // Work lands on dev; uat and main only move by promotion.
      branchOrMachine: 'dev', stack: stacks[created.indexOf(repo)], shape: paired ? 'paired' as const : 'standalone' as const,
      ...(repo.localPath ? { localPath: repo.localPath } : {})
    }));
    await projectStore().update(req.workspace!.workspaceId, project.id, {
      ...(added.length ? { resources: [...(project.resources ?? []), ...added] } : {}),
      ...(project.githubOrg ? {} : { githubOrg: effectiveOrg })
    });

    return res.status(201).json(result);
  } catch (err: any) {
    const msg = err?.message ?? 'Failed to scaffold repository';
    // GitHub's own refusals keep their meaning: signed out is 401, not allowed is 403, not "server error".
    if (err instanceof GitHubApiError && (err.status === 401 || err.status === 403)) {
      return res.status(err.status).json({ error: msg });
    }
    const isConflict = /already exists/i.test(msg);
    const isClientError =
      /^Invalid /i.test(msg) || /is not supported yet/i.test(msg) || /is required/i.test(msg);

    let status = 500;
    if (isConflict) status = 409;
    else if (isClientError) status = 400;
    // The CI template lives in alphaorch-workflow; not reaching it is upstream.
    else if (/Could not read the CI template/.test(msg)) status = 502;

    return res.status(status).json({ error: msg });
  }
});

/**
 * POST /api/github/repos/clone
 * Body: { repo: "owner/name", intoDir }
 */
githubRouter.post('/github/repos/clone', desktopOnly, async (req: Request, res: Response) => {
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
  if (!requireWorkspaceCapability(req, res, 'project.provision_repository')) return;
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
githubRouter.get('/github/inspect', desktopOnly, async (req: Request, res: Response) => {
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
