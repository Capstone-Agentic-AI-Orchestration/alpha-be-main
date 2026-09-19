import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/env.js';
import { logInfo, logError } from '../utils/logger.js';
import { PrototypeRun, Issue } from '../models/index.js';

export class SupabaseService {
  private client: SupabaseClient | null = null;

  constructor() {
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      try {
        this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            persistSession: false,
            autoRefreshToken: true
          },
          realtime: {
            params: {
              eventsPerSecond: 20
            }
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
   * Broadcast live stage transitions or log chunks to Supabase Realtime channel
   */
  async broadcastRunEvent(
    runId: string,
    event: { type: 'stage_update' | 'log_chunk' | 'run_activity' | 'run_completed' | 'run_failed' | 'run_cancelled'; payload: any }
  ): Promise<void> {
    if (!this.client) return;

    try {
      const channel = this.client.channel(`run:${runId}`);
      await channel.send({
        type: 'broadcast',
        event: event.type,
        payload: event.payload
      });
    } catch (err: any) {
      logError(`Supabase Realtime broadcast failed for run ${runId}:`, err?.message || err);
    }
  }

  /**
   * Persist run record into Supabase PostgreSQL prototype_runs table
   */
  async saveRunToCloud(run: PrototypeRun): Promise<void> {
    if (!this.client) return;

    try {
      const payload = {
        id: run.id,
        issue_id: run.issueId,
        project_id: run.projectId,
        agent_id: run.agentId,
        status: run.status,
        scenario: run.scenario,
        plan: run.plan,
        current_stage_index: run.currentStageIndex,
        stages: run.stages,
        branch_name: run.branchName,
        pr_url: run.prUrl,
        changed_files: run.changedFiles || 0,
        insertions: run.insertions || 0,
        deletions: run.deletions || 0,
        test_summary: run.testSummary,
        updated_at: run.updatedAt || new Date().toISOString()
      };

      const { error } = await this.client.from('prototype_runs').upsert(payload);
      if (error) throw error;
      logInfo(`Synced run ${run.id} to Supabase prototype_runs table`);
    } catch (err: any) {
      logError(`Failed to save run ${run.id} to Supabase:`, err?.message || err);
    }
  }

  /**
   * Persist issue updates into Supabase PostgreSQL issues table
   */
  async updateIssueInCloud(issueId: string, updates: Partial<Issue>): Promise<void> {
    if (!this.client) return;

    try {
      const dbUpdates: Record<string, any> = {
        updated_at: new Date().toISOString()
      };
      if (updates.status !== undefined) dbUpdates.status = updates.status;
      if (updates.branchName !== undefined) dbUpdates.branch_name = updates.branchName;
      if (updates.prUrl !== undefined) dbUpdates.pr_url = updates.prUrl;
      if (updates.assignedAgentId !== undefined) dbUpdates.assigned_agent_id = updates.assignedAgentId;

      const { error } = await this.client.from('issues').update(dbUpdates).eq('id', issueId);
      if (error) throw error;
      logInfo(`Synced issue ${issueId} updates to Supabase issues table`);
    } catch (err: any) {
      logError(`Failed to update issue ${issueId} in Supabase:`, err?.message || err);
    }
  }
}

export const supabaseService = new SupabaseService();
