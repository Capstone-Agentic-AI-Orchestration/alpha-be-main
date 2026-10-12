import type { Request, Response } from 'express';

import { IS_CLOUD } from '../config/env.js';
import { relayToCloud, type RelayOptions } from './cloudRelay.js';
import { requireWorkspaceCapability } from './workspaceContext.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;

/**
 * Build an internal ticket identity only from existing server-authenticated
 * workspace/session state. Never accept actor IDs, roles or auth proof from a
 * request body/header. Client identities use a separate future router.
 */
export function pmTicketSubject(req: Request, res: Response): TicketSubject | null {
  const workspace = req.workspace;
  if (!workspace) {
    res.status(401).json({ error: 'Sign in to manage tickets.' });
    return null;
  }
  if (!requireWorkspaceCapability(req, res, 'ticket.manage')) return null;

  const authentication = req.session?.ticketAuthentication;
  if (!opaque(workspace.userId) || !opaque(workspace.workspaceId)) {
    res.status(401).json({ error: 'Sign in again to manage tickets.' });
    return null;
  }
  if (authentication?.kind === 'session' && opaque(authentication.sessionId)) {
    return { kind: 'internal', userId: workspace.userId, authentication };
  }
  if (authentication?.kind === 'verified_github_bearer' && opaque(authentication.verificationId)) {
    return { kind: 'internal', userId: workspace.userId, authentication };
  }
  res.status(401).json({ error: 'Sign in again to manage tickets.' });
  return null;
}

/** Internal reader boundary for work assigned to the current developer. The
 * store still rechecks exact assignment and live membership in its snapshot. */
export function assignedWorkTicketSubject(req: Request, res: Response): TicketSubject | null {
  const workspace = req.workspace;
  if (!workspace) {
    res.status(401).json({ error: 'Sign in to view assigned work.' });
    return null;
  }
  if (!requireWorkspaceCapability(req, res, 'issue.read')) return null;

  const authentication = req.session?.ticketAuthentication;
  if (!opaque(workspace.userId) || !opaque(workspace.workspaceId)) {
    res.status(401).json({ error: 'Sign in again to view assigned work.' });
    return null;
  }
  if (authentication?.kind === 'session' && opaque(authentication.sessionId)) {
    return { kind: 'internal', userId: workspace.userId, authentication };
  }
  if (authentication?.kind === 'verified_github_bearer' && opaque(authentication.verificationId)) {
    return { kind: 'internal', userId: workspace.userId, authentication };
  }
  res.status(401).json({ error: 'Sign in again to view assigned work.' });
  return null;
}

/**
 * Cloud is the only ticket authority. A desktop forwards through the existing
 * GitHub-authenticated relay; it must never fall through to local SQLite or a
 * process-local ticket adapter. A desktop without a cloud address fails closed.
 */
export async function relayPmTicketRequest(req: Request, res: Response, options: RelayOptions = {}): Promise<boolean> {
  if (IS_CLOUD) return false;
  if (await relayToCloud(req, res, options)) return true;
  res.status(503).json({ error: 'Ticketing requires a configured Alpha cloud connection.' });
  return true;
}

export function opaqueTicketRequestValue(value: unknown): value is string {
  return opaque(value);
}
