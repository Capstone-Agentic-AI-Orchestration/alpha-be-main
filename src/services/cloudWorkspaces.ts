import { ALPHA_CLOUD_API, IS_CLOUD } from '../config/env.js';
import { tokenForThisRequest } from './githubApi.js';
import { workspaceRegistry, type WorkspaceRole, type WorkspaceSummary } from './workspaceRegistry.js';
import { logError } from '../utils/logger.js';

/**
 * A team desktop's workspaces, as the cloud has them.
 *
 * Workspaces, their members and who is assigned to which project are shared
 * state: a project manager decides them, often from the web, and a developer
 * has to see the result on their desktop without doing anything. They used to
 * live in each desktop's SQLite file, which the cloud never wrote to -- so a
 * workspace made on the web never reached a developer, and one made on a
 * project manager's desktop existed on that one machine.
 *
 * On a desktop with a cloud to talk to, the workspace routes now ask the
 * cloud, signed in with the same GitHub token the database-token exchange
 * uses, and keep a copy in SQLite so a request can still be resolved while
 * the cloud is asleep. A desktop with no cloud configured is on its own, as
 * before.
 */
export function usesCloudDirectory(): boolean {
  return !IS_CLOUD && Boolean(ALPHA_CLOUD_API);
}

export interface CloudAnswer<T = unknown> {
  status: number;
  body: T;
}

/**
 * Long enough for a sleeping Render service to wake for something a person
 * asked for. The listing refresh passes a shorter one: it has a local answer
 * to fall back on.
 */
const ACTION_TIMEOUT_MS = 90_000;

export async function cloudRequest<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; workspaceId?: string; timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<CloudAnswer<T>> {
  const token = await tokenForThisRequest();
  const res = await fetch(`${ALPHA_CLOUD_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.workspaceId ? { 'X-Workspace-Id': init.workspaceId } : {}),
      ...(init.headers ?? {}),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? ACTION_TIMEOUT_MS)
  });
  const body = (await res.json().catch(() => null)) as T;
  return { status: res.status, body };
}

/**
 * Refresh this desktop's copy of the caller's memberships from the cloud.
 *
 * Returns whether the copy was refreshed. False -- the cloud asleep past the
 * timeout, unreachable, or refusing -- leaves the copy as it was, which is
 * the right answer to serve until the next attempt.
 */
export async function refreshMemberships(userId: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    const answer = await cloudRequest<WorkspaceSummary[]>('/workspaces', { timeoutMs });
    if (answer.status !== 200 || !Array.isArray(answer.body)) {
      logError(`Could not read workspaces from the cloud: it answered ${answer.status}.`);
      return false;
    }
    workspaceRegistry.mirrorMemberships(
      userId,
      answer.body.map(workspace => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role: workspace.role as WorkspaceRole
      }))
    );
    return true;
  } catch (err: any) {
    logError('Could not read workspaces from the cloud:', err?.message ?? err);
    return false;
  }
}
