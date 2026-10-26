import { Request, Response, Router } from 'express';
import { route } from './asyncRoute.js';
import { agentLearningService, AgentLessonError } from '../services/agentLearningService.js';
import { agentStore, boardChangeStore, issueStore, projectStore, runStore, squadStore } from '../store/stores.js';
import { currentIdentity, refreshIdentity } from '../services/identityService.js';
import { ALPHA_ORCHESTRATION_ENABLED, ALPHA_ORG, IS_CLOUD } from '../config/env.js';
import { githubService } from '../services/githubService.js';
import { mintSupabaseToken } from '../services/supabaseTokenService.js';
import { exchangeGitHubToken } from '../services/databaseTokenExchange.js';
import { syncBoardFromGitHub } from '../services/githubBoardSync.js';
import { pushIssue, needsPush, publishNewIssue, publishedFields } from '../services/githubBoardWrite.js';
import { issueIdFor } from '../services/githubRepoDiscovery.js';
import { supabaseService } from '../services/supabaseService.js';
import { pullSharedBoard, applySharedBoardChanges, asSyncReport } from '../services/sharedBoard.js';
import { sqliteService } from '../services/sqliteService.js';
import { machineRuntimes } from '../services/machineRuntimes.js';
import { BUILTIN_SKILLS } from '../services/builtinSkills.js';
import { BuildStepError } from '../store/buildSteps.js';
import { ProjectLinkedToTicketError } from '../store/projectStore.js';
import { agentValidationError } from './agentValidation.js';
import { checkWorkspace } from './workspaceValidation.js';
import {
  BindingError,
  bindProject,
  boundCheckoutStatus,
  cloneAndBindProject,
  cloneProjectInto,
  projectBinding,
  repositoryCheckouts,
  unbindProject
} from '../services/projectBindings.js';
import {
  codeFolder,
  defaultCodeFolder,
  ensureAllProjectFolders,
  ensureDefaultProjectFolders,
  ensureProjectFolder,
  locateProjectRepositories,
  setCodeFolder,
  setProjectFolder,
  useFoundCopy
} from '../services/projectFolders.js';
import { AgentBuilderError, sendBuilderMessage } from '../services/agentBuilderService.js';
import {
  AGENT_FILE_MAX_BYTES,
  agentFilePath,
  agentFromFileContent,
  parseAgentFileContent,
  readAgentFile,
  readAgentFileRaw,
  writeAgentFileRaw
} from '../services/agentFileService.js';
import { resolveAgent } from '../services/personaService.js';
import { agentReadiness } from '../services/agentReadiness.js';
import { Agent, Issue, IssueStatus } from '../models/index.js';
import { logError, logInfo } from '../utils/logger.js';
import { SKILL_TOOLS } from '../services/toolPolicy.js';
import {
  requireDiscoverableProject,
  requireEntityWorkspace,
  requireProjectWorkspace,
  requireSquadWorkspace,
  requireWorkspaceCapability
} from './workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { desktopOnly } from './desktopOnly.js';
import { BoardChangeSync, BoardCursorError, boardStateRowCount, type BoardChangeAccess, type BoardCursor } from '../services/boardChangeSync.js';
import { recordBoardSyncMetric } from '../services/boardSyncMetrics.js';

export const dataRouter = Router();

async function boardChangeSyncFor(req: Request): Promise<BoardChangeSync | null> {
  const workspaceId = req.workspace!.workspaceId;
  const access: BoardChangeAccess = {
    canReadIssues: workspaceRegistry.can(req.workspace!.role, 'issue.read'),
    canReadAgents: workspaceRegistry.can(req.workspace!.role, 'agent.read'),
    canReadSquads: workspaceRegistry.can(req.workspace!.role, 'squad.read')
  };

  if (IS_CLOUD) {
    // The cloud connection bypasses RLS; apply the same visible-project set
    // that GET /projects and GET /issues use before reading current rows.
    const projects = await projectStore().list(workspaceId);
    access.allowedProjectIds = workspaceRegistry.projectIdsFor(
      req.workspace!,
      projects.map(project => project.id)
    );
    return new BoardChangeSync(boardChangeStore(), access);
  }

  // A desktop's Supabase client carries the token exchanged for this user.
  // Never substitute a service-role client for this row-level path.
  const source = supabaseService.boardChangeSource();
  return source ? new BoardChangeSync(source, access) : null;
}

function recordBoardResponseMetric(
  req: Request,
  workspaceId: string,
  kind: 'snapshot' | 'delta',
  changedRows: number,
  response: unknown
): void {
  const serialized = JSON.stringify(response) ?? '';
  recordBoardSyncMetric({
    workspaceId,
    clientVersion: req.header('X-Alpha-Client-Version') ?? 'unknown',
    kind,
    changedRows,
    responseBytes: Buffer.byteLength(serialized, 'utf8')
  });
}

async function publishSharedAgentCopies(agent: Agent, workspaceIds: string[]): Promise<void> {
  if (!agent.sharedKey) return;
  await Promise.all([...new Set(workspaceIds)].map(workspaceId => runWithWorkspace(workspaceId, async () => {
    const copy = (await agentStore().list(workspaceId)).find(candidate => candidate.sharedKey === agent.sharedKey);
    if (copy) await supabaseService.shareAgent(copy);
  })));
}

/**
 * Who Alpha thinks you are.
 *
 * The browser had no way to ask: `currentUser` was picked from a mock array by
 * whichever role the switcher was on. This is the GitHub login the org, the
 * teams and every pull request already use, or the OS username when GitHub is
 * not signed in — `source` says which, so the UI can be honest about it.
 */
dataRouter.get('/me', async (req: Request, res: Response) => {
  /**
   * Answered from the session in the cloud, from `gh` on the desktop.
   *
   * `currentIdentity()` unconditionally was the same defect one level up from
   * `workspaceContext`: a process-global read of the local CLI, which in a
   * container is the OS user. The browser's "who am I" would have come back as
   * the same person for everyone, and the UI would have drawn their role.
   *
   * Always 200, never 401. This is the probe the app makes on boot to find out
   * whether it needs to show a sign-in, and an error status would put that
   * answer on the failure path where the existing caller already swallows it.
   * `authenticated: false` is a fact about the caller, not a failure to read
   * it.
   */
  if (IS_CLOUD) {
    if (!req.session) {
      let signInUrl: string | undefined;
      try {
        signInUrl = githubService.getOAuthLoginUrl().url;
      } catch {
        // OAuth not configured yet. The app can still say "sign in", it just
        // cannot say where to — better than rendering a dead button.
      }
      return res.json({ authenticated: false, signInUrl });
    }

    const { login, name, role } = req.session;
    return res.json({
      authenticated: true,
      login,
      name,
      role,
      source: 'github',
      workspaceOrg: ALPHA_ORG,
      access: 'granted',
      github: 'ok'
    });
  }

  /**
   * `?refresh=1` re-reads `gh` instead of answering from the boot-time cache.
   *
   * The identity is resolved once and reused, so a teammate who signed in to
   * GitHub while the app was open -- from the in-app sign-in, or a terminal --
   * stayed "signed out" until they restarted it; "I've done this" could never
   * work. The explicit flag keeps every other request on the cache: resolving
   * spawns `gh`, and doing that per request would put a subprocess behind
   * every board action while signed out.
   */
  if (req.query.refresh === '1') await refreshIdentity();
  return res.json({ authenticated: true, ...(await currentIdentity()) });
});

