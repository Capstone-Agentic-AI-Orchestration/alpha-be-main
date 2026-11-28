import { IS_CLOUD } from '../config/env.js';
import { database, type Sql } from '../store/database.js';
import { logError } from '../utils/logger.js';
import { cloudRequest, usesCloudDirectory } from './cloudWorkspaces.js';

/**
 * The client requests behind board tasks, as background for a build.
 *
 * A request is the client's whole brief and its tasks are pieces of it, so a
 * task's own text is the scope and the request is context: the planner reads
 * it to know what the product is for, not as more work to do. Requests live in
 * the cloud; a desktop asks the cloud, and a build never waits on or fails for
 * this -- without it, the build plans from the tasks alone, as before.
 */

export interface ClientRequestBrief {
  reference: string;
  title: string;
  description: string;
}

export const MAX_BRIEF_ISSUES = 20;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function validIssueIds(value: unknown): string[] | null {
  const ids = typeof value === 'string' ? value.split(',').map(id => id.trim()).filter(Boolean) : [];
  if (!ids.length || ids.length > MAX_BRIEF_ISSUES || ids.some(id => !OPAQUE_ID.test(id))) return null;
  return [...new Set(ids)];
}

/** The live requests (not declined or cancelled) on this project that these tasks belong to. */
export async function clientRequestBriefsFromDatabase(
  sql: Sql, workspaceId: string, projectId: string, issueIds: readonly string[]
): Promise<ClientRequestBrief[]> {
  if (!issueIds.length) return [];
  const { rows } = await sql.query<{ reference: string; title: string; description: string | null }>(
    `select distinct t.reference, t.title, t.description, t.created_at
       from (
         select ticket_id from alpha_private.request_task_links where workspace_id = $1 and issue_id = any($2::text[])
         union
         select ticket_id from alpha_private.ticket_work_bindings where workspace_id = $1 and issue_id = any($2::text[])
       ) x
       join alpha_private.tickets t on t.workspace_id = $1 and t.id = x.ticket_id and t.project_id = $3
      where t.status not in ('declined', 'cancelled')
      order by t.created_at`,
    [workspaceId, [...issueIds], projectId]
  );
  return rows.map(row => ({ reference: row.reference, title: row.title, description: row.description ?? '' }));
}

/** For a build: the cloud reads its database, a desktop asks the cloud. Empty, never an error, when unavailable. */
export async function clientRequestBriefs(workspaceId: string, projectId: string, issueIds: readonly string[]): Promise<ClientRequestBrief[]> {
  const ids = [...new Set(issueIds)].slice(0, MAX_BRIEF_ISSUES);
  if (!ids.length) return [];
  try {
    if (IS_CLOUD) return await clientRequestBriefsFromDatabase(database(), workspaceId, projectId, ids);
    if (!usesCloudDirectory()) return [];
    const answer = await cloudRequest<{ items?: ClientRequestBrief[] }>(
      `/projects/${encodeURIComponent(projectId)}/client-request-briefs?issues=${encodeURIComponent(ids.join(','))}`,
      { workspaceId, timeoutMs: 8_000 }
    );
    if (answer.status !== 200 || !Array.isArray(answer.body?.items)) return [];
    return answer.body.items.filter(item => typeof item?.title === 'string' && typeof item.description === 'string'
      && typeof item.reference === 'string');
  } catch (err) {
    logError('Could not read the client requests behind this build; planning from the tasks alone:', (err as Error).message);
    return [];
  }
}
