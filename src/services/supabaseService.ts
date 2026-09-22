import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, ALPHA_CLOUD_API, IS_CLOUD } from '../config/env.js';
import { logInfo, logError } from '../utils/logger.js';
import { PrototypeRun, Issue, IssueComment, Agent, Squad, ChatMessage, ChatThread } from '../models/index.js';
import { commentRow, issueRow } from '../store/postgresIssueStore.js';
import { agentRow, squadRow } from '../store/postgresAgentStore.js';
import { messageRow, threadRow } from '../store/postgresChatStore.js';
import { supabaseBoardSource, type SharedBoardSource } from './sharedBoard.js';
import { knownIdentity } from './identityService.js';
import { currentWorkspaceId } from './workspaceContext.js';
import { DatabaseTokenClient } from './databaseTokenClient.js';
import { RunPublishGate } from './runPublishGate.js';

const execFileAsync = promisify(execFile);

import { storedToken } from './alphaGitHubToken.js';

/**
 * The GitHub token the desktop presents as its identity.
 *
 * Alpha's own sign-in, so the row this machine writes carries the account
 * chosen in the app rather than whichever one the terminal happens to hold.
 * Read per exchange rather than cached: signing out, or signing in as someone
 * else, should change who the next token is for.
 *
 * Falls back to the CLI for a daemon run from source, which has no sign-in of
 * its own to do.
 */