/**
 * A short-lived token for talking to the database directly.
 *
 * The browser and the desktop both need one: the web app to subscribe to
 * Supabase Realtime, the desktop daemon to read and write the board without
 * paying Render's cold start on every action. Neither can present Alpha's
 * session cookie to Supabase.
 *
 * Deliberately not the session. A session is revocable and long-lived; this is
 * neither, because nothing consults a blocklist on every row read — so it
 * lives ten minutes and the caller re-asks.
 *
 * Minted from `req.workspace`, which the middleware already resolved, so the
 * claims cannot be chosen by the caller. Asking for a token for a workspace
 * you are not a member of fails earlier, in `workspaceContext`.
 */
dataRouter.get('/database/token', async (req: Request, res: Response) => {
  if (!req.workspace) return res.status(401).json({ error: 'Sign in to use Alpha.' });

  /**
   * A desktop hands over the token it got from the cloud.
   *
   * Minting needs the JWT secret, which only the cloud holds, so this used to
   * answer 503 on every desktop -- the renderer fell back to the anon key, the
   * private board channel refused it, and a desktop never heard of a write.
   */
  if (!IS_CLOUD) {
    const exchanged = await supabaseService.databaseToken();
    if (!exchanged) {
      return res.status(503).json({ error: 'This desktop is not connected to the team board.' });
    }
    return res.json(exchanged);
  }

  try {
    const { token, expiresAt } = mintSupabaseToken({
      sub: req.workspace.userId,
      workspace_id: req.workspace.workspaceId,
      alpha_role: req.workspace.role
    });
    return res.json({ token, expiresAt });
  } catch (err: any) {
    // Unconfigured is a deployment gap, not a client error: say so plainly
    // rather than letting the browser retry a 500 forever.
    return res.status(503).json({ error: err?.message ?? 'Database tokens are not configured.' });
  }
});

/**
 * The desktop's way to the same token: a GitHub token in, a database token out.
 *
 * Public in `workspaceContext` because it authenticates itself -- the desktop
 * has no session cookie to present. Everything in the minted token comes from
 * GitHub, not from the caller; see `databaseTokenExchange.ts`. Cloud only: a
 * desktop daemon has no business issuing tokens to anyone.
 */
dataRouter.post('/database/token/exchange', async (req: Request, res: Response) => {
  if (!IS_CLOUD) {
    return res.status(404).json({ error: 'Only the cloud service issues database tokens.' });
  }

  const githubToken = /^Bearer\s+(\S+)\s*$/i.exec(req.header('Authorization') ?? '')?.[1];
  const result = await exchangeGitHubToken(
    githubToken,
    req.header('X-Workspace-Id') || undefined,
    (login, workspaceId, role) => workspaceRegistry.resolve(login, workspaceId, role)
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.json({ token: result.token, expiresAt: result.expiresAt });
});

/** One initial shared-board snapshot, anchored before the rows are read. */
dataRouter.get('/board/bootstrap', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  if (!IS_CLOUD) {
    const workspaceId = req.workspace!.workspaceId;
    const source = supabaseService.boardSource();
    const changeSource = supabaseService.boardChangeSource();
    if (!source || !changeSource) return res.status(503).json({ error: 'This desktop is not connected to the team board.' });
    try {
      // The watermark brackets the one local SQLite snapshot; newer writes
      // are replayed from it by the next page request.
      const value = await changeSource.watermark(workspaceId);
      const pulled = await pullSharedBoard(workspaceId, source, req.workspace!.userId);
      sqliteService.setBoardSyncCursor(workspaceId, value);
      const response = {
        workspaceId,
        cursor: { workspaceId, value },
        ...pulled.snapshot
      };
      recordBoardResponseMetric(req, workspaceId, 'snapshot', boardStateRowCount(response), response);
      return res.json(response);
    } catch (error: any) {
      return res.status(502).json({ error: `Could not read the team board: ${error?.message ?? error}` });
    }
  }
  const sync = await boardChangeSyncFor(req);
  if (!sync) return res.status(503).json({ error: 'This desktop is not connected to the team board.' });
  const workspaceId = req.workspace!.workspaceId;
  const bootstrap = await sync.bootstrap(workspaceId);
  recordBoardResponseMetric(req, workspaceId, 'snapshot', boardStateRowCount(bootstrap), bootstrap);
  return res.json(bootstrap);
}));

/** A bounded page after one device's last successfully applied workspace cursor. */
dataRouter.post('/board/changes', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  const cursor = req.body?.cursor as BoardCursor | undefined;
  if (!cursor || typeof cursor.workspaceId !== 'string' || typeof cursor.value !== 'string') {
    return res.status(400).json({ error: 'A workspace cursor is required.' });
  }
  const requestedLimit = req.body?.limit ?? 100;
  if (typeof requestedLimit !== 'number' || !Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return res.status(400).json({ error: 'The page limit must be a positive whole number.' });
  }

  const sync = await boardChangeSyncFor(req);
  if (!sync) return res.status(503).json({ error: 'This desktop is not connected to the team board.' });
  try {
    const page = await sync.changes(req.workspace!.workspaceId, cursor, Math.min(requestedLimit, 100));
    if (!IS_CLOUD && supabaseService.sharesBoard() && !page.resetRequired) {
      await applySharedBoardChanges(req.workspace!.workspaceId, page);
    }
    recordBoardResponseMetric(req, req.workspace!.workspaceId, 'delta', page.changes.length, page);
    return res.json(page);
  } catch (error) {
    if (error instanceof BoardCursorError) return res.status(400).json({ error: error.message });
    throw error;
  }
}));

/**
 * Read the shared board down from GitHub.
 *
 * Explicit rather than automatic: a sync makes GitHub requests for every
 * project and rewrites cards, and doing that on a timer nobody asked for would
 * make the board move under someone mid-sentence. The UI calls this on demand.
 */
