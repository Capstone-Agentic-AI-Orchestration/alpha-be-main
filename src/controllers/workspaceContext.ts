import { NextFunction, Request, Response } from 'express';
import { IS_CLOUD, IS_PACKAGED_DESKTOP } from '../config/env.js';
import { currentIdentity } from '../services/identityService.js';
import { isSessionAuthenticated, requiresSessionAuthentication, sessionReady } from '../services/alphaGitHubToken.js';
import { workspaceRegistry, WorkspaceRole } from '../services/workspaceRegistry.js';

/**
 * Paths that answer before anyone is known.
 *
 * Matched on path, not on method — so anything listed here is public for
 * every verb. `/workspaces` used to be on this list, for the browser's "which
 * workspaces do I have" call on boot, and that exemption silently covered
 * `POST /workspaces` too: anyone at all could create one. The listing needs a
 * caller anyway, to be a listing of *theirs*, so both moved behind the gate.
 */
const PUBLIC_EXACT = [
  '/health',
  '/me',
  '/github/auth',
  '/github/auth/login',
  '/github/auth/logout',
  '/github/profiles',
  '/github/profiles/remove',
  // Switching is how a signed-out window signs in as a remembered account.
  '/github/profiles/switch',
  '/github/oauth/desktop/start',
  '/github/oauth/desktop/result',
  // Authenticated by the refresh token it carries; a desktop has no session.
  '/github/oauth/desktop/refresh',
  '/github/oauth/url',
  '/github/oauth/callback',
  // Reads req.session directly and answers 401 itself. Running the workspace
  // resolver first would refuse the very call the browser makes to find out
  // whether it is signed in.
  '/github/session',
  '/github/session/logout',
  '/github/app/install-url',
  '/github/app/webhook',
  // A desktop asks this before it can sign in, so it cannot be behind a
  // sign-in. The answer is a client id, which is public by construction.
  '/github/app/client',
  // The desktop has no session; this verifies the GitHub token it presents.
  '/database/token/exchange'
];
const PUBLIC_PREFIXES = ['/download/'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

/**
 * Who this caller is, and whether they may be here at all.
 *
 * The two deployments answer this from different places, and conflating them
 * was the defect:
 *
 *  - **desktop** — `currentIdentity()`, a process-global cached read of the
 *    local `gh` CLI. Correct, because one process serves one human at one
 *    keyboard.
 *  - **cloud** — the browser session on this request. The same process-global
 *    call on Render returned one identity for every caller: no `gh` in the
 *    container, so every request resolved to the OS user and the entire RBAC
 *    layer below was gating on a constant.
 */
async function callerFor(
  req: Request
): Promise<{ login: string; role?: WorkspaceRole; refused?: string }> {
  if (IS_CLOUD) {
    if (!req.session) {
      return { login: '', refused: 'Sign in with GitHub to use Alpha.' };
    }
    return { login: req.session.login, role: req.session.role as WorkspaceRole };
  }

  // A remembered account may still be resuming at launch.
  if (IS_PACKAGED_DESKTOP) await sessionReady();
  if (requiresSessionAuthentication() && !isSessionAuthenticated()) {
    return { login: '', refused: 'Sign in with GitHub to use Alpha.' };
  }

  const identity = await currentIdentity();
  if (identity.access === 'no_team') {
    return {
      login: identity.login,
      refused: 'Your account is not a member of an Alpha workspace.'
    };
  }
  return { login: identity.login, role: identity.role as WorkspaceRole | undefined };
}

/** Resolve the active product workspace before a feature route runs. */
export async function workspaceContext(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (isPublicPath(req.path)) return next();

  try {
    const caller = await callerFor(req);
    if (caller.refused) {
      /**
       * 401 when we do not know who you are, 403 when we do and the answer is
       * no. A browser can act on the first — start a sign-in — and can only
       * report the second.
       */
      const status = IS_CLOUD && !req.session ? 401 : 403;
      res.status(status).json({ error: caller.refused });
      return;
    }

    /**
     * The listing is not scoped to a workspace, and must not be refused for
     * one: on a desktop it is what fetches a workspace this machine has not
     * seen yet, so asking for it by id first would be asking for the answer
     * before the question.
     */
    const listing = req.method === 'GET' && req.path === '/workspaces';
    const context = await workspaceRegistry.resolve(
      caller.login,
      listing ? undefined : req.header('X-Workspace-Id') || undefined,
      caller.role
    );
    if (!context) {
      res.status(403).json({ error: 'You do not have access to the requested workspace.' });
      return;
    }

    req.workspace = context;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireWorkspaceCapability(
  req: Request,
  res: Response,
  capability: Parameters<typeof workspaceRegistry.can>[1]
): boolean {
  if (!req.workspace || !workspaceRegistry.can(req.workspace.role, capability)) {
    res.status(403).json({ error: `Your workspace role cannot ${capability.replace('.', ' ')}.` });
    return false;
  }
  return true;
}

export function requireEntityWorkspace(
  req: Request,
  res: Response,
  entityType: Parameters<typeof workspaceRegistry.inWorkspace>[1],
  entityId: string
): boolean {
  if (!req.workspace || !workspaceRegistry.inWorkspace(req.workspace, entityType, entityId)) {
    res.status(404).json({ error: 'Resource not found in the active workspace.' });
    return false;
  }
  return true;
}

/**
 * A project is the authorization boundary for code, issues, runs and chat
 * context. PMs/admins see the whole workspace; clients and developers must
 * have an active project assignment.
 */
export function requireProjectWorkspace(
  req: Request,
  res: Response,
  projectId: string
): boolean {
  if (!req.workspace || !workspaceRegistry.canAccessProject(req.workspace, projectId)) {
    /**
     * A project the caller can already see is no secret, so say what is
     * actually wrong. Developers discover every PM-owned project, and
     * answering "not found" for one on their screen sent them looking for a
     * missing project instead of a missing assignment.
     *
     * Anything they cannot discover still reads as absent: whether a project
     * exists outside the caller's view is not revealed.
     */
    if (req.workspace && workspaceRegistry.canDiscoverProject(req.workspace, projectId)) {
      res.status(403).json({
        error: 'You are not assigned to this project. Ask its project manager to add you.',
        code: 'project_not_assigned'
      });
      return false;
    }
    res.status(404).json({ error: 'Project not found in the active workspace.' });
    return false;
  }
  return true;
}

/**
 * A project the caller may know about, which is not the same as one they work
 * in: binding a folder and reading a project's details come before assignment.
 */
export function requireDiscoverableProject(
  req: Request,
  res: Response,
  projectId: string
): boolean {
  if (!req.workspace || !workspaceRegistry.canDiscoverProject(req.workspace, projectId)) {
    res.status(404).json({ error: 'Project not found in the active workspace.' });
    return false;
  }
  return true;
}

/** A squad is visible to internal members of its workspace. */
export function requireSquadWorkspace(
  req: Request,
  res: Response,
  squadId: string
): boolean {
  if (!req.workspace || !workspaceRegistry.canAccessSquad(req.workspace, squadId)) {
    res.status(404).json({ error: 'Squad not found in the active workspace.' });
    return false;
  }
  return true;
}

/** Editing a shared squad stays with its owner or a workspace administrator. */
export function requireSquadManagement(
  req: Request,
  res: Response,
  squadId: string
): boolean {
  if (!req.workspace || !workspaceRegistry.canManageSquad(req.workspace, squadId)) {
    res.status(403).json({ error: 'Only the squad owner or a workspace administrator can change this squad.' });
    return false;
  }
  return true;
}
