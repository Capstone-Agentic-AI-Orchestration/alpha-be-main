import { NextFunction, Request, Response } from 'express';
import { IS_CLOUD } from '../config/env.js';
import { currentIdentity } from '../services/identityService.js';
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
  '/github/oauth/url',
  '/github/oauth/callback',
  // Reads req.session directly and answers 401 itself. Running the workspace
  // resolver first would refuse the very call the browser makes to find out
  // whether it is signed in.
  '/github/session',
  '/github/session/logout',
  '/github/app/install-url',
  '/github/app/webhook',
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

    const context = await workspaceRegistry.resolve(
      caller.login,
      req.header('X-Workspace-Id') || undefined,
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
  entityType: Parameters<typeof workspaceRegistry.belongsTo>[0],
  entityId: string
): boolean {
  if (!req.workspace || !workspaceRegistry.belongsTo(entityType, entityId, req.workspace.workspaceId)) {
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
    // Do not reveal whether a project exists outside the caller's assignment.
    res.status(404).json({ error: 'Project not found in the active workspace.' });
    return false;
  }
  return true;
}

/** A squad is visible only to its owner or to workspace roles with broad squad visibility. */
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