dataRouter.post('/board/sync', route(async (req: Request, res: Response) => {
  /**
   * On a team's desktop, the team's board.
   *
   * Pulled from the cloud rather than synced from GitHub: the cloud is the one
   * writer that reads GitHub, and a desktop reading it too would name the same
   * issues under ids of its own. Anyone who can see projects may pull -- it
   * changes nothing but this machine's copy -- which also ends developers
   * being refused their own board: this route asked for `project.manage`, which
   * no developer has, while the app showed them the Sync button.
   */
  if (supabaseService.sharesBoard()) {
    if (!requireWorkspaceCapability(req, res, 'project.read')) return;
    const source = supabaseService.boardSource();
    const changeSource = supabaseService.boardChangeSource();
    if (!source || !changeSource) return res.status(503).json({ error: 'This desktop is not connected to the team board.' });
    try {
      // Who is pulling, so a project the team dropped leaves this machine too.
      const cursor = await changeSource.watermark(req.workspace!.workspaceId);
      const pulled = await pullSharedBoard(req.workspace!.workspaceId, source, req.workspace!.userId);
      sqliteService.setBoardSyncCursor(req.workspace!.workspaceId, cursor);
      /**
       * Then this machine's own agents, which the team does not have. An issue
       * that names one refers to a row the cloud has to hold, or the card is
       * refused when it is shared. Squads were removed and are not published.
       */
      for (const agent of pulled.unpublished.agents) await supabaseService.shareAgent(agent);
      // Every project that reached this computer gets its folder.
      runWithWorkspace(req.workspace!.workspaceId, () => ensureDefaultProjectFolders(sqliteService.getProjects()));
      res.json(asSyncReport(pulled));
    } catch (err: any) {
      /**
       * Supabase checks the `apikey` header before anything else, and that
       * header is the anon key baked into this build. When it is refused no
       * retry or re-sign-in can help -- only an installer built with the
       * project's current key -- so say that instead of the bare message.
       */
      if (/invalid api key/i.test(String(err?.message ?? ''))) {
        return res.status(502).json({
          error:
            'Could not read the team board: Supabase rejected the API key this desktop build carries. ' +
            'Signing in again will not fix it; install a build made with the current key.'
        });
      }
      res.status(502).json({ error: `Could not read the team board: ${err?.message ?? err}` });
    }
    return;
  }

  /**
   * Meant to be on the team board and not: say so, and why.
   *
   * Falling through to the GitHub sync below refused every developer with
   * "Your workspace role cannot project manage" -- true, and no help at all,
   * when the real problem was a client that never started.
   */
  const problem = supabaseService.connectionProblem();
  if (problem) {
    return res.status(503).json({ error: `This desktop is not connected to the team board: ${problem}` });
  }

  if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
  const report = await syncBoardFromGitHub(req.workspace!.workspaceId);
  // 200 even with per-project errors: a workspace where one repository is
  // unreachable still synced the others, and the report says which failed.
  res.json(report);
}));

// --- Projects ---
/**
 * The workspace's projects, and which of them are this caller's work.
 *
 * Every project, not only the assigned ones: a developer could not see the
 * project they were about to be put on, nor bind it to a folder on their
 * machine before someone assigned them an issue in it. `assigned` says which
 * are theirs to work in, so the app can separate what they are on from what
 * the workspace has. Clients still see only what they are assigned to.
 */
dataRouter.get('/projects', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  const projects = await projectStore().list(req.workspace!.workspaceId);
  res.json(
    workspaceRegistry
      .discoverableProjects(projects, req.workspace!)
      .map(project => ({
        ...project,
        assigned: workspaceRegistry.canAccessProject(req.workspace!, project.id)
      }))
  );
}));

dataRouter.post('/projects', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.create')) return;
  /*
   * The creator is the person signed in, never what the request says: a
   * client-sent `createdBy` would let anyone put a project under a PM's name,
   * and that name is what puts a project in the workspace's catalogue.
   */
  const { createdBy: _claimed, ...input } = req.body ?? {};
  const workspaceId = req.workspace!.workspaceId;
  if (!String(input.name ?? '').trim()) return res.status(400).json({ error: 'Project name is required.' });
  if (typeof input.leadSquadId === 'string' && input.leadSquadId.trim()) {
    return res.status(410).json({ error: 'Squads were removed. The Orchestrator assigns agents to each build task by role.' });
  }
  if (input.leadAgentId != null && typeof input.leadAgentId !== 'string') {
    return res.status(400).json({ error: 'Choose a valid project owner.' });
  }
  const leadAgentId = typeof input.leadAgentId === 'string' ? input.leadAgentId.trim() : '';
  const owner = leadAgentId ? await agentStore().get(workspaceId, leadAgentId) : undefined;
  if (leadAgentId && (!owner || owner.isArchived)) return res.status(400).json({ error: 'The project owner is no longer available in this workspace.' });
  const { leadSquadId: _retiredSquad, ...projectInput } = input;
  const project = await projectStore().create(workspaceId, {
    ...projectInput,
    leadType: 'agent',
    leadName: owner?.name ?? 'Orchestrator',
    leadAgentId: leadAgentId || undefined,
    status: 'planned',
    createdBy: req.workspace!.userId
  });
  workspaceRegistry.bind('projects', project.id, req.workspace!.workspaceId);
  // On a desktop, the project's folder exists from the moment the project does.
  if (!IS_CLOUD) runWithWorkspace(workspaceId, () => ensureDefaultProjectFolders([project]));
  // On a team's desktop, onto the team's board: nobody else sees it otherwise.
  await supabaseService.shareProject(project);
  res.status(201).json(project);
}));

/**
 * Check a folder before it becomes a project's working copy.
 *
 * Separate from the update so the panel can tell someone their path is wrong
 * while they are still typing it, rather than at the start of an agent run.
 */
dataRouter.post('/projects/check-workspace', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  res.json(checkWorkspace(req.body?.path));
});

/**
 * Where this machine keeps a project's code.
 *
 * Read by anyone who can see the project -- the app shows "open in the
 * desktop app" or the path, and both need the answer. Null in the cloud,
 * truthfully: Render has no checkout of anything.
 */
dataRouter.get('/projects/:id/binding', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  if (IS_CLOUD) return res.json(null);
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  res.json(project ? projectBinding(project) : null);
}));

/**
 * Each of the project's repositories, and where this machine has it -- or
 * that it does not. What the "on this machine" state of each repository row
 * is drawn from. Empty in the cloud, which keeps no checkouts.
 */
dataRouter.get('/projects/:id/checkouts', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  if (IS_CLOUD) return res.json({ checkouts: [] });
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ checkouts: await repositoryCheckouts(project) });
}));

/**
 * Point this machine at a folder for one of the project's repositories. The
 * developer's own act. `repo` is optional: the folder's origin says which.
 */
dataRouter.put('/projects/:id/binding', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const repo = typeof req.body?.repo === 'string' && req.body.repo.trim() ? req.body.repo.trim() : undefined;
    res.json(await bindProject(project, req.body?.localDir, repo ? { repo } : {}));
  } catch (err) {
    if (err instanceof BindingError) return res.status(400).json({ error: err.message, reason: err.reason });
    throw err;
  }
}));

