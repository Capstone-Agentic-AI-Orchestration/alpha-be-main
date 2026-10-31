import type { PrototypeRun, RemoteAction, RunActivity, PrototypeRunStage, SquadRun } from '../models/index.js';
import type { Sql } from './database.js';
import type { RemoteActionInput, RunStore } from './runStore.js';

/**
 * Runs in the cloud, where oversight reads them.
 *
 * The desktop writes these rows through the Data API with its own token, and
 * the policies in `0002` decide who may read them: a run's owner, and the
 * project managers and admins of its workspace. This store is the cloud's own
 * path to the same rows, scoped by workspace in every statement.
 *
 * `owner_id` is not optional in the table and is not on the model: a run
 * belongs to the person whose machine produced it, and the cloud writes its
 * own actions (an approval, a rejection) under the caller's login.
 */
export class PostgresRunStore implements RunStore {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string): Promise<PrototypeRun[]> {
    const { rows } = await this.sql.query<RunRow>(
      'select * from prototype_runs where workspace_id = $1 order by created_at desc',
      [workspaceId]
    );
    return rows.map(toRun);
  }

  /**
   * Logs are removed in the database, so they never cross the connection.
   * Each stage keeps its status and timing with an empty log list.
   */
  async listSummaries(workspaceId: string, projectId?: string): Promise<PrototypeRun[]> {
    const projectScope = projectId ? 'and project_id = $2' : '';
    const parameters = projectId ? [workspaceId, projectId] : [workspaceId];
    const { rows } = await this.sql.query<RunRow>(
      `select id, issue_id, project_id, agent_id, status, scenario, plan, current_stage_index,
         coalesce((
           select jsonb_agg(
             case when jsonb_typeof(stage.value) = 'object'
               then jsonb_set(stage.value, '{logs}', '[]'::jsonb) else stage.value end
             order by stage.ordinality)
           from jsonb_array_elements(case when jsonb_typeof(stages) = 'array' then stages else '[]'::jsonb end)
             with ordinality as stage(value, ordinality)
         ), '[]'::jsonb) as stages,
         '[]'::jsonb as activities,
         branch_name, pr_url, changed_files, insertions, deletions, test_summary,
         squad_run_id, squad_order, input_tokens, output_tokens, cache_read_tokens,
         cache_creation_tokens, thinking_tokens, cost_usd, num_turns, created_at, updated_at
       from prototype_runs where workspace_id = $1 ${projectScope} order by created_at desc`,
      parameters
    );
    return rows.map(row => ({ ...toRun(row), logsOmitted: true }));
  }

  /** Read only selected project build runs, trimming logs and activity before they cross the database connection. */
  async listProjectBuildDetails(workspaceId: string, runIds: string[]): Promise<PrototypeRun[]> {
    if (runIds.length === 0) return [];
    const { rows } = await this.sql.query<RunRow>(
      `select id, issue_id, project_id, agent_id, status, scenario, plan, current_stage_index,
         coalesce((
           select jsonb_agg(
             case when jsonb_typeof(stage.value) = 'object' then
               jsonb_set(
                 jsonb_set(stage.value, '{description}', to_jsonb(left(coalesce(stage.value->>'description', ''), 360)), false),
                 '{logs}', coalesce((
                   select jsonb_agg(
                     case when jsonb_typeof(recent_log.value) = 'string'
                       then to_jsonb(left(recent_log.value #>> '{}', 500))
                       else recent_log.value end
                     order by recent_log.ordinality)
                   from (
                     select log.value, log.ordinality
                     from jsonb_array_elements(
                       case when jsonb_typeof(stage.value->'logs') = 'array' then stage.value->'logs' else '[]'::jsonb end
                     ) with ordinality as log(value, ordinality)
                     order by log.ordinality desc
                     limit 8
                   ) recent_log
                 ), '[]'::jsonb), true)
               else stage.value end
             order by stage.ordinality)
           from jsonb_array_elements(case when jsonb_typeof(stages) = 'array' then stages else '[]'::jsonb end)
             with ordinality as stage(value, ordinality)
         ), '[]'::jsonb) as stages,
         coalesce((
           select jsonb_agg(
             case when jsonb_typeof(recent_activity.value) = 'object' then
               jsonb_set(
                 jsonb_set(recent_activity.value, '{message}', to_jsonb(left(coalesce(recent_activity.value->>'message', ''), 320)), false),
                 '{detail}', to_jsonb(left(coalesce(recent_activity.value->>'detail', ''), 600)), false
               )
             else recent_activity.value end
             order by recent_activity.ordinality)
           from (
             select activity.value, activity.ordinality
             from jsonb_array_elements(case when jsonb_typeof(activities) = 'array' then activities else '[]'::jsonb end)
               with ordinality as activity(value, ordinality)
             order by activity.ordinality desc
             limit 40
           ) recent_activity
         ), '[]'::jsonb) as activities,
         branch_name, pr_url, changed_files, insertions, deletions, left(test_summary, 700) as test_summary,
         squad_run_id, squad_order, input_tokens, output_tokens, cache_read_tokens,
         cache_creation_tokens, thinking_tokens, cost_usd, num_turns, created_at, updated_at
       from prototype_runs where workspace_id = $1 and id = any($2::text[])`,
      [workspaceId, runIds]
    );
    return rows.map(toRun);
  }

  async get(workspaceId: string, id: string): Promise<PrototypeRun | null> {
    const { rows } = await this.sql.query<RunRow>(
      'select * from prototype_runs where workspace_id = $1 and id = $2',
      [workspaceId, id]
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  async save(workspaceId: string, run: PrototypeRun, ownerId: string): Promise<PrototypeRun> {
    const usage = run.usage ?? {};
    await this.sql.query(
      `insert into prototype_runs
         (id, workspace_id, owner_id, issue_id, project_id, agent_id, status, scenario, plan,
          current_stage_index, stages, activities, branch_name, pr_url, changed_files, insertions,
          deletions, test_summary, squad_run_id, squad_order,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens,
          cost_usd, num_turns, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
       on conflict (id) do update set
         status = excluded.status, scenario = excluded.scenario, plan = excluded.plan,
         current_stage_index = excluded.current_stage_index, stages = excluded.stages,
         activities = excluded.activities, branch_name = excluded.branch_name, pr_url = excluded.pr_url,
         changed_files = excluded.changed_files, insertions = excluded.insertions,
         deletions = excluded.deletions, test_summary = excluded.test_summary,
         squad_run_id = excluded.squad_run_id, squad_order = excluded.squad_order,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         thinking_tokens = excluded.thinking_tokens, cost_usd = excluded.cost_usd,
         num_turns = excluded.num_turns, updated_at = excluded.updated_at`,
      [
        run.id,
        workspaceId,
        ownerId,
        run.issueId,
        run.projectId,
        run.agentId,
        run.status,
        run.scenario ?? 'success',
        JSON.stringify(run.plan ?? []),
        run.currentStageIndex ?? 0,
        JSON.stringify(run.stages ?? []),
        JSON.stringify(run.activities ?? []),
        run.branchName ?? null,
        run.prUrl ?? null,
        run.changedFiles ?? 0,
        run.insertions ?? 0,
        run.deletions ?? 0,
        run.testSummary ?? null,
        run.squadRunId ?? null,
        run.squadOrder ?? null,
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.cacheReadTokens ?? null,
        usage.cacheCreationTokens ?? null,
        usage.thinkingTokens ?? null,
        usage.costUsd ?? null,
        usage.numTurns ?? null,
        run.createdAt || new Date().toISOString(),
        run.updatedAt || new Date().toISOString()
      ]
    );
    return run;
  }

  async listSquadRuns(workspaceId: string): Promise<SquadRun[]> {
    const { rows } = await this.sql.query<SquadRunRow>(
      'select * from squad_runs where workspace_id = $1 order by created_at desc',
      [workspaceId]
    );
    return rows.map(toSquadRun);
  }

  async getSquadRun(workspaceId: string, id: string): Promise<SquadRun | null> {
    const { rows } = await this.sql.query<SquadRunRow>(
      'select * from squad_runs where workspace_id = $1 and id = $2',
      [workspaceId, id]
    );
    return rows[0] ? toSquadRun(rows[0]) : null;
  }

  async saveSquadRun(workspaceId: string, run: SquadRun, ownerId: string): Promise<SquadRun> {
    await this.sql.query(
      `insert into squad_runs
         (id, workspace_id, owner_id, squad_id, issue_id, project_id, branch_name, member_agent_ids,
          current_member_index, status, mission, plan, member_assignments, stopped_reason, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (id) do update set
         current_member_index = excluded.current_member_index, status = excluded.status,
         mission = excluded.mission, plan = excluded.plan, stopped_reason = excluded.stopped_reason,
         member_agent_ids = excluded.member_agent_ids, member_assignments = excluded.member_assignments,
         updated_at = excluded.updated_at`,
      [
        run.id,
        workspaceId,
        ownerId,
        run.squadId,
        run.issueId,
        run.projectId,
        run.branchName,
        JSON.stringify(run.memberAgentIds ?? []),
        run.currentMemberIndex ?? 0,
        run.status,
        run.mission ?? '',
        JSON.stringify(run.plan ?? []),
        JSON.stringify(run.memberAssignments ?? []),
        run.stoppedReason ?? null,
        run.createdAt || new Date().toISOString(),
        run.updatedAt || new Date().toISOString()
      ]
    );
    return run;
  }

  async runsForSquadRun(workspaceId: string, squadRunId: string): Promise<PrototypeRun[]> {
    const { rows } = await this.sql.query<RunRow>(
      `select * from prototype_runs
       where workspace_id = $1 and squad_run_id = $2
       order by squad_order asc nulls last, created_at asc`,
      [workspaceId, squadRunId]
    );
    return rows.map(toRun);
  }

  async recordRemoteAction(workspaceId: string, action: RemoteActionInput): Promise<RemoteAction> {
    const row: RemoteAction = {
      ...action,
      id: action.id || `ra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: action.createdAt || new Date().toISOString()
    };
    await this.sql.query(
      `insert into remote_actions
         (id, workspace_id, run_id, agent_id, issue_id, actor, action, target, detail, succeeded, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do nothing`,
      [
        row.id,
        workspaceId,
        row.runId ?? null,
        row.agentId ?? null,
        row.issueId ?? null,
        row.actor,
        row.action,
        row.target ?? null,
        row.detail ?? null,
        row.succeeded,
        row.createdAt
      ]
    );
    return row;
  }

  /** Oldest first for one run, so its remote history reads as a sequence. */
  async listRemoteActions(workspaceId: string, runId?: string): Promise<RemoteAction[]> {
    const { rows } = runId
      ? await this.sql.query<RemoteActionRow>(
          'select * from remote_actions where workspace_id = $1 and run_id = $2 order by created_at asc',
          [workspaceId, runId]
        )
      : await this.sql.query<RemoteActionRow>(
          'select * from remote_actions where workspace_id = $1 order by created_at desc limit 200',
          [workspaceId]
        );
    return rows.map(toRemoteAction);
  }
}

type Timestamp = Date | string;

interface RunRow {
  id: string;
  issue_id: string;
  project_id: string;
  agent_id: string;
  status: string;
  scenario: string | null;
  plan: string[] | null;
  current_stage_index: number | null;
  stages: PrototypeRunStage[] | null;
  activities: RunActivity[] | null;
  branch_name: string | null;
  pr_url: string | null;
  changed_files: number | null;
  insertions: number | null;
  deletions: number | null;
  test_summary: string | null;
  squad_run_id: string | null;
  squad_order: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  thinking_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface SquadRunRow {
  id: string;
  squad_id: string;
  issue_id: string;
  project_id: string;
  branch_name: string;
  member_agent_ids: string[] | null;
  current_member_index: number | null;
  status: string;
  mission: string | null;
  plan: string[] | null;
  member_assignments: SquadRun['memberAssignments'] | null;
  stopped_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface RemoteActionRow {
  id: string;
  run_id: string | null;
  agent_id: string | null;
  issue_id: string | null;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  succeeded: boolean;
  created_at: Timestamp;
}

const iso = (value: Timestamp): string => new Date(value).toISOString();

/** Absent telemetry stays absent: a run the CLI told us nothing about is not a run of zero tokens. */
function usageFrom(row: RunRow): PrototypeRun['usage'] {
  const fields = {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    thinkingTokens: row.thinking_tokens,
    costUsd: row.cost_usd,
    numTurns: row.num_turns
  };
  const present = Object.entries(fields).filter(([, value]) => value !== null && value !== undefined);
  return present.length ? (Object.fromEntries(present) as PrototypeRun['usage']) : undefined;
}

function toRun(row: RunRow): PrototypeRun {
  return {
    id: row.id,
    issueId: row.issue_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    status: row.status as PrototypeRun['status'],
    scenario: (row.scenario ?? 'success') as PrototypeRun['scenario'],
    plan: row.plan ?? [],
    currentStageIndex: row.current_stage_index ?? 0,
    stages: row.stages ?? [],
    activities: row.activities ?? [],
    branchName: row.branch_name ?? undefined,
    prUrl: row.pr_url ?? undefined,
    changedFiles: row.changed_files ?? 0,
    insertions: row.insertions ?? 0,
    deletions: row.deletions ?? 0,
    testSummary: row.test_summary ?? undefined,
    usage: usageFrom(row),
    squadRunId: row.squad_run_id ?? undefined,
    squadOrder: row.squad_order ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  } as PrototypeRun;
}

function toSquadRun(row: SquadRunRow): SquadRun {
  return {
    id: row.id,
    squadId: row.squad_id,
    issueId: row.issue_id,
    projectId: row.project_id,
    branchName: row.branch_name,
    memberAgentIds: row.member_agent_ids ?? [],
    currentMemberIndex: row.current_member_index ?? 0,
    status: row.status as SquadRun['status'],
    mission: row.mission ?? '',
    plan: row.plan ?? [],
    memberAssignments: row.member_assignments ?? [],
    stoppedReason: row.stopped_reason ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function toRemoteAction(row: RemoteActionRow): RemoteAction {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    issueId: row.issue_id ?? undefined,
    actor: row.actor as RemoteAction['actor'],
    action: row.action,
    target: row.target ?? undefined,
    detail: row.detail ?? undefined,
    succeeded: row.succeeded,
    createdAt: iso(row.created_at)
  };
}
