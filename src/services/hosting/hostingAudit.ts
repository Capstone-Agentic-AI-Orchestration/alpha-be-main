import { database, type Sql } from '../../store/database.js';
import { logError } from '../../utils/logger.js';
import type { HostingBranch } from './hostingService.js';

/**
 * The record of every change Alpha makes to a hosted repository's
 * environment: who, where, which keys, and whether it worked. Never a value
 * -- see migration 0017, which cannot hold one.
 */

export interface HostingActor {
  login: string;
  kind: 'user' | 'agent';
  runId?: string;
  agentId?: string;
}

export interface HostingAuditEntry {
  workspaceId: string;
  repo: string;
  environment: HostingBranch | null;
  action: 'env_set' | 'env_delete' | 'redeploy';
  keys: string[];
  actor: HostingActor;
  result: 'ok' | 'partial' | 'failed';
  error?: string;
}

/** Bearer tokens out of a platform's error text before it is kept. */
function sanitize(error: string | undefined): string | null {
  return error ? error.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500) : null;
}

/**
 * Record one change. A failure to record is logged, not thrown: the change
 * itself already happened on the platform, and failing the request now would
 * tell the person it did not.
 */
export async function recordHostingChange(entry: HostingAuditEntry, sql: Sql = database()): Promise<void> {
  try {
    await sql.query(
      `insert into alpha_private.hosting_audit
         (workspace_id, repo, environment, action, keys, actor_login, actor_kind, run_id, agent_id, result, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.workspaceId,
        entry.repo,
        entry.environment,
        entry.action,
        entry.keys,
        entry.actor.login,
        entry.actor.kind,
        entry.actor.runId ?? null,
        entry.actor.agentId ?? null,
        entry.result,
        sanitize(entry.error)
      ]
    );
  } catch (err) {
    logError(`Could not record a hosting change to ${entry.repo}:`, (err as Error).message);
  }
}