/**
 * Clone the project's repositories here and bind them, in one press: the one
 * named in `repo`, or every one this machine does not have yet. Answers the
 * checkouts it bound.
 *
 * Idempotent: a checkout already at the managed path is bound rather than
 * refused, so pressing it again after a failed clone finishes the job.
 */
dataRouter.post('/projects/:id/clone', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const repo = typeof req.body?.repo === 'string' && req.body.repo.trim() ? req.body.repo.trim() : undefined;
    res.json(await cloneAndBindProject(project, repo));
  } catch (err) {
    if (err instanceof BindingError) return res.status(400).json({ error: err.message, reason: err.reason });
    // A clone can fail for a dozen reasons on the far side -- no access, no
    // network, a repository that has moved -- and git says which.
    return res.status(502).json({ error: String((err as Error)?.message ?? err) });
  }
}));

/**
 * Clone some of the project's repositories into a folder the developer chose on
 * this computer, and optionally make them this machine's working copies. Like
 * the managed clone above, this is the developer's own act on their own disk.
 * Answers one result per repository, so one failure does not hide the others.
 */
dataRouter.post('/projects/:id/clone-to', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    // No folder named: the project's own folder.
    const intoDir = typeof req.body?.intoDir === 'string' && req.body.intoDir.trim() ? req.body.intoDir : ensureProjectFolder(project);
    res.json({ results: await cloneProjectInto(project, intoDir, req.body?.repos, req.body?.bind === true) });
  } catch (err) {
    if (err instanceof BindingError) return res.status(400).json({ error: err.message, reason: err.reason });
    throw err;
  }
}));

/**
 * The project's folder on this computer, and each repository's state there:
 * registered, found in the project folder, moved, or missing. Looks in two
 * places only -- the registered folder and <project folder>\<repository> --
 * so it answers at once.
 */
dataRouter.get('/projects/:id/folder', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  ensureDefaultProjectFolders([project]);
  res.json(locateProjectRepositories(project));
}));

/** Choose the project's folder on this computer; `dir: null` goes back to the default. */
dataRouter.put('/projects/:id/folder', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    setProjectFolder(project, req.body?.dir ?? null);
    ensureDefaultProjectFolders([project]);
    res.json(locateProjectRepositories(project));
  } catch (err) {
    if (err instanceof BindingError) return res.status(400).json({ error: err.message, reason: err.reason });
    throw err;
  }
}));

/** Use the copy of `repo` found in the project folder, so builds branch from it too. */
dataRouter.post('/projects/:id/folder/use', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    await useFoundCopy(project, req.body?.repo);
    res.json(locateProjectRepositories(project));
  } catch (err) {
    if (err instanceof BindingError) return res.status(400).json({ error: err.message, reason: err.reason });
    throw err;
  }
}));

/** This computer's code folder: where project folders go unless one is chosen. */
dataRouter.get('/machine/code-folder', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  res.json({ codeFolder: codeFolder(), defaultCodeFolder: defaultCodeFolder() });
});

dataRouter.put('/machine/code-folder', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  try {
    setCodeFolder(req.body?.dir ?? null);
    // The new place gets every project's folder straight away.
    ensureAllProjectFolders();
    res.json({ codeFolder: codeFolder(), defaultCodeFolder: defaultCodeFolder() });
  } catch (err) {
    if (err instanceof BindingError) return res.status(400).json({ error: err.message, reason: err.reason });
    throw err;
  }
});

/**
 * What state this machine's checkout is in.
 *
 * Read from git each time rather than remembered: the developer works in this
 * folder outside Alpha all day, and a remembered branch is a wrong one.
 */
dataRouter.get('/projects/:id/binding/status', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(await boundCheckoutStatus(project));
}));

dataRouter.delete('/projects/:id/binding', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.bind_local')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  // `?repo=owner/name` forgets one repository's folder; none forgets them all.
  const repo = typeof req.query.repo === 'string' && req.query.repo.trim() ? req.query.repo.trim() : undefined;
  res.json({ success: unbindProject(req.params.id, repo) });
}));

dataRouter.put('/projects/:id', route(async (req: Request, res: Response) => {
  // Developers run projects too; see `project.update`. Any project in the
  // catalogue, not only an assigned one: this is the project, not its work.
  if (!requireWorkspaceCapability(req, res, 'project.update')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  /**
   * A folder that cannot hold a branch is refused here.
   *
   * `resolveProjectWorkspace` prefers a managed checkout and falls back to an
   * attached folder, so a bad `local_path` only bites once a run reaches the
   * workspace stage — where the failure is caught, logged as a notice, and the
   * run continues without a branch. Rejecting the attachment is the only point
   * at which the person can still see which field was wrong.
   */
  const attached = (req.body?.resources ?? []).find(
    (r: any) => r?.type === 'local_path' || r?.type === 'local_dir'
  );

  /**
   * Not in the cloud, which has no folder of anyone's to check: the path is on
   * a developer's disk, and the Postgres store drops local paths on write.
   */
  if (attached && !IS_CLOUD) {
    const check = checkWorkspace(attached.pathOrUrl);
    if (!check.ok) return res.status(400).json({ error: check.detail });
  }

  // Who created it is not something an edit can change.
  const { createdBy: _owner, leadName: _leadName, leadType: _leadType, ...changes } = req.body ?? {};
  if (typeof changes.leadSquadId === 'string' && changes.leadSquadId.trim()) {
    return res.status(410).json({ error: 'Squads were removed. The Orchestrator assigns agents to each build task by role.' });
  }
  delete changes.leadSquadId;
  if (Object.prototype.hasOwnProperty.call(changes, 'leadAgentId')) {
    if (changes.leadAgentId != null && typeof changes.leadAgentId !== 'string') {
      return res.status(400).json({ error: 'Choose a valid project owner.' });
    }
    const leadAgentId = typeof changes.leadAgentId === 'string' ? changes.leadAgentId.trim() : '';
    const owner = leadAgentId ? await agentStore().get(req.workspace!.workspaceId, leadAgentId) : undefined;
    if (leadAgentId && (!owner || owner.isArchived)) return res.status(400).json({ error: 'The project owner is no longer available in this workspace.' });
    changes.leadAgentId = leadAgentId;
    changes.leadName = owner?.name ?? 'Orchestrator';
    changes.leadType = 'agent';
  }
  const updated = await projectStore().update(req.workspace!.workspaceId, req.params.id, changes);
  if (!updated) return res.status(404).json({ error: 'Project not found' });
  void supabaseService.shareProject(updated);
  res.json(updated);
}));

dataRouter.delete('/projects/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
  if (!requireProjectWorkspace(req, res, req.params.id)) return;
  let deleted: boolean;
  try {
    deleted = await projectStore().remove(req.workspace!.workspaceId, req.params.id);
  } catch (error) {
    if (error instanceof ProjectLinkedToTicketError) {
      return res.status(409).json({ error: 'This project is linked to one or more client tickets. Unlink those tickets before deleting the project.' });
    }
    throw error;
  }
  if (deleted) {
    await workspaceRegistry.unbind('projects', req.params.id);
    void supabaseService.unshareProject(req.params.id);
  }
  res.json({ success: deleted });
}));

