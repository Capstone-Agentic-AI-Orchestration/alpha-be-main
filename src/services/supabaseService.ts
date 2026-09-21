import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, ALPHA_CLOUD_API } from '../config/env.js';
import { logInfo, logError } from '../utils/logger.js';
import { PrototypeRun, Issue } from '../models/index.js';
import { knownIdentity } from './identityService.js';
import { currentWorkspaceId } from './workspaceContext.js';
import { DatabaseTokenClient } from './databaseTokenClient.js';

const execFileAsync = promisify(execFile);

/**
 * The machine's GitHub token, as the identity the desktop presents.
 *
 * Read per exchange rather than cached: `gh auth login` as someone else, or
 * `gh auth logout`, should change who the next token is for.
 */
async function githubCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The desktop's uplink to the shared board.
 *
 * Two things were wrong with this and neither was visible, because every
 * failure was caught and logged at a level nobody reads.
 *
 * **It had no credentials the database would accept.** The client was built
 * once with the anon key, which under the policies in
 * `0002_row_level_security.sql` resolves to no login, no workspace and no
 * role — so every claim reads null and every row is denied. Before those
 * policies existed the writes failed differently, against tables that had
 * never been created.
 *
 * **Its payloads were incomplete.** `saveRunToCloud` sent neither
 * `workspace_id` nor `owner_id`, both of which are `NOT NULL`. Every insert
 * would have been rejected even with a valid token.
 *
 * The first fix for the credentials minted a token here, with the Supabase JWT
 * secret -- which put that secret on every developer's machine and let the
 * machine choose its own role. The token now comes from the cloud, in
 * exchange for the machine's `gh` login; see `databaseTokenClient.ts`.
 */

/** How often to repeat a sync failure, so a broken uplink is visible once and not endlessly. */
const FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A run, as the cloud table wants it.
 *
 * Pulled out of the method so the shape can be checked against the real schema
 * without a network call. It was wrong in a way no type could catch: the
 * payload was a valid object that omitted two `NOT NULL` columns, so it
 * typechecked, looked complete, and would have been rejected by every insert.
 * `supabaseSync.test.ts` inserts this into the actual migration.
 */
export function runToCloudRow(
  run: PrototypeRun,
  workspaceId: string,
  ownerId: string
): Record<string, unknown> {
  return {
    id: run.id,
    workspace_id: workspaceId,
    owner_id: ownerId,
    issue_id: run.issueId,
    project_id: run.projectId,
    agent_id: run.agentId,
    status: run.status,
    scenario: run.scenario,
    plan: run.plan ?? [],
    current_stage_index: run.currentStageIndex ?? 0,
    stages: run.stages ?? [],
    branch_name: run.branchName ?? null,
    pr_url: run.prUrl ?? null,
    changed_files: run.changedFiles || 0,
    insertions: run.insertions || 0,
    deletions: run.deletions || 0,
    test_summary: run.testSummary ?? null,
    updated_at: run.updatedAt || new Date().toISOString()
  };
}

export class SupabaseService {
  private client: SupabaseClient | null = null;
  private lastFailureLoggedAt = 0;
  private readonly tokens = new DatabaseTokenClient({
    cloudApi: ALPHA_CLOUD_API,
    githubToken: githubCliToken,
    workspaceId: currentWorkspaceId,
    onFailure: (what, err) => this.reportFailure(what, err)
  });

  constructor() {
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      try {
        this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            persistSession: false,
            autoRefreshToken: false
          },
          /**
           * A fresh token per request, rather than one at construction.
           *
           * supabase-js calls this before each call and uses the result as the
           * Authorization bearer, so the claims always describe the workspace
           * the caller is actually in. Minting once would pin the first
           * workspace this process touched onto every later write.
           *
           * Returning the anon key on failure rather than throwing: the
           * request then fails at the database with a policy denial, which is
           * a clearer signal than an exception thrown from inside the client's
           * internals.
           */
          accessToken: async () => (await this.tokens.token()) ?? SUPABASE_ANON_KEY,
          realtime: {
            params: { eventsPerSecond: 20 }
          }
        });
        logInfo('Supabase client initialized successfully (Team Mode)');
      } catch (err: any) {
        logError('Failed to initialize Supabase client:', err?.message || err);
      }
    } else {
      logInfo('Supabase credentials not set — running in Solo SQLite mode');
    }
  }

  isConfigured(): boolean {
    return !!(this.client && SUPABASE_URL && SUPABASE_ANON_KEY);
  }

  getClient(): SupabaseClient | null {
    return this.client;
  }

  /**
   * Report a sync failure, at most once every few minutes.
   *
   * These used to be `logError` on every call, or swallowed entirely with
   * `.catch(() => {})`. Both are bad in the same way: a broken uplink either
   * drowns the log during a run or leaves no trace at all, and "syncing
   * silently does nothing" is exactly the state this service was in for
   * months.
   */
  private reportFailure(what: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLoggedAt = now;
    const detail = (err as { message?: string })?.message ?? String(err);
    logError(`Cloud sync failing (${what}): ${detail}. Further failures suppressed for 5 minutes.`);
  }

  /** Broadcast live stage transitions or log chunks to a Realtime channel. */
  async broadcastRunEvent(
    runId: string,
    event: {
      type: 'stage_update' | 'log_chunk' | 'run_activity' | 'run_completed' | 'run_failed' | 'run_cancelled';
      payload: any;
    }
  ): Promise<void> {
    if (!this.client) return;

    try {
      const channel = this.client.channel(`run:${runId}`);
      await channel.send({ type: 'broadcast', event: event.type, payload: event.payload });
    } catch (err: any) {
      this.reportFailure(`broadcast run ${runId}`, err);
    }
  }

  /** Persist a run to the cloud board. */
  async saveRunToCloud(run: PrototypeRun): Promise<void> {
    if (!this.client) return;

    const identity = knownIdentity();
    const workspaceId = currentWorkspaceId();

    try {
      const payload = runToCloudRow(run, workspaceId, identity?.login ?? 'unknown');
      const { error } = await this.client.from('prototype_runs').upsert(payload);
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`save run ${run.id}`, err);
    }
  }

  /** Persist issue updates to the cloud board. */
  async updateIssueInCloud(issueId: string, updates: Partial<Issue>): Promise<void> {
    if (!this.client) return;

    try {
      const dbUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (updates.status !== undefined) dbUpdates.status = updates.status;
      if (updates.branchName !== undefined) dbUpdates.branch_name = updates.branchName;
      if (updates.prUrl !== undefined) dbUpdates.pr_url = updates.prUrl;
      if (updates.assignedAgentId !== undefined) dbUpdates.assigned_agent_id = updates.assignedAgentId;

      const { error } = await this.client.from('issues').update(dbUpdates).eq('id', issueId);
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`update issue ${issueId}`, err);
    }
  }
}

export const supabaseService = new SupabaseService();
