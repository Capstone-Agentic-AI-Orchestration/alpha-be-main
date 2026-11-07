import { createHash, randomBytes } from 'node:crypto';
import type { WorkspaceContext } from '../store/workspaceDirectory.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';

/**
 * What an agent's board tools may do, and for whom.
 *
 * Minted for one agent turn and revoked when it ends, like the hosting grant
 * in runBridge, but naming the person the agent acts for. Every board tool
 * call is checked against that person's own permissions, so an agent can
 * never do on the board what the person could not do by hand.
 *
 * Agents are for developers only: no grant is minted for a project manager,
 * admin or client, even though they manage cards by hand.
 */
export type BoardAccess = 'read' | 'comment' | 'write';

export interface BoardGrant {
  runId: string;
  agentId: string | null;
  agentName: string;
  /** The person the agent acts for, as of the start of the turn. */
  context: WorkspaceContext;
  actorLogin: string;
  /** The one project this turn may touch. */
  projectId: string;
  access: BoardAccess;
  /** With 'comment' access, the only card the agent may comment on (its own build task). */
  ownIssueId?: string;
  /** Distinct cards this turn has changed or asked to change; see boardAgentService. */
  touched: Set<string>;
  writes: number;
}

const grantsByTokenHash = new Map<string, BoardGrant>();
const tokenHashByRun = new Map<string, string>();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class BoardGrantRefused extends Error {}

/** Why this person cannot have an agent work on this project's board, or null. */
export function boardAgentRefusal(context: WorkspaceContext, projectId: string): string | null {
  if (context.role !== 'dev') return 'Agents work on the board only for developers.';
  if (!workspaceRegistry.can(context.role, 'issue.manage') || !workspaceRegistry.can(context.role, 'agent.run')) {
    return 'Your workspace role cannot have agents change tasks.';
  }
  if (!workspaceRegistry.canAccessProjectBuilds(context, projectId)) return 'You do not have access to this project.';
  const enabled = runWithWorkspace(context.workspaceId, () => sqliteService.boardAssistantEnabled(context.workspaceId, projectId));
  if (!enabled) return 'The board assistant is turned off for this project.';
  return null;
}

/** A token for this turn's board tools. Throws BoardGrantRefused when the person may not use agents on this board. */
export function mintBoardGrant(grant: Omit<BoardGrant, 'touched' | 'writes'>): string {
  const refusal = boardAgentRefusal(grant.context, grant.projectId);
  if (refusal) throw new BoardGrantRefused(refusal);
  revokeBoardGrant(grant.runId);
  const token = randomBytes(32).toString('hex');
  const tokenHash = hash(token);
  grantsByTokenHash.set(tokenHash, { ...grant, touched: new Set(), writes: 0 });
  tokenHashByRun.set(grant.runId, tokenHash);
  return token;
}

export function boardGrantForToken(token: string | undefined): BoardGrant | null {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return grantsByTokenHash.get(hash(token)) ?? null;
}

export function revokeBoardGrant(runId: string): void {
  const tokenHash = tokenHashByRun.get(runId);
  if (tokenHash) grantsByTokenHash.delete(tokenHash);
  tokenHashByRun.delete(runId);
}