/**
 * Local capability endpoint for desktop project builds. Orchestration is
 * always enabled on desktop; neither this endpoint nor its compatibility
 * write route grants repository or agent permissions.
 */
dataRouter.get('/projects/:id/orchestration-settings', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (IS_CLOUD) {
    return res.json({ enabled: false, available: false, localOnly: true,
      reason: 'Task orchestration runs on an authorized Alpha desktop with the repository checkout.' });
  }
  const setting = runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.getProjectOrchestrationSetting(project.id));
  res.json({ ...setting, enabled: true, available: ALPHA_ORCHESTRATION_ENABLED, localOnly: true,
    reason: ALPHA_ORCHESTRATION_ENABLED ? undefined : 'The Orchestrator is unavailable in this desktop version. Update the app before starting a build.' });
}));

dataRouter.put('/projects/:id/orchestration-settings', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.update')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  if (!req.body.enabled) return res.status(400).json({ error: 'Project orchestration is always enabled on desktop.' });
  const project = await projectStore().get(req.workspace!.workspaceId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const setting = runWithWorkspace(req.workspace!.workspaceId, () =>
    sqliteService.setProjectOrchestrationEnabled(project.id, req.body.enabled, req.workspace!.userId)
  );
  res.json({ ...setting, available: ALPHA_ORCHESTRATION_ENABLED, localOnly: true,
    reason: ALPHA_ORCHESTRATION_ENABLED ? undefined : 'The Orchestrator is unavailable in this desktop version. Update the app before starting a build.' });
}));

// --- Project Build Room ---

/**
 * A project's build steps.
 *
 * These two routes checked nothing: any signed-in caller could read or replace
 * the steps of any project, in any workspace, by id. Reading now needs the
 * project to be one you can see; replacing it, the role the database's own
 * policy already required ("overseers write build steps").
 */
dataRouter.get('/projects/:id/build-steps', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  // The pipeline is the project's, like its details: whoever may edit it may read it.
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  const steps = await projectStore().getBuildSteps(req.workspace!.workspaceId, req.params.id);
  if (!steps) return res.status(404).json({ error: 'Project not found' });
  res.json(steps);
}));

dataRouter.put('/projects/:id/build-steps', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'project.update')) return;
  if (!requireDiscoverableProject(req, res, req.params.id)) return;
  try {
    const steps = await projectStore().saveBuildSteps(req.workspace!.workspaceId, req.params.id, req.body?.steps);
    if (!steps) return res.status(404).json({ error: 'Project not found' });
    res.json(steps);
  } catch (err) {
    if (err instanceof BuildStepError) return res.status(400).json({ error: err.message });
    throw err;
  }
}));

// --- Agents ---

/**
 * The agent as it will actually behave, plus which fields the file decides.
 *
 * The list previously returned raw database rows while runs resolved the
 * persona file over the top, so a card could read `claude-sonnet-5` for an
 * agent running on something else entirely. Merging here makes the card honest.
 *
 * `managedByFile` is what stops the merge becoming a new lie: without it the UI
 * would offer an editable input holding a value it cannot change, and the next
 * save would appear to work and then revert on reload. The client uses it to
 * mark those fields read-only and point at the persona file instead.
 */
function withFileOverlay(agent: Agent, runtimes = machineRuntimes()) {
  let overlay: ReturnType<typeof readAgentFile> = null;
  try {
    overlay = readAgentFile(agent.id);
  } catch {
    // An unreadable or badly-named persona file must not take the roster down.
  }

  const merged = overlay
    ? { ...agent, ...overlay, managedByFile: Object.keys(overlay) }
    : { ...agent, managedByFile: [] as string[] };

  /**
   * Whether the CLI behind this agent is actually usable on this machine.
   *
   * Alpha holds no credentials, so an agent is only as available as the binary
   * it spawns — and that differs per machine and per person. Attached here
   * because the roster is where someone looks before sending a message, rather
   * than after one has already failed.
   */
  const readiness = agentReadiness(merged, runtimes);
  const machineStatus = merged.isArchived
    ? 'offline'
    : readiness.status === 'ready'
      ? 'online'
      : readiness.status === 'unknown'
        ? 'unstable'
        : 'offline';

  // The SQLite row cannot know whether this machine has the provider CLI or a
  // valid session. Derive the roster indicator from the same runtime scan that
  // produces the actionable readiness notice instead of returning "online"
  // for every non-archived agent.
  return { ...merged, machineStatus, readiness };
}

dataRouter.get('/agents', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  await agentStore().ensureOfficial(req.workspace!.workspaceId);
  // Runtimes read once for the whole roster, not once per agent.
  const runtimes = machineRuntimes();
  const agents = await agentStore().list(req.workspace!.workspaceId);
  void Promise.all(agents.filter(agent => agent.sharedKey).map(agent => supabaseService.shareAgent(agent)));
  res.json(agents.map(a => withFileOverlay(a, runtimes)));
}));

dataRouter.post('/agents/:id/share', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  const workspaces = await workspaceRegistry.listForUser(req.workspace!.userId);
  const agent = await agentStore().share(
    req.workspace!.workspaceId,
    req.params.id,
    workspaces.map(workspace => workspace.id)
  );
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  await publishSharedAgentCopies(agent, workspaces.map(workspace => workspace.id));
  res.json(withFileOverlay(agent));
}));

dataRouter.delete('/agents/:id/share', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  const agent = await agentStore().unshare(req.workspace!.workspaceId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  void supabaseService.shareAgent(agent);
  res.json(withFileOverlay(agent));
}));

dataRouter.post('/agents', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  /**
   * Whose agent it is, by login.
   *
   * The field held the literal 'You', so "private to its owner" -- which the
   * roster's visibility setting promises, and which `0011` now enforces in the
   * database -- matched nobody at all, its creator included.
   */
  if (!req.body?.owner || req.body.owner === 'You') req.body.owner = req.workspace!.userId;
  const error = agentValidationError(req.body, { partial: false });
  if (error) return res.status(400).json({ error });

  const agent = await agentStore().create(req.workspace!.workspaceId, req.body);
  workspaceRegistry.bind('agents', agent.id, req.workspace!.workspaceId);
  void supabaseService.shareAgent(agent);
  res.status(201).json(withFileOverlay(agent));
}));

