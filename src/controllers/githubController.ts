import { Request, Response, Router } from 'express';
import { githubService } from '../services/githubService.js';
import path from 'node:path';

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

/** Handle OAuth callback from GitHub */
githubRouter.get('/github/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string | undefined;
  if (!code) {
    return res.status(400).send('Missing "code" parameter');
  }

  try {
    // state is validated inside; a missing or unknown value is rejected.
    const result = await githubService.handleOAuthCallback(code, state);
    const redirectOrigin = (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
    return res.redirect(`${redirectOrigin}/#github_connected=true&username=${encodeURIComponent(result.username)}`);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'OAuth token exchange failed' });
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
  res.json(await githubService.listOrganizations());
});

githubRouter.get('/github/repos', async (req: Request, res: Response) => {
  const repos = await githubService.listRepositories();
  res.json(repos);
});

githubRouter.get('/github/runs', async (req: Request, res: Response) => {
  const cwd = (req.query.cwd as string) || path.resolve('..');
  const runs = await githubService.getWorkflowRuns(cwd);
  res.json(runs);
});

githubRouter.get('/github/runs/:id/logs', async (req: Request, res: Response) => {
  const cwd = (req.query.cwd as string) || path.resolve('..');
  const logs = await githubService.getFailedWorkflowLogs(cwd, req.params.id);
  res.json({ logs });
});

githubRouter.post('/github/pr', async (req: Request, res: Response) => {
  try {
    const { cwd = path.resolve('..'), title, body, base = 'main', headBranch } = req.body;
    const prUrl = await githubService.createPullRequest(cwd, title, body, base, headBranch);
    res.status(201).json({ prUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create PR' });
  }
});

githubRouter.post('/github/merge', async (req: Request, res: Response) => {
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
 * POST /api/github/repos/clone
 * Body: { repo: "owner/name", intoDir }
 */
githubRouter.post('/github/repos/clone', async (req: Request, res: Response) => {
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
  const raw = req.query.cwd;
  const cwd = typeof raw === 'string' ? raw : '';
  if (!cwd) return res.status(400).json({ error: 'A "cwd" query parameter is required.' });

  try {
    return res.json(await githubService.inspectLocalRepo(cwd));
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Failed to inspect repository' });
  }
});
