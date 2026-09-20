import { NextFunction, Request, Response } from 'express';
import { currentIdentity } from '../services/identityService.js';
import { workspaceRegistry, WorkspaceRole } from '../services/workspaceRegistry.js';

const PUBLIC_EXACT = [
  '/health',
  '/me',
  '/workspaces',
  '/workspaces/join',
  '/github/auth',
  '/github/auth/login',
  '/github/auth/logout',
  '/github/oauth/url',
  '/github/oauth/callback',
  '/github/app/install-url',
  '/github/app/webhook'
];
const PUBLIC_PREFIXES = ['/download/'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

/** Resolve the active product workspace before a feature route runs. */
export async function workspaceContext(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (isPublicPath(req.path)) return next();

  try {
    const identity = await currentIdentity();
    if (identity.access === 'no_team') {
      res.status(403).json({ error: 'Your account is not a member of an Alpha workspace.' });
      return;
    }

    const context = workspaceRegistry.resolve(
      identity.login,
      req.header('X-Workspace-Id') || undefined,
      identity.role as WorkspaceRole | undefined
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