dataRouter.put('/agents/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  // A PUT here carries only the fields being changed, so absent ones are not
  // cleared — and must not be validated as if they had been sent empty.
  const error = agentValidationError(req.body, { partial: true });
  if (error) return res.status(400).json({ error });

  const updated = await agentStore().update(req.workspace!.workspaceId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Agent not found' });
  if (updated.sharedKey) {
    const workspaces = await workspaceRegistry.listForUser(req.workspace!.userId);
    await publishSharedAgentCopies(updated, workspaces.map(workspace => workspace.id));
  } else {
    void supabaseService.shareAgent(updated);
  }
  // Merged, like the list: a field the file owns must not appear to have taken
  // the value that was just written to the database.
  res.json(withFileOverlay(updated));
}));

dataRouter.delete('/agents/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  const deleted = await agentStore().remove(req.workspace!.workspaceId, req.params.id);
  if (deleted) {
    await workspaceRegistry.unbind('agents', req.params.id);
    void supabaseService.unshareAgent(req.params.id);
  }
  res.json({ success: deleted });
}));

/**
 * The agent's persona file — `~/.alpha/agents/{id}.md` — as text.
 *
 * Exposed so the file can be edited in the app rather than only in an editor on
 * the machine running the daemon. That matters for the same reason the file
 * exists at all: the persona is prose, and prose is written where the person
 * is, not where the process is.
 *
 * `effective` is what the agent actually resolves to once the file is merged
 * over the database row — the honest answer to "what will this agent be", which
 * neither source gives on its own.
 */
function personaPayload(id: string, agent: Agent) {
  const content = readAgentFileRaw(id);
  const { warnings } = parseAgentFileContent(content ?? '');
  const effective = resolveAgent(agent, { includeMemory: false });

  return {
    agentId: id,
    path: agentFilePath(id),
    exists: content !== null,
    content: content ?? '',
    warnings,
    effective: {
      name: effective.name,
      role: effective.role,
      modelProvider: effective.modelProvider,
      modelName: effective.modelName,
      reasoningEffort: effective.reasoningEffort,
      autonomyLevel: effective.autonomyLevel,
      skills: effective.skills,
      mcpServers: effective.mcpServers,
      systemPromptChars: effective.systemPrompt.length,
      /** 'agents/{id}.md' when the file supplied the persona, else 'alpha.db'. */
      promptSource: effective.sources[0]
    }
  };
}

dataRouter.get('/agents/:id/persona', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  const agent = await agentStore().get(req.workspace!.workspaceId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
    res.json(personaPayload(req.params.id, agent));
  } catch (err: any) {
    // agentFilePath throws on an id that would escape the agents directory.
    res.status(400).json({ error: err?.message ?? 'Could not read the persona file' });
  }
}));

/** How an agent has done in builds, and lessons suggested from its rejections and review findings. */
dataRouter.get('/agents/:id/performance', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  const agent = await agentStore().get(req.workspace!.workspaceId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agentLearningService.performance(req.params.id));
}));

/** Accept a suggested lesson into the agent's memory, or dismiss it. */
dataRouter.post('/agents/:id/lessons/:lessonId', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  const action = req.body?.action;
  if (action !== 'accept' && action !== 'dismiss') return res.status(400).json({ error: 'action must be accept or dismiss' });
  const agent = await agentStore().get(req.workspace!.workspaceId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    res.json(agentLearningService.decide({ agentId: req.params.id, lessonId: req.params.lessonId, action, actorId: req.workspace!.userId }));
  } catch (err) {
    if (err instanceof AgentLessonError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

dataRouter.put('/agents/:id/persona', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  if (!requireEntityWorkspace(req, res, 'agents', req.params.id)) return;
  const agent = await agentStore().get(req.workspace!.workspaceId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { content } = req.body ?? {};
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  if (Buffer.byteLength(content, 'utf8') > AGENT_FILE_MAX_BYTES) {
    return res.status(413).json({
      error: `Persona file exceeds ${AGENT_FILE_MAX_BYTES} bytes.`
    });
  }

  try {
    writeAgentFileRaw(req.params.id, content);
    // Read back rather than echo, so the response reflects what is on disk —
    // including the warnings the saved text produces.
    res.json(personaPayload(req.params.id, agent));
  } catch (err: any) {
    logError('Could not save persona file', err?.message ?? String(err));
    res.status(400).json({ error: err?.message ?? 'Could not save the persona file' });
  }
}));

/**
 * Import an agent from a persona file someone shared.
 *
 * The counterpart to downloading `GET /agents/:id/persona`, and the reason the
 * file carries a complete definition rather than only prose: a teammate should
 * be able to receive an agent and run it, without the sender's machine, keys or
 * subscription being involved.
 *
 * A new id is minted here rather than trusting the file's, so importing the
 * same agent twice produces two agents instead of silently overwriting one —
 * and so an id from elsewhere never becomes a path segment.
 */
dataRouter.post('/agents/import', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  const { content } = req.body ?? {};

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content must be the text of a persona file' });
  }
  if (Buffer.byteLength(content, 'utf8') > AGENT_FILE_MAX_BYTES) {
    return res.status(413).json({ error: `Persona file exceeds ${AGENT_FILE_MAX_BYTES} bytes.` });
  }

  try {
    const existingIds = (await agentStore().list(req.workspace!.workspaceId)).map(a => a.id);
    const { agent, warnings } = agentFromFileContent(content, existingIds);
    // A persona file describes an agent, not the person importing it. Record
    // the authenticated workspace member rather than persisting a placeholder.
    agent.owner = req.workspace!.userId;

    // createAgent writes the persona file too, so the body arrives on disk
    // without a second round trip.
    const created = await agentStore().create(req.workspace!.workspaceId, agent);
    workspaceRegistry.bind('agents', created.id, req.workspace!.workspaceId);
    void supabaseService.shareAgent(created);

    logInfo(`Imported agent ${created.id} (${created.name})`);
    res.status(201).json({ agent: withFileOverlay(created), warnings });
  } catch (err: any) {
    logError('Agent import failed', err?.message ?? String(err));
    res.status(400).json({ error: err?.message ?? 'Could not import this persona file' });
  }
}));

/**
 * One turn of the conversational agent builder.
 *
 * Declared before no route that could shadow it — `/agents/:id` is a GET-less
 * PUT/DELETE pair, so `/agents/builder/message` cannot be captured by it.
 */
dataRouter.post('/agents/builder/message', desktopOnly, async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
    const result = await sendBuilderMessage({
      sessionId: String(req.body?.sessionId ?? ''),
      runtimeId: String(req.body?.runtimeId ?? ''),
      modelName: String(req.body?.modelName ?? ''),
      message: String(req.body?.message ?? '')
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AgentBuilderError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

// --- Issues ---

const ISSUE_STATUSES: readonly IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'agent_running',
  'review',
  'done'
];

const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'awaiting_approval',
  'validating'
]);

function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && ISSUE_STATUSES.includes(value as IssueStatus);
}

async function activeRunForIssue(workspaceId: string, issueId: string) {
  return (await runStore().list(workspaceId)).find(run =>
    run.issueId === issueId && ACTIVE_RUN_STATUSES.has(run.status)
  );
}