async function githubCliToken(): Promise<string | null> {
  const own = storedToken();
  if (own) return own;
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

/** The events after which a run sends nothing more. */
const TERMINAL_RUN_EVENTS = new Set(['run_completed', 'run_failed', 'run_cancelled']);

export class SupabaseService {
  private client: SupabaseClient | null = null;
  private lastFailureLoggedAt = 0;
  private readonly publishGate = new RunPublishGate();
  private readonly runChannels = new Map<string, RealtimeChannel>();
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

  /**
   * Whether this desktop works on the team's board rather than a board of its
   * own: signed in to a cloud, so its projects and issues are the cloud's and
   * its changes go back there. Never true of the cloud itself, which is the
   * board.
   */
  sharesBoard(): boolean {
    return !IS_CLOUD && this.isConfigured();
  }

  /** Where to read the team's board from, as this developer. */
  boardSource(): SharedBoardSource | null {
    return this.client ? supabaseBoardSource(this.client) : null;
  }

  /**
   * Put a card this desktop made or changed on the team's board.
   *
   * The whole row, not the changed fields: a card made here does not exist in
   * the cloud until this runs, and an upsert of the full row is both the insert
   * and the update. Awaited by callers that write comments next, which the
   * database refuses on an issue it does not have.
   */
  async shareIssue(issue: Issue): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('issues').upsert(issueRow(currentWorkspaceId(), issue));
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`share issue ${issue.identifier}`, err);
    }
  }

  /**
   * Put an agent or a squad of this machine's on the team's roster.
   *
   * Without this an issue assigned to a developer's own agent names something
   * the cloud has no row for, which `0011` refuses outright. The machine's
   * configuration -- CLI arguments, environment -- is left out by `agentRow`,
   * and an agent marked private stays readable only by its owner, by policy.
   */
  async shareAgent(agent: Agent): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('agents').upsert(agentRow(currentWorkspaceId(), agent));
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`share agent ${agent.id}`, err);
    }
  }

  async unshareAgent(agentId: string): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('agents').delete().eq('id', agentId);
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`remove agent ${agentId}`, err);
    }
  }

  async shareSquad(squad: Squad, ownerId?: string): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    const workspaceId = currentWorkspaceId();
    try {
      const { error } = await this.client.from('squads').upsert(squadRow(workspaceId, squad));
      if (error) throw error;
      if (!ownerId) return;
      // One owner per squad since 0008, so the squad's id is the row's identity.
      const { error: ownerError } = await this.client.from('workspace_squad_owners').upsert(
        {
          id: `squad-owner-${squad.id}`,
          workspace_id: workspaceId,
          squad_id: squad.id,
          user_id: ownerId,
          status: 'active',
          updated_at: new Date().toISOString()
        },
        { onConflict: 'workspace_id,squad_id' }
      );
      if (ownerError) throw ownerError;
    } catch (err: any) {
      this.reportFailure(`share squad ${squad.id}`, err);
    }
  }

  async unshareSquad(squadId: string): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('squads').delete().eq('id', squadId);
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`remove squad ${squadId}`, err);
    }
  }

  /**
   * Keep this person's own copy of a conversation.
   *
   * Theirs, not the team's: the policies scope `chat_threads` and
   * `chat_messages` to the owner, with no project-manager bypass. What
   * oversight sees is the work -- runs, stages, patches -- not the prompts.
   */
  async shareThread(thread: ChatThread): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    const login = knownIdentity()?.login;
    if (!login) return;
    try {
      const { error } = await this.client.from('chat_threads').upsert(threadRow(currentWorkspaceId(), login, thread));
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`share conversation ${thread.id}`, err);
    }
  }

  async shareMessage(message: ChatMessage): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('chat_messages').upsert(messageRow(message));
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`share message in ${message.threadId}`, err);
    }
  }

  /** Its messages go with it, by the schema's `on delete cascade`. */
  async unshareThread(threadId: string): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('chat_threads').delete().eq('id', threadId);
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`remove conversation ${threadId}`, err);
    }
  }

  async unshareMessages(threadId: string): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('chat_messages').delete().eq('thread_id', threadId);
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`clear conversation ${threadId}`, err);
    }
  }

  /** Take a card this desktop deleted off the team's board too. */
  async unshareIssue(issueId: string): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client.from('issues').delete().eq('id', issueId);
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`remove issue ${issueId}`, err);
    }
  }

  /**
   * Put a comment this desktop wrote -- a run summary, mostly -- on the team's
   * board, where the cloud's sync publishes it to GitHub.
   *
   * Insert-or-nothing rather than an upsert: the policy lets a developer add a
   * comment, not rewrite one, and a comment that is already there is already
   * shared.
   */
  async shareComment(comment: IssueComment): Promise<void> {
    if (!this.sharesBoard() || !this.client) return;
    try {
      const { error } = await this.client
        .from('issue_comments')
        .upsert(commentRow(comment), { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw error;
    } catch (err: any) {
      this.reportFailure(`share comment on ${comment.issueId}`, err);
    }
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

  /**
   * Broadcast live stage transitions or log chunks to a run's channel.
   *
   * Private (see 0006): Realtime lets the message through only if this token's
   * login owns the run, and delivers it only to the owner and their overseers.
   * It used to be public, readable and writable by anyone with the anon key
   * and the run id.
   *
   * One channel per run, removed when the run ends. `client.channel()` makes a
   * new channel on every call and the client keeps them all, so one per event
   * grew without bound across a long run's log chunks.
   */
  async broadcastRunEvent(
    runId: string,
    event: {
      type: 'stage_update' | 'log_chunk' | 'run_activity' | 'run_completed' | 'run_failed' | 'run_cancelled';
      payload: any;
    }
  ): Promise<void> {
    if (!this.client) return;

    try {
      // The row must exist before the channel will accept anything.
      await this.publishGate.ready(runId);

      let channel = this.runChannels.get(runId);
      if (!channel) {
        channel = this.client.channel(`run:${runId}`, { config: { private: true } });
        this.runChannels.set(runId, channel);
      }
      await channel.send({ type: 'broadcast', event: event.type, payload: event.payload });
    } catch (err: any) {
      this.reportFailure(`broadcast run ${runId}`, err);
    } finally {
      if (TERMINAL_RUN_EVENTS.has(event.type)) this.forgetRun(runId);
    }
  }

  private forgetRun(runId: string): void {
    this.publishGate.done(runId);
    const channel = this.runChannels.get(runId);
    this.runChannels.delete(runId);
    if (channel && this.client) void this.client.removeChannel(channel);
  }

  /** Persist a run to the cloud board. */
  saveRunToCloud(run: PrototypeRun): Promise<void> {
    if (!this.client) return Promise.resolve();
    const client = this.client;

    const save = (async () => {
      const identity = knownIdentity();
      const workspaceId = currentWorkspaceId();

      try {
        const payload = runToCloudRow(run, workspaceId, identity?.login ?? 'unknown');
        const { error } = await client.from('prototype_runs').upsert(payload);
        if (error) throw error;
      } catch (err: any) {
        this.reportFailure(`save run ${run.id}`, err);
      }
    })();

    // Broadcasts for this run wait on its first save; see RunPublishGate.
    this.publishGate.saved(run.id, save);
    return save;
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