/**
 * Status is writable through the generic issue endpoint only for ordinary
 * planning moves. Starting an agent and completing reviewed work are commands
 * with their own endpoints; otherwise a caller could skip the preparation or
 * review gate by sending { status: 'agent_running' } or { status: 'done' } to
 * PUT /issues/:id.
 */
async function statusTransitionError(workspaceId: string, issue: Issue, requestedStatus: unknown): Promise<string | null> {
  if (requestedStatus === undefined || requestedStatus === issue.status) return null;

  if (!isIssueStatus(requestedStatus)) {
    return 'status must be one of: ' + ISSUE_STATUSES.join(', ') + '.';
  }

  const activeRun = await activeRunForIssue(workspaceId, issue.id);

  if (requestedStatus === 'agent_running') {
    return 'Start an agent run through POST /api/runs/start; direct status changes to Agent Running are not allowed.';
  }

  if (requestedStatus === 'done') {
    if (activeRun?.status === 'awaiting_approval') {
      return 'Run ' + activeRun.id + ' is awaiting approval; approve it through POST /api/runs/' + activeRun.id + '/approve.';
    }
    if (activeRun) {
      return 'Run ' + activeRun.id + ' is still ' + activeRun.status + '; wait for it to reach review before completing the task.';
    }
    if (issue.status === 'agent_running') {
      return 'A task with an agent running must reach review before it can be completed.';
    }
    return 'Complete the task only after a person has reviewed it; direct status changes to Done are not allowed.';
  }

  if (activeRun) {
    return 'This task has an active agent run (' + activeRun.id + ') still ' + activeRun.status + '; use the run controls before changing this task.';
  }

  return null;
}

dataRouter.get('/issues', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.read')) return;
  const projects = await projectStore().list(req.workspace!.workspaceId);
  const allowedProjectIds = workspaceRegistry.projectIdsFor(req.workspace!, projects.map(project => project.id));
  res.json(workspaceRegistry.scopeProjectChildrenFromIds(
    'issues',
    await issueStore().list(req.workspace!.workspaceId),
    req.workspace!,
    allowedProjectIds,
    issue => issue.projectId
  ));
}));

/**
 * Create an issue. The daemon owns the identifier and the author.
 *
 * The browser used to send both: an identifier built as `issues.length + 101`
 * — a count of every issue in every project — and a system comment quoting it.
 * `createIssue` honours a supplied identifier, so `nextIssueIdentifier`, which
 * numbers per project correctly, never ran for anything made in the UI. The
 * first issue of a new project came out as TES-107 because six issues happened
 * to exist elsewhere, and two creates at the same count would collide against
 * a UNIQUE column.
 *
 * Dropping both here rather than trusting the client keeps one authority for
 * each, and the numbering stays right no matter who is calling.
 */
dataRouter.post('/issues', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  const { identifier: _ignored, comments: _alsoIgnored, ...rest } = req.body ?? {};

  if (rest.assignedSquadId) {
    return res.status(410).json({ error: 'Squads were removed. The Orchestrator assigns agents to each build task by role.' });
  }
  delete rest.assignedSquadId;

  const identity = await currentIdentity();
  if (!rest.projectId || typeof rest.projectId !== 'string') {
    return res.status(400).json({ error: 'A project is required for a task in this workspace.' });
  }
  if (!requireProjectWorkspace(req, res, rest.projectId)) return;
  const workspaceId = req.workspace!.workspaceId;
  const draft = { status: 'todo', priority: 'medium', labels: [], ...rest, createdBy: rest.createdBy || identity.login } as Issue;

  /**
   * Published first, so the card is born under GitHub's id.
   *
   * It used to be created and then pushed, keeping the id it was created with,
   * while the cloud's sync and every teammate's desktop met the same issue on
   * GitHub and named it after GitHub's id instead: one issue, two cards, and a
   * run on either unknown to the other. Awaited because the response carries
   * the issue number, and a card that does not know which GitHub issue it is
   * cannot be updated later. A project with no repository publishes nothing.
   */
  const { published, error: publishError } = await publishNewIssue(draft, workspaceId);
  const issue = await issueStore().create(workspaceId, {
    ...draft,
    ...(published ? { id: issueIdFor(published.githubIssueId), ...publishedFields(published) } : {})
  });
  workspaceRegistry.bind('issues', issue.id, workspaceId);

  /**
   * The opening comment, written where the real identifier is known.
   *
   * Composed by the browser before, against the identifier it had guessed — so
   * it named an issue that did not exist under that name.
   */
  await issueStore().addComment(req.workspace!.workspaceId, {
    id: `comm-${issue.id}-created`,
    issueId: issue.id,
    authorType: 'system',
    authorName: 'Alpha',
    content: `${issue.identifier} created by ${identity.login}.`,
    createdAt: issue.createdAt
  });

  // Re-read so the response carries the comment rather than making the client
  // guess at one.
  const saved = await issueStore().get(workspaceId, issue.id) ?? issue;

  // On a team's desktop, the card goes on the team's board -- the issue first,
  // since the database refuses a comment on an issue it does not have.
  await supabaseService.shareIssue(saved);
  for (const comment of saved.comments ?? []) void supabaseService.shareComment(comment);

  // 201 with a warning rather than an error: the issue exists locally and
  // refusing it now would lose work the person already did.
  res.status(201).json(publishError ? { ...saved, syncWarning: publishError } : saved);
}));

dataRouter.put('/issues/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  if (!requireEntityWorkspace(req, res, 'issues', req.params.id)) return;
  const before = await issueStore().get(req.workspace!.workspaceId, req.params.id);
  if (!before) return res.status(404).json({ error: 'Task not found' });
  if (!requireProjectWorkspace(req, res, before.projectId)) return;

  // Empty strings are explicit clears from the owner selector; normalize before either store writes foreign keys.
  if (req.body?.assignedSquadId) return res.status(410).json({ error: 'Squads were removed. The Orchestrator assigns agents to each build task by role.' });
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'assignedSquadId')) req.body.assignedSquadId = undefined;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'assignedAgentId') && !req.body.assignedAgentId) req.body.assignedAgentId = undefined;
  if (req.body?.assignedAgentId && !(await agentStore().get(req.workspace!.workspaceId, req.body.assignedAgentId))) return res.status(400).json({ error: 'The selected agent is unavailable in this workspace.' });
  const transitionError = await statusTransitionError(req.workspace!.workspaceId, before, req.body?.status);
  if (transitionError) {
    const status = isIssueStatus(req.body?.status) ? 409 : 400;
    return res.status(status).json({ error: transitionError });
  }

  const updated = await issueStore().update(req.workspace!.workspaceId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Task not found' });

  /**
   * Only when a field GitHub owns actually moved.
   *
   * Assigning an agent or attaching a branch is Alpha's own business, and
   * calling GitHub for it would spend a request to change nothing.
   */
  if (!needsPush(before, updated)) {
    void supabaseService.shareIssue(updated);
    return res.json(updated);
  }

  const push = await pushIssue(updated, req.workspace!.workspaceId);
  if (push.patch) await issueStore().update(req.workspace!.workspaceId, updated.id, push.patch);

  const saved = await issueStore().get(req.workspace!.workspaceId, updated.id) ?? updated;
  void supabaseService.shareIssue(saved);
  /**
   * A failed push is reported, never swallowed.
   *
   * The local write already happened, so this is not a 4xx — but the browser
   * has to know, or the board shows a state GitHub never accepted and the next
   * sync silently reverts it.
   */
  res.json(push.error ? { ...saved, syncWarning: push.error } : saved);
}));

/**
 * Complete an issue after a human review checkpoint.
 *
 * This is deliberately a command rather than another status-shaped PUT. The
 * explicit reviewed flag gives clients a narrow, auditable write path, while
 * active runs remain owned by the runner or the run approval endpoint.
 */
dataRouter.post('/issues/:id/complete', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  if (!requireEntityWorkspace(req, res, 'issues', req.params.id)) return;
  const before = await issueStore().get(req.workspace!.workspaceId, req.params.id);
  if (!before) return res.status(404).json({ error: 'Task not found' });
  if (!requireProjectWorkspace(req, res, before.projectId)) return;

  if (req.body?.reviewed !== true) {
    return res.status(400).json({ error: 'A task can only be completed after it has been reviewed.' });
  }

  if (before.status === 'done') return res.json(before);

  const activeRun = await activeRunForIssue(req.workspace!.workspaceId, before.id);
  if (activeRun) {
    if (activeRun.status === 'awaiting_approval') {
      return res.status(409).json({
        error: 'This task has a run awaiting approval; approve the run before completing the task.'
      });
    }
    return res.status(409).json({
      error: 'This task has an active agent run; wait for it to reach review before completing the task.'
    });
  }

  if (before.status === 'agent_running') {
    return res.status(409).json({
      error: 'A task with an agent running must reach review before it can be completed.'
    });
  }

  const updated = await issueStore().update(req.workspace!.workspaceId, before.id, { status: 'done' });
  if (!updated) return res.status(404).json({ error: 'Task not found' });

  if (!needsPush(before, updated)) {
    void supabaseService.shareIssue(updated);
    return res.json(updated);
  }

  const push = await pushIssue(updated, req.workspace!.workspaceId);
  if (push.patch) await issueStore().update(req.workspace!.workspaceId, updated.id, push.patch);

  const saved = await issueStore().get(req.workspace!.workspaceId, updated.id) ?? updated;
  void supabaseService.shareIssue(saved);
  res.json(push.error ? { ...saved, syncWarning: push.error } : saved);
}));

dataRouter.delete('/issues/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  if (!requireEntityWorkspace(req, res, 'issues', req.params.id)) return;
  const issue = await issueStore().get(req.workspace!.workspaceId, req.params.id);
  if (!issue) return res.status(404).json({ error: 'Task not found' });
  if (!requireProjectWorkspace(req, res, issue.projectId)) return;
  const deleted = await issueStore().remove(req.workspace!.workspaceId, req.params.id);
  if (deleted) {
    await workspaceRegistry.unbind('issues', req.params.id);
    void supabaseService.unshareIssue(req.params.id);
  }
  res.json({ success: deleted });
}));

dataRouter.post('/issues/:id/comments', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  if (!requireEntityWorkspace(req, res, 'issues', req.params.id)) return;
  const issue = await issueStore().get(req.workspace!.workspaceId, req.params.id);
  if (!issue) return res.status(404).json({ error: 'Task not found' });
  if (!requireProjectWorkspace(req, res, issue.projectId)) return;
  const comment = await issueStore().addComment(req.workspace!.workspaceId, {
    ...req.body,
    issueId: req.params.id
  });
  void supabaseService.shareComment(comment);
  res.status(201).json(comment);
}));

// --- Squads ---
dataRouter.get('/squads', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const squads = workspaceRegistry.scopeSquads(await squadStore().list(req.workspace!.workspaceId), req.workspace!);
  res.json(squads.map(squad => ({
    ...squad,
    ownerId: workspaceRegistry.squadOwnerId(req.workspace!, squad.id)
  })));
}));

/**
 * Squads were removed. Existing rows stay readable for history; nothing can
 * create, edit, delete, or assign one.
 */
const squadsRemoved = (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Squads were removed. The Orchestrator assigns agents to each build task by role.' });
};
dataRouter.post('/squads', squadsRemoved);
dataRouter.put('/squads/:id', squadsRemoved);
dataRouter.delete('/squads/:id', squadsRemoved);
dataRouter.put('/squads/:id/projects/:projectId', squadsRemoved);
dataRouter.delete('/squads/:id/projects/:projectId', squadsRemoved);

dataRouter.get('/squads/:id/projects', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  if (!requireSquadWorkspace(req, res, req.params.id)) return;
  const assignments = (await workspaceRegistry.listSquadProjectAssignments(req.workspace!.workspaceId))
    .filter(assignment => assignment.squadId === req.params.id && assignment.status === 'active')
    .filter(assignment => workspaceRegistry.canAccessProject(req.workspace!, assignment.projectId));
  res.json(assignments);
}));

// --- Skills ---
/*
 * Each skill carries the tools it actually grants a chat turn.
 *
 * Served rather than mirrored in the frontend. The bug this closes was a panel
 * describing capability the runner never handed over; hard-coding the same map
 * on the other side of the wire rebuilds that the first time one copy is edited
 * and the other is not. SKILL_TOOLS stays the only place it is written down.
 *
 * Empty for a skill that grants no CLI tool — `sk-git` grants MCP write access,
 * which is resolved per agent from its autonomy level and cannot be read off
 * the skill alone.
 */
dataRouter.get('/skills', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  // Only Alpha's own in the cloud: installed skills are found on a machine's
  // disk, and switching one on or off changes what that machine's agents get.
  const skills = IS_CLOUD ? [...BUILTIN_SKILLS] : sqliteService.scanSkills();
  res.json(
    skills.map(skill => ({
      ...skill,
      grantedTools: SKILL_TOOLS[skill.id] ?? []
    }))
  );
});

/** Force a fresh filesystem scan after a skill is installed or removed. */
dataRouter.post('/skills/scan', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  res.json(
    sqliteService.scanSkills().map(skill => ({
      ...skill,
      grantedTools: SKILL_TOOLS[skill.id] ?? []
    }))
  );
});

dataRouter.put('/skills/:id', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
  const { isEnabled } = req.body;
  sqliteService.setSkillEnabled(req.params.id, Boolean(isEnabled));
  res.json({ success: true });
});
