import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DB_PATH, ALPHA_DIR, WORKSPACES_DIR, IS_CLOUD } from '../config/env.js';
import {
  Project,
  Issue,
  IssueComment,
  Agent,
  Squad,
  PrototypeRun,
  ChatThread,
  ChatMessage,
  Skill,
  RuntimeEngine,
  RunUsage,
  AnalyticsData,
  SquadRun,
  RemoteAction,
  Workspace,
  ProjectBuildStep,
  LocalProjectBinding,
  LocalRepoBinding,
  BuildStepPhase,
  AgentCall,
  AgentCallTarget,
  AgentCallArtifact,
  ChatAttachmentRecord,
  OrchestrationRecoveryEpisode,
  OrchestrationRecoveryActionRecord,
  OrchestrationRecoveryActionName,
  OrchestrationRecoveryMilestone
} from '../models/index.js';
import { syncAgentFile, deleteAgentFile, readAgentFile } from './agentFileService.js';
import { ensureMemoryScaffold } from './memoryService.js';
import {
  agentFromOfficialTemplate,
  LEGACY_TEMPLATE_MAPPINGS,
  OFFICIAL_AGENT_TEMPLATES,
  PREVIOUS_TEMPLATE_PROMPTS
} from './officialAgentTemplates.js';
import { discoverInstalledSkills } from './skillDiscoveryService.js';
import { currentWorkspaceId, DEFAULT_WORKSPACE_ID, runWithWorkspace } from './workspaceContext.js';
import { analyticsFrom } from './runAnalytics.js';
import { BUILTIN_SKILLS } from './builtinSkills.js';
import { normalizeBuildSteps } from '../store/buildSteps.js';
import { MAX_PLAN_TASKS, parseOrchestrationPlan, validateOrchestrationPlan, type OrchestrationPlan, type OrchestrationTaskDefinition } from './orchestrationContract.js';
import type { PersistedReviewFinding } from './orchestrationReviewWorkflow.js';
import {
  transitionTask,
  transitionRun,
  selectNextReadyTask,
  type OrchestrationRunRecord,
  type OrchestrationTaskRecord,
  type OrchestrationTaskStatus,
  type OrchestrationSnapshot,
  type OrchestrationAttemptRecord,
  type OrchestrationEventRecord,
  type OrchestrationOutboxDeliveryRecord,
  type OrchestrationArtifactRecord,
  type OrchestrationFindingRecord
} from './orchestrationStateMachine.js';

export type ChatSyncOperation = 'share_thread' | 'share_message' | 'delete_thread' | 'clear_messages';

export interface ChatSyncOutboxItem {
  id: number;
  workspaceId: string;
  ownerId: string;
  threadId: string;
  operation: ChatSyncOperation;
  payload?: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
}

// Ensure alpha dir exists
if (!fs.existsSync(ALPHA_DIR)) {
  fs.mkdirSync(ALPHA_DIR, { recursive: true });
}

/**
 * Rebuild a run's token figures from its row.
 *
 * Returns undefined — not an object of undefineds — when the CLI reported
 * nothing, so callers can distinguish an unmeasured run (every run that
 * predates these columns) from one that genuinely used nothing. Only keys with
 * a number are copied, so a NULL column never becomes a 0 in the API response.
 */
function usageFromRow(r: any): RunUsage | undefined {
  const usage: RunUsage = {};
  const columns: Array<[keyof RunUsage, string]> = [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['cacheReadTokens', 'cache_read_tokens'],
    ['cacheCreationTokens', 'cache_creation_tokens'],
    ['thinkingTokens', 'thinking_tokens'],
    ['costUsd', 'cost_usd'],
    ['numTurns', 'num_turns']
  ];

  for (const [key, column] of columns) {
    if (typeof r[column] === 'number') usage[key] = r[column];
  }

  return Object.keys(usage).length ? usage : undefined;
}

function squadRunFromRow(r: any): SquadRun {
  return {
    id: r.id,
    squadId: r.squad_id,
    issueId: r.issue_id,
    projectId: r.project_id,
    branchName: r.branch_name,
    memberAgentIds: JSON.parse(r.member_agent_ids || '[]'),
    currentMemberIndex: r.current_member_index,
    status: r.status,
    mission: r.mission,
    plan: JSON.parse(r.plan || '[]'),
    memberAssignments: parseJson(r.member_assignments, []),
    stoppedReason: r.stopped_reason ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function orchestrationRunFromRow(row: any, plan: OrchestrationPlan): OrchestrationRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    issueId: row.issue_id,
    originChatThreadId: row.origin_chat_thread_id ?? undefined,
    originBuildMessageId: row.origin_build_message_id ?? undefined,
    repository: row.repository,
    requestKey: row.request_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    executorId: row.executor_id,
    ownershipEpoch: row.ownership_epoch,
    workflowVersion: row.workflow_version,
    planVersion: row.plan_version,
    plan,
    status: row.status,
    revision: row.revision,
    currentTaskId: row.current_task_id ?? undefined,
    pauseRequestedAt: row.pause_requested_at ?? undefined,
    pauseRequestedBy: row.pause_requested_by ?? undefined,
    stoppedReason: row.stopped_reason ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseRef: row.base_ref ?? undefined,
    baseCommit: row.base_commit ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    repositoryWorkspaces: parseJson(row.repository_workspaces_json, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function orchestrationRecoveryEpisodeFromRow(row: any): OrchestrationRecoveryEpisode {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    runId: row.run_id,
    issueId: row.issue_id,
    taskId: row.task_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    source: row.source,
    category: row.category,
    code: row.error_code,
    summary: row.summary,
    fingerprint: row.fingerprint,
    phase: row.phase,
    episodeNumber: row.episode_number,
    repairBudget: row.repair_budget,
    attemptsUsed: row.attempts_used,
    guidance: row.guidance ?? undefined,
    evidence: parseJson(row.evidence_json, {}),
    threadId: row.thread_id ?? undefined,
    buildMessageId: row.build_message_id ?? undefined,
    initiatedBy: row.initiated_by,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined
  };
}

function orchestrationRecoveryActionFromRow(row: any): OrchestrationRecoveryActionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    recoveryId: row.recovery_id,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    expectedRunRevision: row.expected_run_revision,
    expectedRecoveryRevision: row.expected_recovery_revision,
    expectedTaskRevision: row.expected_task_revision ?? undefined,
    action: row.action,
    guidance: row.guidance ?? undefined,
    status: row.status,
    result: row.result_json ? parseJson(row.result_json, {}) : undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined
  };
}

function orchestrationRecoveryMilestoneFromRow(row: any): OrchestrationRecoveryMilestone {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    recoveryId: row.recovery_id,
    milestoneKey: row.milestone_key,
    threadId: row.thread_id,
    messageId: row.message_id,
    content: row.content,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined
  };
}

function canonicalOrchestrationRepository(value: string): string {
  return value.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function isSafeOrchestrationBranchName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(value) &&
    !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
    !value.endsWith('.lock') && !value.includes('..') && !value.includes('//');
}

function orchestrationTaskFromRow(row: any, definition?: OrchestrationTaskDefinition): OrchestrationTaskRecord {
  return {
    id: row.task_id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    repository: definition?.repository,
    assignmentReason: definition?.assignmentReason,
    ownerAgentId: row.owner_agent_id,
    dependsOn: parseJson(row.depends_on_json, []),
    requirementIds: parseJson(row.requirement_ids_json, []),
    acceptanceCriteria: parseJson(row.acceptance_json, []),
    requiredChecks: parseJson(row.checks_json, []),
    scope: parseJson(row.scope_json, { includePaths: [], excludePaths: [] }),
    required: Boolean(row.required),
    correctionOfTaskId: row.correction_of_task_id ?? undefined,
    correctionCycle: row.correction_cycle ?? undefined,
    status: row.status,
    revision: row.revision,
    attemptCount: row.attempt_count,
    acceptedRevision: row.accepted_revision ?? undefined,
    updatedAt: row.updated_at
  };
}

function orchestrationAttemptFromRow(row: any): OrchestrationAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptNumber: row.attempt_number,
    agentId: row.agent_id,
    prototypeRunId: row.prototype_run_id ?? undefined,
    startingCommit: row.starting_commit ?? undefined,
    resultCommit: row.result_commit ?? undefined,
    personaHash: row.persona_hash ?? undefined,
    modelProvider: row.model_provider ?? undefined,
    modelName: row.model_name ?? undefined,
    contextManifest: parseJson(row.context_manifest_json, {}),
    status: row.status,
    result: parseJson(row.result_json, undefined),
    failureReason: row.failure_reason ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined
  };
}

function orchestrationEventFromRow(row: any): OrchestrationEventRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.run_sequence,
    actorId: row.actor_id ?? undefined,
    type: row.event_type,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}

function orchestrationArtifactFromRow(row: any): OrchestrationArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    type: row.artifact_type,
    version: row.version,
    contentHash: row.content_hash,
    contentReference: row.content_reference ?? undefined,
    content: row.content ?? undefined,
    metadata: parseJson(row.metadata_json, {}),
    status: row.status,
    createdAt: row.created_at
  };
}

function orchestrationFindingFromRow(row: any): OrchestrationFindingRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    sourceTaskId: row.source_task_id,
    severity: row.severity,
    requirementId: row.requirement_id ?? undefined,
    artifactId: row.artifact_id ?? undefined,
    path: row.path ?? undefined,
    evidence: parseJson(row.evidence, {}),
    status: row.status,
    correctionTaskId: row.correction_task_id ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function agentCallTargetFromRow(row: any): AgentCallTarget | undefined {
  if (!row.revision_target_type || !row.revision_target_id) return undefined;
  return {
    type: row.revision_target_type,
    id: row.revision_target_id,
    label: row.revision_target_label ?? undefined
  };
}

/** A `local_project_bindings` row, as the rest of the app reads it. */
function toBinding(row: any): LocalProjectBinding {
  return {
    projectId: row.project_id,
    localDir: row.local_dir,
    isManaged: Boolean(row.is_managed),
    activeBranch: row.active_branch ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class SQLiteService {
  private db: Database.Database;

  constructor(options: { dbPath?: string; seedDefaults?: boolean } = {}) {
    this.db = new Database(options.dbPath ?? DB_PATH);
    this.initPragmas();
    this.initTables();
    this.migrate();
    this.ensureDefaultWorkspace();
    if (options.seedDefaults !== false) {
      this.seedDefaultsIfEmpty();
      this.ensureOfficialAgents();
      // Other workspaces are ensured when opened; their untouched agents still move to the current instructions now.
      for (const { id } of this.db.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>) {
        this.upgradeUnmodifiedOfficialAgents(id);
      }
    }
  }

  /**
   * Release the database handle.
   *
   * Windows will not unlink a file while a connection is open, so a test that
   * opens the store more than once against one directory cannot clean up after
   * itself without this. Also the honest way to shut the daemon down.
   */
  close(): void {
    this.db.close();
  }

  private initPragmas() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        organization TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS allowed_paths (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        added_at TEXT NOT NULL
      );

      /* Project creation can precede opening the workspace directory. */
      CREATE TABLE IF NOT EXISTS workspace_squad_projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        squad_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        relationship TEXT NOT NULL DEFAULT 'assigned',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, squad_id, project_id)
      );

      /*
       * Where a project's code is on THIS machine.
       *
       * Never in the project row: that row is the team's, and a path from one
       * developer's disk means nothing on another's -- the cloud store drops
       * local paths on write for exactly that reason. So the folder lives
       * here, keyed by the project's shared id, and each machine answers the
       * question for itself.
       *
       * No foreign key to projects: a binding may be made for a project this
       * machine has not pulled yet, and losing the project should not silently
       * discard where its code was.
       */
      CREATE TABLE IF NOT EXISTS local_project_bindings (
        project_id TEXT PRIMARY KEY,
        local_dir TEXT NOT NULL,
        is_managed INTEGER NOT NULL DEFAULT 0,
        active_branch TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      /*
       * The same, per repository: a paired project's -be and -fe are two
       * checkouts, each wherever its developer keeps it. A project binding
       * from before this table is read as its first repository's until it is
       * moved here (see projectBindings.migrateLegacyBinding).
       */
      CREATE TABLE IF NOT EXISTS local_repo_bindings (
        project_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        local_dir TEXT NOT NULL,
        is_managed INTEGER NOT NULL DEFAULT 0,
        active_branch TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, repo)
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        description TEXT,
        color TEXT,
        icon TEXT,
        status TEXT,
        priority TEXT,
        start_date TEXT,
        target_date TEXT,
        lead_type TEXT,
        lead_name TEXT,
        lead_agent_id TEXT,
        resources TEXT DEFAULT '[]',
        github_org TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_build_steps (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        project_id TEXT NOT NULL,
        label TEXT NOT NULL,
        phase TEXT NOT NULL,
        agent_id TEXT,
        squad_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        required INTEGER NOT NULL DEFAULT 1,
        approval_gate INTEGER NOT NULL DEFAULT 0,
        depends_on TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_project_build_steps_project
        ON project_build_steps(workspace_id, project_id, position);

      CREATE TABLE IF NOT EXISTS project_orchestration_settings (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_by TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        avatar TEXT,
        color TEXT,
        description TEXT,
        owner TEXT DEFAULT 'You',
        is_mine INTEGER DEFAULT 1,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        reasoning_effort TEXT,
        system_prompt TEXT DEFAULT '',
        autonomy_level TEXT NOT NULL,
        temperature REAL DEFAULT 0.7,
        skills TEXT DEFAULT '[]',
        mcp_servers TEXT DEFAULT '[]',
        custom_cli_args TEXT DEFAULT '',
        env_vars TEXT DEFAULT '[]',
        concurrency_limit INTEGER DEFAULT 2,
        is_archived INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        identifier TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        assigned_human TEXT,
        labels TEXT DEFAULT '[]',
        subtasks TEXT DEFAULT '[]',
        branch_name TEXT,
        pr_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar TEXT,
        agent_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_thinking INTEGER DEFAULT 0
      );

      /**
       * Everything Alpha or an agent did to a remote, and whether it worked.
       *
       * Agents can reach GitHub two ways: the MCP tools, and raw git or gh
       * through Bash, which a run permits. Neither left a record anybody could
       * read: a push appeared only in the CLI's own scrollback, and Alpha's own
       * pushes only as a line in a stage log that a failure overwrote.
       *
       * No foreign key to runs. An action recorded a moment before a run row is
       * rewritten must not vanish with it, and the point of an audit trail is
       * that it outlives the thing it describes.
       */
      CREATE TABLE IF NOT EXISTS remote_actions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        run_id TEXT,
        agent_id TEXT,
        issue_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        succeeded INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_remote_actions_run ON remote_actions(run_id);

      CREATE TABLE IF NOT EXISTS prototype_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        scenario TEXT DEFAULT 'success',
        plan TEXT DEFAULT '[]',
        current_stage_index INTEGER DEFAULT 0,
        stages TEXT NOT NULL,
        branch_name TEXT,
        checkpoint_commit TEXT,
        pr_url TEXT,
        changed_files INTEGER DEFAULT 0,
        insertions INTEGER DEFAULT 0,
        deletions INTEGER DEFAULT 0,
        test_summary TEXT,
        verification_evidence TEXT,
        activities TEXT NOT NULL DEFAULT '[]',
        orchestration_run_id TEXT,
        orchestration_task_id TEXT,
        orchestration_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS squads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        name TEXT NOT NULL,
        topology TEXT NOT NULL,
        leader_agent_id TEXT,
        member_agent_ids TEXT DEFAULT '[]',
        mission TEXT NOT NULL,
        active_runs_count INTEGER DEFAULT 0,
        completed_runs_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        permissions TEXT NOT NULL,
        description TEXT NOT NULL,
        is_enabled INTEGER DEFAULT 1,
        command_example TEXT,
        source TEXT DEFAULT 'builtin',
        path TEXT,
        installed INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS runtimes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        type TEXT DEFAULT 'cloud',
        latency_ms INTEGER DEFAULT 0,
        endpoint TEXT,
        version TEXT,
        is_default INTEGER DEFAULT 0,
        models TEXT DEFAULT '[]',
        account TEXT DEFAULT '{}',
        detected_at TEXT,
        catalog_source TEXT DEFAULT 'none',
        catalog_checked_at TEXT,
        catalog_fetched_at TEXT,
        catalog_stale INTEGER DEFAULT 0,
        catalog_error TEXT,
        update_available INTEGER DEFAULT 0,
        latest_version TEXT,
        update_checked_at TEXT,
        update_error TEXT,
        update_source TEXT DEFAULT 'none'
      );

      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        title TEXT NOT NULL,
        last_message_snippet TEXT,
        last_message_at TEXT NOT NULL,
        agent_ids TEXT DEFAULT '[]',
        target_agent_id TEXT,
        target_squad_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        agent_id TEXT,
        content TEXT NOT NULL,
        thinking_process TEXT,
        tools_executed TEXT DEFAULT '[]',
        message_type TEXT DEFAULT 'assistant',
        agent_call_id TEXT,
        orchestration_run_id TEXT,
        squad_id TEXT,
        operation_mode TEXT,
        agent_call_status TEXT,
        revision_target TEXT,
        route_proposal TEXT,
        timestamp TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        message_id TEXT,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        inspection TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_attachments_thread
        ON chat_attachments(thread_id, created_at);

      /* Durable, ordered publication of the owner's local chat changes. */
      CREATE TABLE IF NOT EXISTS chat_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sync_outbox_due
        ON chat_sync_outbox(owner_id, next_attempt_at, id);
      CREATE INDEX IF NOT EXISTS idx_chat_sync_outbox_thread_order
        ON chat_sync_outbox(workspace_id, owner_id, thread_id, id);

      CREATE TABLE IF NOT EXISTS agent_calls (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        message_id TEXT,
        squad_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        operation_mode TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'agent_call',
        status TEXT NOT NULL,
        revision_target_type TEXT,
        revision_target_id TEXT,
        revision_target_label TEXT,
        instruction TEXT NOT NULL,
        working_copy_id TEXT,
        working_branch TEXT,
        working_commit TEXT,
        result_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        activities TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS agent_call_artifacts (
        id TEXT PRIMARY KEY,
        agent_call_id TEXT NOT NULL REFERENCES agent_calls(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL,
        path TEXT,
        content_reference TEXT,
        content TEXT,
        created_at TEXT NOT NULL
      );

      /*
       * Short-lived local ownership for code-capable project calls and patch
       * application. The row is acquired in the same SQLite transaction as
       * call admission, so planning and independent calls cannot both win a
       * read-then-write race for the same repository.
       */
      CREATE TABLE IF NOT EXISTS project_code_execution_locks (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        repository TEXT NOT NULL,
        owner_call_id TEXT NOT NULL REFERENCES agent_calls(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('call', 'patch')),
        acquired_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, project_id, repository_key)
      );
      CREATE INDEX IF NOT EXISTS idx_project_code_execution_locks_owner
        ON project_code_execution_locks(owner_call_id);

      /*
       * Versioned, task-driven builds live beside legacy squad_runs. Keeping
       * separate records prevents a task graph from being mistaken for an
       * ordered member roster by older runners and clients.
       */
      CREATE TABLE IF NOT EXISTS orchestration_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        origin_chat_thread_id TEXT,
        origin_build_message_id TEXT,
        repository TEXT NOT NULL,
        request_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        created_by TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        ownership_epoch INTEGER NOT NULL DEFAULT 1,
        workflow_version INTEGER NOT NULL,
        plan_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        current_task_id TEXT,
        pause_requested_at TEXT,
        pause_requested_by TEXT,
        stopped_reason TEXT,
        branch_name TEXT,
        base_ref TEXT,
        base_commit TEXT,
        worktree_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        UNIQUE (workspace_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_project
        ON orchestration_runs(workspace_id, project_id, created_at DESC);

      /*
       * Durable admission while a read-only planner is running. The unique
       * repository key prevents another local build or independent code call
       * from entering the same project/repository before the immutable plan
       * has been activated as an orchestration run.
       */
      CREATE TABLE IF NOT EXISTS orchestration_planning_reservations (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repository TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        request_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        owner_session_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, request_key),
        UNIQUE (workspace_id, project_id, repository_key)
      );

      /*
       * Durable recovery record for planner worktrees that could not be
       * safely retired. A human may explicitly keep the saved files and
       * release repository admission; the record remains for room history.
       */
      CREATE TABLE IF NOT EXISTS orchestration_planning_recoveries (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        request_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        owner_session_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('needs_review', 'manual_review', 'retained', 'cleaned')),
        reason TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        PRIMARY KEY (workspace_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_planning_recoveries_project
        ON orchestration_planning_recoveries(workspace_id, project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS orchestration_plans (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        source TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, run_id, version),
        FOREIGN KEY (workspace_id, run_id) REFERENCES orchestration_runs(workspace_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS orchestration_tasks (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        kind TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        requirement_ids_json TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        required INTEGER NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        accepted_revision INTEGER,
        correction_of_task_id TEXT,
        correction_cycle INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, run_id, task_id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES orchestration_runs(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_ready
        ON orchestration_tasks(workspace_id, run_id, status, task_id);

      CREATE TABLE IF NOT EXISTS orchestration_attempts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        prototype_run_id TEXT,
        starting_commit TEXT,
        result_commit TEXT,
        persona_hash TEXT,
        model_provider TEXT,
        model_name TEXT,
        context_manifest_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        result_json TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (workspace_id, run_id, task_id, attempt_number),
        UNIQUE (prototype_run_id),
        FOREIGN KEY (workspace_id, run_id, task_id)
          REFERENCES orchestration_tasks(workspace_id, run_id, task_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_one_active_attempt
        ON orchestration_attempts(workspace_id, run_id)
        WHERE status IN ('starting', 'running', 'submitted', 'recovery_required');

      CREATE TABLE IF NOT EXISTS orchestration_artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content_reference TEXT,
        content TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id, run_id, task_id)
          REFERENCES orchestration_tasks(workspace_id, run_id, task_id) ON DELETE CASCADE,
        FOREIGN KEY (attempt_id) REFERENCES orchestration_attempts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS orchestration_findings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        requirement_id TEXT,
        artifact_id TEXT,
        path TEXT,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL,
        correction_task_id TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (workspace_id, run_id, task_id)
          REFERENCES orchestration_tasks(workspace_id, run_id, task_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS orchestration_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        run_sequence INTEGER NOT NULL,
        actor_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, run_id, run_sequence),
        FOREIGN KEY (workspace_id, run_id) REFERENCES orchestration_runs(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_events_cursor
        ON orchestration_events(workspace_id, run_id, id);

      CREATE TABLE IF NOT EXISTS orchestration_recovery_episodes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        task_id TEXT,
        attempt_id TEXT,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        error_code TEXT NOT NULL,
        summary TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('repairing', 'waiting_for_user', 'ready_to_continue', 'resolved', 'cancelled')),
        episode_number INTEGER NOT NULL DEFAULT 1,
        repair_budget INTEGER NOT NULL DEFAULT 2,
        attempts_used INTEGER NOT NULL DEFAULT 0,
        guidance TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        thread_id TEXT,
        build_message_id TEXT,
        initiated_by TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES orchestration_runs(workspace_id, id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_one_open_recovery
        ON orchestration_recovery_episodes(workspace_id, run_id)
        WHERE phase IN ('repairing', 'waiting_for_user', 'ready_to_continue');
      CREATE INDEX IF NOT EXISTS idx_orchestration_recovery_project
        ON orchestration_recovery_episodes(workspace_id, project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS orchestration_recovery_actions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        recovery_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        expected_run_revision INTEGER NOT NULL,
        expected_recovery_revision INTEGER NOT NULL,
        expected_task_revision INTEGER,
        action TEXT NOT NULL,
        guidance TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (workspace_id, recovery_id, idempotency_key),
        FOREIGN KEY (workspace_id, run_id) REFERENCES orchestration_runs(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, recovery_id) REFERENCES orchestration_recovery_episodes(workspace_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_lesson_decisions (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'dismissed')),
        text TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, agent_id, lesson_id)
      );

      CREATE TABLE IF NOT EXISTS orchestration_recovery_milestones (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        recovery_id TEXT NOT NULL,
        milestone_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE (workspace_id, recovery_id, milestone_key),
        FOREIGN KEY (workspace_id, run_id) REFERENCES orchestration_runs(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, recovery_id) REFERENCES orchestration_recovery_episodes(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_recovery_milestones_pending
        ON orchestration_recovery_milestones(workspace_id, delivered_at, created_at);

      CREATE TABLE IF NOT EXISTS orchestration_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id, run_id) REFERENCES orchestration_runs(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_outbox_due
        ON orchestration_outbox(workspace_id, delivered_at, next_attempt_at, id);
    `);
  }

  /**
   * Additive column migrations.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op once a table exists, so new columns
   * never reach a database created by an earlier build. Anyone who has already
   * run Alpha has such a database. Each ALTER is wrapped because SQLite throws
   * "duplicate column name" when it has already been applied, and that is the
   * expected outcome on every start after the first.
   */
  private migrate() {
    /**
     * CLI session continuity.
     *
     * `claude --resume <id>` and `agy --conversation <id>` restore a transcript
     * that lives on THIS machine's disk:
     *   ~/.claude/projects/<cwd>/<id>.jsonl
     *   ~/.gemini/antigravity-cli/conversations/<id>.db
     *
     * So a session id is a pointer into local storage, not portable data. The
     * key is (thread, machine, agent), never thread alone:
     *   - machine, because a teammate resuming another machine's id gets
     *     "session not found";
     *   - agent, because a Claude session id means nothing to `agy`, and one
     *     thread can address both.
     *
     * `machine_id` is a constant while Alpha is single-machine, and starts
     * varying the day threads sync through Supabase — no migration needed then.
     */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id      TEXT NOT NULL,
        machine_id     TEXT NOT NULL,
        agent_id       TEXT NOT NULL,
        cli_session_id TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (thread_id, machine_id, agent_id)
      );
    `);

    const additions: Array<[string, string]> = [
      ['projects', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['agents', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['issues', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['prototype_runs', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['squads', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['chat_threads', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['project_build_steps', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['remote_actions', "workspace_id TEXT NOT NULL DEFAULT 'ws-default'"],
      ['runtimes', "type TEXT DEFAULT 'cloud'"],
      ['runtimes', 'latency_ms INTEGER DEFAULT 0'],
      ['runtimes', 'endpoint TEXT'],
      ['runtimes', "catalog_source TEXT DEFAULT 'none'"],
      ['runtimes', 'catalog_checked_at TEXT'],
      ['runtimes', 'catalog_fetched_at TEXT'],
      ['runtimes', 'catalog_stale INTEGER DEFAULT 0'],
      ['runtimes', 'catalog_error TEXT'],
      ['runtimes', 'update_available INTEGER DEFAULT 0'],
      ['runtimes', 'latest_version TEXT'],
      ['runtimes', 'update_checked_at TEXT'],
      ['runtimes', 'update_error TEXT'],
      ['runtimes', "update_source TEXT DEFAULT 'none'"],
      ['skills', "source TEXT DEFAULT 'builtin'"],
      ['skills', 'path TEXT'],
      ['skills', 'installed INTEGER DEFAULT 0'],
      // Owning GitHub organization. Null on every project created before repo
      // scaffolding existed, which is why the create form asks when it is unset
      // rather than assuming one.
      ['projects', 'github_org TEXT'],
      // The PM who created it: what puts a project in the workspace's catalogue.
      ['projects', 'created_by TEXT'],
      // Fingerprint of the persona in force when this CLI session started.
      //
      // Only Claude Code receives the persona on every turn (via
      // --append-system-prompt). `codex` and `agy` take it prepended to the
      // FIRST message only, so an edit to an agent's persona file was invisible
      // to any conversation already underway — possibly forever. Comparing this
      // against the current persona is what lets a live session be told its
      // instructions changed. Null on sessions that predate the column.
      ['thread_sessions', 'persona_hash TEXT'],
      /**
       * What a run actually cost.
       *
       * The stream parsers have decoded these from every CLI's `result` event
       * since they were written, and every one was discarded when the turn
       * ended — so Alpha could not say how many tokens a run used, while the
       * agent cards showed a hardcoded 620,000 for everyone.
       *
       * Deliberately no DEFAULT 0. NULL means the CLI did not report the
       * figure (codex reports no cache reads, Claude no separate thinking
       * tokens, Antigravity no cost) and zero means it reported zero. A
       * default would turn every unmeasured field into a confident zero on a
       * billing screen, which is the fabrication this codebase keeps having to
       * remove.
       */
      ['prototype_runs', 'input_tokens INTEGER'],
      ['prototype_runs', 'output_tokens INTEGER'],
      ['prototype_runs', 'cache_read_tokens INTEGER'],
      ['prototype_runs', 'cache_creation_tokens INTEGER'],
      ['prototype_runs', 'thinking_tokens INTEGER'],
      ['prototype_runs', 'cost_usd REAL'],
      ['prototype_runs', 'num_turns INTEGER'],
      ['prototype_runs', 'orchestration_run_id TEXT'],
      ['prototype_runs', 'orchestration_task_id TEXT'],
      ['prototype_runs', 'orchestration_attempt_id TEXT'],
      ['prototype_runs', 'checkpoint_commit TEXT'],
      ['prototype_runs', 'verification_evidence TEXT'],
      ['orchestration_runs', 'branch_name TEXT'],
      ['orchestration_runs', 'origin_chat_thread_id TEXT'],
      ['orchestration_runs', 'origin_build_message_id TEXT'],
      ['orchestration_runs', 'base_ref TEXT'],
      ['orchestration_runs', 'base_commit TEXT'],
      ['orchestration_runs', 'worktree_path TEXT'],
      ['orchestration_runs', 'pause_requested_at TEXT'],
      ['orchestration_runs', 'pause_requested_by TEXT'],
      ['orchestration_runs', "repository_workspaces_json TEXT NOT NULL DEFAULT '[]'"],
      ['orchestration_tasks', "scope_json TEXT NOT NULL DEFAULT '{}'"],
      /**
       * Which squad run this run is a member's turn in, and where in the order.
       *
       * Nullable because most runs are a single agent working alone, which
       * stays the ordinary case.
       */
      ['prototype_runs', 'squad_run_id TEXT'],
      ['prototype_runs', 'squad_order INTEGER'],
      // User-safe chronological run activity. Older databases get an empty
      // feed and begin recording events as soon as the new daemon starts.
      ['prototype_runs', "activities TEXT NOT NULL DEFAULT '[]'"],
      /**
       * Squad identity, which the create form has always collected and the
       * table has never held.
       *
       * `CreateSquadModal` asks for a description and an avatar, and
       * `SquadsView` renders both — `{squad.avatar}` on the card and in the
       * header, `squad.description` in the list and in search. The INSERT named
       * six columns and dropped all three, so a squad you assembled came back
       * from a reload blank-faced and undescribed while the seeded one looked
       * fine. Nothing errored: the handler returns the object it was given.
       */
      ['squads', 'description TEXT'],
      ['squads', 'avatar TEXT'],
      ['squads', 'color TEXT'],
      /**
       * Who may use an agent.
       *
       * Offered as a dropdown when creating an agent, as a bulk action over a
       * selection, and as a filter on the roster — all against a column that
       * did not exist. Every agent therefore read as the default no matter what
       * was chosen, and the filter could only ever match that default.
       *
       * Nullable rather than DEFAULT 'team': a row written before this column
       * existed genuinely has no answer, and the read path supplies the default
       * so the two cases stay distinguishable here.
       */
      ['agents', 'allowed_users TEXT'],
      ['agents', 'reasoning_effort TEXT'],
      // Official templates are product scaffolding, not a copy of somebody's
      // work. These nullable columns let a local agent be linked to the
      // template that created it without treating every manually created agent
      // as a system record.
      ['agents', 'template_key TEXT'],
      ['agents', 'template_version INTEGER'],
      ['agents', 'phase TEXT'],
      ['agents', 'is_seeded INTEGER DEFAULT 0'],
      ['agents', 'shared_key TEXT'],
      /**
       * Which project a conversation is about.
       *
       * A run resolved the project's working copy; a chat was pinned to the
       * workspaces root. So an agent asked in chat to review the repository it
       * had just edited in a run could not see it — it read an empty managed
       * root and correctly declined to guess.
       *
       * Nullable, and null is the ordinary case: a thread that names no project
       * keeps the old behaviour and stays in the managed root, which is right
       * for a conversation that is not about code.
       */
      ['chat_threads', 'project_id TEXT'],
      // A thread may be addressed to one agent, one squad, or Alpha's
      // automatic responder. This is separate from agent_ids, which is the
      // historical participant roster and grows as a conversation speaks to
      // more agents.
      ['chat_threads', 'target_agent_id TEXT'],
      ['chat_threads', 'target_squad_id TEXT'],
      ['chat_messages', "attachments_json TEXT NOT NULL DEFAULT '[]'"],
      /**
       * Whose conversation this is.
       *
       * The table had only `workspace_id`, so `GET /chat/threads` returned
       * every thread in the workspace to every member — one developer could
       * read another's prompts. There was no column to filter on, which is why
       * the filter was never written.
       *
       * Nullable, because ADD COLUMN cannot be NOT NULL without a default and
       * there is no sensible default for "who wrote this". Existing rows are
       * claimed at startup by `claimUnownedThreads()`: on a desktop install
       * every legacy thread belongs to the one person at the keyboard, and a
       * cloud database has no legacy rows to claim.
       */
      ['chat_threads', 'owner_id TEXT'],
      /**
       * The squad assigned to an issue.
       *
       * Both halves of this already existed and never met: CreateIssueModal
       * sends `assignedSquadId` on every issue it creates, and IssuesView reads
       * it to draw the assignee avatar. The column did not exist, so the value
       * was dropped by the INSERT and the avatar never resolved — an issue could
       * be given a squad in the form and would forget by the time it reached the
       * board.
       *
       * Nullable: most issues are one agent working alone, which stays the
       * ordinary case.
       */
      ['issues', 'assigned_squad_id TEXT'],
      /**
       * Per-project environment values, for resolving `${VAR}` in MCP servers.
       *
       * The MCP catalog is one global file, so a hosted server appears once —
       * but the thing it points at is per project. A Supabase MCP entry scoped
       * with `?project_ref=${SUPABASE_PROJECT_REF}` is the same server for ALF
       * and AFE and must not be the same Supabase project.
       *
       * Same shape and same validation as `agents.env_vars`, deliberately: two
       * spellings of "environment values for this thing" would be one more
       * place to look when a variable does not resolve.
       *
       * Nullable, and null is the ordinary case — a project that needs no
       * per-project values resolves everything from the daemon's environment.
       */
      ['projects', 'env_vars TEXT'],
      ['workspace_squad_projects', "relationship TEXT NOT NULL DEFAULT 'assigned'"],
      /**
       * Who created an issue.
       *
       * There was no way to answer that, so "My Issues" filtered on "has any
       * assignee" instead — which is neither mine nor created by me, and which
       * one click on a filter chip undid.
       *
       * Holds a GitHub login where one is available, an OS username otherwise.
       * Nullable, and null is correct for every issue that predates this: the
       * author genuinely was not recorded, and inventing one would be worse
       * than admitting it.
       */
      ['issues', 'created_by TEXT'],
      /**
       * The GitHub issue this card is.
       *
       * The board is one person's SQLite file, so a second collaborator
       * installing Alpha gets an empty one and no way to ever see the first.
       * GitHub already holds shared issues for the six people in this
       * organisation, so it becomes the board and these two columns are the
       * link back to it.
       *
       * Repository as well as number, because a number is only unique within
       * one repository and a workspace spans several.
       *
       * Nullable: an issue created before the board was shared, or in a project
       * with no GitHub repository attached, is a local card and stays one.
       */
      ['issues', 'github_repo TEXT'],
      ['issues', 'github_number INTEGER'],
      ['issues', 'github_url TEXT'],
      // Identifies the local daemon that owns an in-progress read-only plan.
      // Null on older databases means the reservation predates this fence and
      // must be reconciled before another build can use the repository.
      ['orchestration_planning_reservations', 'owner_session_id TEXT'],
      /**
       * The GitHub comment this one is, when it has reached GitHub.
       *
       * Comments are written from ten places — runs, squads, the review gate,
       * issue creation — and only some of them are an HTTP request, so "push
       * when a person acts" does not cover them. Null means "not on GitHub
       * yet", which makes the push a query rather than a hook: send every
       * comment without an id, record the id it comes back with.
       *
       * That is also what stops a loop. A comment pulled from GitHub arrives
       * with its id already set, so it is never a candidate to be pushed back.
       */
      ['issue_comments', 'github_id INTEGER']
      ,['chat_messages', 'message_type TEXT DEFAULT \'assistant\'']
      ,['chat_messages', 'agent_call_id TEXT']
      ,['chat_messages', 'orchestration_run_id TEXT']
      ,['chat_messages', 'squad_id TEXT']
      ,['chat_messages', 'operation_mode TEXT']
      ,['chat_messages', 'agent_call_status TEXT']
      ,['chat_messages', 'revision_target TEXT']
      ,['chat_messages', 'route_proposal TEXT']
      ,['agent_calls', "activities TEXT NOT NULL DEFAULT '[]'"]
      ,['agent_calls', 'working_branch TEXT']
      ,['agent_calls', 'working_commit TEXT']
      ,['agent_calls', "origin TEXT NOT NULL DEFAULT 'agent_call'"]
      ,['orchestration_tasks', 'correction_of_task_id TEXT']
      ,['orchestration_tasks', 'correction_cycle INTEGER']
    ];


    for (const [table, definition] of additions) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
        console.log(`[db] migrated ${table}.${definition.split(' ')[0]}`);
      } catch {
        // Already present — normal on every start after the migration landed.
      }
    }

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_workspace_shared_key
      ON agents (workspace_id, shared_key) WHERE shared_key IS NOT NULL
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS squad_runs (
        id                   TEXT PRIMARY KEY,
        workspace_id         TEXT NOT NULL DEFAULT 'ws-default',
        squad_id             TEXT NOT NULL,
        issue_id             TEXT NOT NULL,
        project_id           TEXT NOT NULL,
        branch_name          TEXT NOT NULL,
        member_agent_ids     TEXT NOT NULL DEFAULT '[]',
        current_member_index INTEGER NOT NULL DEFAULT 0,
        status               TEXT NOT NULL,
        mission              TEXT NOT NULL DEFAULT '',
        plan                 TEXT NOT NULL DEFAULT '[]',
        member_assignments   TEXT NOT NULL DEFAULT '[]',
        stopped_reason       TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      -- After the ALTERs above: this indexes a column they add.
      CREATE INDEX IF NOT EXISTS idx_runs_squad_run ON prototype_runs(squad_run_id);
      DROP INDEX IF EXISTS idx_agents_template_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_workspace_template_key
        ON agents(workspace_id, template_key) WHERE template_key IS NOT NULL;
    `);

    try {
      this.db.exec("ALTER TABLE squad_runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default'");
    } catch {
      // Already present.
    }

    try {
      this.db.exec("ALTER TABLE squad_runs ADD COLUMN member_assignments TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Already present.
    }

    // Rows from before workspaces existed belong to the default workspace.
    for (const table of ['projects', 'project_build_steps', 'agents', 'issues', 'prototype_runs', 'squads', 'chat_threads', 'squad_runs', 'remote_actions']) {
      this.db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''`)
        .run(DEFAULT_WORKSPACE_ID);
    }

  }

  private ensureDefaultWorkspace(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO workspaces (id, name, slug, organization, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_WORKSPACE_ID,
      'Alpha Workspace',
      'alpha-workspace',
      null,
      now,
      now
    );
  }

  private workspaceId(): string {
    return currentWorkspaceId();
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    return row ? {
      id: row.id,
      name: row.name,
      slug: row.slug,
      organization: row.organization ?? undefined,
      role: 'owner',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } : undefined;
  }

  getWorkspaces(): Workspace[] {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC').all() as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      organization: row.organization ?? undefined,
      role: 'owner' as const,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  createWorkspace(input: Partial<Workspace>): Workspace {
    const now = new Date().toISOString();
    const name = String(input.name || 'Untitled Workspace').trim() || 'Untitled Workspace';
    const baseSlug = String(input.slug || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `workspace-${Date.now()}`;
    let slug = baseSlug;
    let suffix = 2;
    while (this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    const workspace: Workspace = {
      id: input.id || `ws-${Date.now()}-${randomUUID().slice(0, 8)}`,
      name,
      slug,
      organization: input.organization || undefined,
      role: 'owner',
      createdAt: now,
      updatedAt: now
    };

    this.db.prepare(`
      INSERT INTO workspaces (id, name, slug, organization, created_at, updated_at)
      VALUES (@id, @name, @slug, @organization, @createdAt, @updatedAt)
    `).run({ ...workspace, organization: workspace.organization ?? null });

    this.seedWorkspace(workspace.id, workspace.name);
    return workspace;
  }

  /**
   * Give a workspace the agents it starts life with.
   *
   * Separate from `createWorkspace` because the workspace row itself is no
   * longer written here: membership decides who may open one, so the row is
   * the directory's (Postgres in the cloud, SQLite on a desktop) while the
   * agents it seeds are still this store's.
   *
   * Projects and issues stay intentionally empty: those are the owner's work,
   * not product seed data.
   */
  seedWorkspace(workspaceId: string, name: string): void {
    runWithWorkspace(workspaceId, () => {
      this.ensureOfficialAgents(workspaceId);
      void name;
    });
  }

  updateWorkspace(id: string, updates: Partial<Workspace>): Workspace | null {
    const existing = this.getWorkspace(id);
    if (!existing) return null;
    const name = updates.name === undefined ? existing.name : String(updates.name).trim();
    const slug = updates.slug === undefined ? existing.slug : String(updates.slug).trim();
    if (!name || !slug) return null;
    this.db.prepare(`
      UPDATE workspaces SET name = ?, slug = ?, organization = ?, updated_at = ? WHERE id = ?
    `).run(name, slug, updates.organization ?? existing.organization ?? null, new Date().toISOString(), id);
    return this.getWorkspace(id) ?? null;
  }

  /**
   * Have the defaults already been planted in this database?
   *
   * Recorded, not inferred. This used to ask `SELECT count(*) FROM projects` —
   * "is there a project?" standing in for "have we seeded?" — and the two are
   * different facts. Deleting your last project made the next startup believe
   * the database was new, so it re-ran the seed and threw
   * `UNIQUE constraint failed: skills.id` from the constructor, before the
   * daemon could listen. Alpha would not boot, and the only documented recovery
   * was deleting alpha.db, which takes every conversation, issue and run with
   * it.
   *
   * A `meta` row cannot be deleted by anything the user does in the product, so
   * it answers the question it is actually being asked.
   */
  private hasSeeded(): boolean {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'seeded_at'")
      .get() as { value: string } | undefined;

    if (row) return true;

    /**
     * An install that predates this marker.
     *
     * Its defaults are already there — it just never recorded them. Anything in
     * `skills` is proof, because only the seed writes that table. Marked now so
     * the check is cheap forever after, and so deleting the last project cannot
     * resurrect the old behaviour on an existing database.
     */
    const seeded = (this.db.prepare('SELECT count(*) as count FROM skills').get() as { count: number }).count > 0;
    if (seeded) this.markSeeded();
    return seeded;
  }

  private markSeeded(): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_at', ?)")
      .run(new Date().toISOString());
  }

  /**
   * Seed Alpha's approved role catalogue without treating a restart as a reset.
   *
   * The former five records are recognised by their stable ids and linked to a
   * matching template only; no user-facing or persona field is rewritten. The
   * old full-stack Developer intentionally remains a legacy custom agent while
   * Backend and Frontend are seeded as separate official roles.
   */
  /** Public for the store adapter, which offers it as `ensureOfficial`. */
  ensureOfficialAgents(workspaceId = this.workspaceId()): void {
    const linkLegacy = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE agents
        SET template_key = @templateKey,
            template_version = @templateVersion,
            phase = @phase,
            is_seeded = 1,
            shared_key = coalesce(shared_key, @sharedKey)
        WHERE id = @id AND workspace_id = @workspaceId AND template_key IS NULL
      `);

      for (const [id, key] of Object.entries(LEGACY_TEMPLATE_MAPPINGS)) {
        const template = OFFICIAL_AGENT_TEMPLATES.find(item => item.key === key);
        if (!template) continue;
        stmt.run({
          id,
          templateKey: template.key,
          // These records predate the templates; they match version 1 at most,
          // and the upgrade below decides whether their text is untouched.
          templateVersion: 1,
          phase: template.phase,
          sharedKey: `official:${template.key}`,
          workspaceId
        });
      }
    });

    linkLegacy();

    const existing = new Set(
      (this.db.prepare('SELECT template_key FROM agents WHERE workspace_id = ? AND template_key IS NOT NULL').all(workspaceId) as Array<{ template_key: string }>)
        .map(row => row.template_key)
    );
    const existingIds = new Set(
      // Agent ids remain globally unique because they are referenced by runs,
      // issues, and persona files. The template membership itself is scoped.
      (this.db.prepare('SELECT id FROM agents').all() as Array<{ id: string }>).map(row => row.id)
    );
    const now = new Date().toISOString();

    for (const template of OFFICIAL_AGENT_TEMPLATES) {
      const sharedKey = `official:${template.key}`;
      if (existing.has(template.key)) {
        const current = this.db.prepare(
          'SELECT id FROM agents WHERE workspace_id = ? AND template_key = ?'
        ).get(workspaceId, template.key) as { id: string } | undefined;
        if (!current) continue;
        this.db.prepare('UPDATE agents SET shared_key = ? WHERE id = ? AND workspace_id = ?')
          .run(sharedKey, current.id, workspaceId);
        const sharedTemplate = this.db.prepare(
          'SELECT id FROM agents WHERE shared_key = ? AND workspace_id <> ? ORDER BY created_at LIMIT 1'
        ).get(sharedKey, workspaceId) as { id: string } | undefined;
        if (sharedTemplate) this.syncSharedProfile(sharedTemplate.id, workspaceId, current.id);
        continue;
      }

      // Shared user agents and official templates use the same sharing key
      // column. Only a still-linked template from another workspace is a
      // template source; a local persona whose template metadata was cleared
      // must remain user-owned even if it retains its former sharing key.
      const sharedTemplate = this.db.prepare(`SELECT id FROM agents
        WHERE shared_key = ? AND template_key = ? AND workspace_id <> ?
        ORDER BY created_at LIMIT 1`)
        .get(sharedKey, template.key, workspaceId) as { id: string } | undefined;
      if (sharedTemplate) {
        this.copySharedAgent(sharedTemplate.id, workspaceId, sharedKey);
        existing.add(template.key);
        continue;
      }

      // An installation may already have a manually created agent whose id
      // happens to match a new official role. That record is its owner's work,
      // not evidence that it is the template. Preserve it and give the seeded
      // record a deterministic alternate id instead of failing startup.
      const seeded = agentFromOfficialTemplate(template, now);
      if (existingIds.has(seeded.id)) {
        // An older official record may have been converted into a local custom
        // persona while retaining its internal official sharing key. Free that
        // reserved key before creating the new canonical template instance;
        // the user's persona row itself and its stable ID remain untouched.
        this.db.prepare(`UPDATE agents SET shared_key = NULL
          WHERE id = ? AND workspace_id = ? AND template_key IS NULL AND shared_key = ?`)
          .run(seeded.id, workspaceId, sharedKey);
        const baseId = `${seeded.id}-official`;
        let candidateId = baseId;
        let suffix = 2;
        while (existingIds.has(candidateId)) {
          candidateId = `${baseId}-${suffix}`;
          suffix += 1;
        }
        seeded.id = candidateId;
      }

      this.createAgent(seeded);
      this.db.prepare('UPDATE agents SET shared_key = ? WHERE id = ? AND workspace_id = ?')
        .run(`official:${template.key}`, seeded.id, workspaceId);
      existing.add(template.key);
      existingIds.add(seeded.id);
    }

    this.upgradeUnmodifiedOfficialAgents(workspaceId);
  }

  /**
   * Move official agents onto the current template, but only agents nobody edited.
   *
   * An agent's instructions live in two places: the database column and its
   * persona file, which wins when it has text. Both must still read exactly as
   * an earlier template wrote them; any other wording is its owner's work and
   * keeps its version, so the Agent Directory can offer the update instead.
   */
  private upgradeUnmodifiedOfficialAgents(workspaceId: string): void {
    const normalize = (text: string | undefined, name: string) => (text ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(new RegExp('^\\s*#\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n'), '')
      .replace(/\s+/g, ' ')
      .trim();
    const rows = this.db.prepare(`SELECT id, name, template_key, template_version, system_prompt FROM agents
      WHERE workspace_id = ? AND template_key IS NOT NULL`).all(workspaceId) as Array<{
        id: string; name: string; template_key: string; template_version: number | null; system_prompt: string | null;
      }>;
    for (const row of rows) {
      const template = OFFICIAL_AGENT_TEMPLATES.find(item => item.key === row.template_key);
      if (!template || (row.template_version ?? 0) >= template.version) continue;
      const earlier = new Set((PREVIOUS_TEMPLATE_PROMPTS[template.key] ?? []).map(prompt => normalize(prompt, row.name)));
      const fromFile = readAgentFile(row.id)?.systemPrompt;
      const untouched = earlier.has(normalize(row.system_prompt ?? '', row.name)) &&
        (fromFile === undefined || earlier.has(normalize(fromFile, row.name)));
      if (!untouched) continue;
      this.db.prepare(`UPDATE agents SET system_prompt = ?, description = ?, template_version = ?
        WHERE id = ? AND workspace_id = ?`).run(template.systemPrompt, template.description, template.version, row.id, workspaceId);
      const agent = runWithWorkspace(workspaceId, () => this.getAgents().find(item => item.id === row.id));
      if (agent) syncAgentFile(agent, 'replace');
    }
  }

  shareAgentAcrossWorkspaces(workspaceId: string, id: string, workspaceIds: string[]): Agent | null {
    const source = this.db.prepare('SELECT template_key, shared_key FROM agents WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as { template_key: string | null; shared_key: string | null } | undefined;
    if (!source) return null;
    const sharedKey = source.shared_key ?? (source.template_key ? `official:${source.template_key}` : `shared:${randomUUID()}`);
    this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET shared_key = ? WHERE id = ? AND workspace_id = ?').run(sharedKey, id, workspaceId);
      for (const targetWorkspaceId of new Set([workspaceId, ...workspaceIds])) {
        if (source.template_key) {
          const existingTemplate = this.db.prepare('SELECT id FROM agents WHERE workspace_id = ? AND template_key = ?')
            .get(targetWorkspaceId, source.template_key) as { id: string } | undefined;
          if (existingTemplate) {
            this.db.prepare('UPDATE agents SET shared_key = ? WHERE id = ? AND workspace_id = ?')
              .run(sharedKey, existingTemplate.id, targetWorkspaceId);
            continue;
          }
        }
        if (targetWorkspaceId !== workspaceId) this.copySharedAgent(id, targetWorkspaceId, sharedKey);
      }
    })();
    return this.getAgents().find(agent => agent.id === id) ?? null;
  }

  unshareAgentAcrossWorkspaces(workspaceId: string, id: string): Agent | null {
    const row = this.db.prepare('SELECT shared_key, template_key FROM agents WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as { shared_key: string | null; template_key: string | null } | undefined;
    if (row?.shared_key && !row.template_key) {
      this.db.prepare('UPDATE agents SET shared_key = NULL WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
    }
    return this.getAgents().find(agent => agent.id === id) ?? null;
  }

  syncSharedAgentsIntoWorkspace(workspaceId: string, workspaceIds: string[]): void {
    if (!workspaceIds.includes(workspaceId)) return;
    const placeholders = workspaceIds.map(() => '?').join(',');
    const shared = this.db.prepare(`
      SELECT id, shared_key FROM agents
      WHERE shared_key IS NOT NULL AND template_key IS NULL AND workspace_id IN (${placeholders})
      GROUP BY shared_key
    `).all(...workspaceIds) as Array<{ id: string; shared_key: string }>;
    const existing = this.db.prepare('SELECT shared_key FROM agents WHERE workspace_id = ? AND shared_key IS NOT NULL')
      .all(workspaceId) as Array<{ shared_key: string }>;
    const keys = new Set(existing.map(row => row.shared_key));
    for (const agent of shared) {
      if (keys.has(agent.shared_key)) continue;
      this.copySharedAgent(agent.id, workspaceId, agent.shared_key);
      keys.add(agent.shared_key);
    }
  }

  private copySharedAgent(sourceId: string, workspaceId: string, sharedKey: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO agents
        (id, workspace_id, name, role, avatar, color, description, owner, is_mine,
         model_provider, model_name, reasoning_effort, system_prompt, autonomy_level,
         temperature, skills, mcp_servers, custom_cli_args, env_vars, concurrency_limit,
         is_archived, allowed_users, template_key, template_version, phase, is_seeded,
         shared_key, created_at)
      SELECT @id, @workspaceId, name, role, avatar, color, description, owner, is_mine,
         model_provider, model_name, reasoning_effort, system_prompt, autonomy_level,
         temperature, skills, '[]', '', '[]', concurrency_limit,
         is_archived, allowed_users, template_key, template_version, phase, is_seeded,
         @sharedKey, created_at
      FROM agents WHERE id = @sourceId
    `).run({ id: `agent-shared-${randomUUID()}`, workspaceId, sharedKey, sourceId });
  }

  private syncSharedProfile(sourceId: string, workspaceId: string, targetId: string): void {
    this.db.prepare(`
      UPDATE agents SET
        name = (SELECT name FROM agents WHERE id = @sourceId),
        role = (SELECT role FROM agents WHERE id = @sourceId),
        avatar = (SELECT avatar FROM agents WHERE id = @sourceId),
        color = (SELECT color FROM agents WHERE id = @sourceId),
        description = (SELECT description FROM agents WHERE id = @sourceId),
        owner = (SELECT owner FROM agents WHERE id = @sourceId),
        is_mine = (SELECT is_mine FROM agents WHERE id = @sourceId),
        model_provider = (SELECT model_provider FROM agents WHERE id = @sourceId),
        model_name = (SELECT model_name FROM agents WHERE id = @sourceId),
        reasoning_effort = (SELECT reasoning_effort FROM agents WHERE id = @sourceId),
        system_prompt = (SELECT system_prompt FROM agents WHERE id = @sourceId),
        autonomy_level = (SELECT autonomy_level FROM agents WHERE id = @sourceId),
        temperature = (SELECT temperature FROM agents WHERE id = @sourceId),
        skills = (SELECT skills FROM agents WHERE id = @sourceId),
        concurrency_limit = (SELECT concurrency_limit FROM agents WHERE id = @sourceId),
        is_archived = (SELECT is_archived FROM agents WHERE id = @sourceId),
        allowed_users = (SELECT allowed_users FROM agents WHERE id = @sourceId)
      WHERE workspace_id = @workspaceId AND id = @targetId
    `).run({ sourceId, workspaceId, targetId });
    const copy = this.getAgents().find(agent => agent.id === targetId);
    if (copy) syncAgentFile(copy, 'preserve');
  }

  private seedDefaultsIfEmpty() {
    if (this.hasSeeded()) return;

    /**
     * Allowlist the managed workspace root, and only that.
     *
     * This used to seed `path.resolve('..')` — the directory above the daemon,
     * i.e. Alpha's own source tree — under the name "Alpha-v2 Workspace". Any
     * run that resolved there was therefore pre-approved, which is precisely
     * what let a project with no checkout run an agent inside Alpha itself.
     *
     * `isPathAllowed` matches on prefix, so this single entry covers every
     * repository Alpha clones or scaffolds beneath the root, and nothing else.
     */
    this.addAllowedPath(WORKSPACES_DIR, 'Alpha managed workspaces');

    // Default Skills
    const defaultSkills = BUILTIN_SKILLS;

    const insertSkill = this.db.prepare(`
      INSERT OR IGNORE INTO skills (id, name, category, permissions, description, is_enabled, command_example)
      VALUES (@id, @name, @category, @permissions, @description, @is_enabled, @command_example)
    `);
    defaultSkills.forEach(s => insertSkill.run({
      id: s.id,
      name: s.name,
      category: s.category,
      permissions: s.permissions,
      description: s.description,
      is_enabled: s.isEnabled ? 1 : 0,
      command_example: s.commandExample || ''
    }));

    // Official agent templates are seeded by ensureOfficialAgents() after the
    // first-time storage setup completes.

    /**
     * No project, and no issues.
     *
     * A fresh install used to arrive with a project called 'Alpha Orchestrator',
     * described as a 'multi-engine ambient autonomous agent orchestration
     * platform', holding three issues about implementing a stream parser, a
     * runtime probe and a self-healing CI workflow.
     *
     * That is Alpha's own backlog. On the machine it was written on it reads as
     * seed data; on anyone else's it is a stranger's work appearing on their
     * board, in a project describing a product they may not be building.
     *
     * The distinction this draws is between a template and someone else's data.
     * Agents and skills stay because they are scaffolding anyone
     * would want — Architect, Developer, Reviewer, Tester and Operator are
     * roles, not opinions about what you are working on. A project and its
     * issues are the work itself, and only its owner can say what that is.
     */


    // Last, so a seed that throws part-way is retried rather than recorded as
    // done. Everything above is idempotent, so the retry is safe.
    this.markSeeded();
  }

  // --- Allowed Paths ---
  // --- Local project bindings ---

  /** Where this machine keeps a project's code, if it has it. */
  getProjectBinding(projectId: string): LocalProjectBinding | null {
    const row = this.db
      .prepare('SELECT * FROM local_project_bindings WHERE project_id = ?')
      .get(projectId) as any;
    return row ? toBinding(row) : null;
  }

  listProjectBindings(): LocalProjectBinding[] {
    const rows = this.db.prepare('SELECT * FROM local_project_bindings').all() as any[];
    return rows.map(toBinding);
  }

  saveProjectBinding(binding: {
    projectId: string;
    localDir: string;
    isManaged?: boolean;
    activeBranch?: string;
    lastSyncedAt?: string;
  }): LocalProjectBinding {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO local_project_bindings
           (project_id, local_dir, is_managed, active_branch, last_synced_at, created_at, updated_at)
         VALUES (@projectId, @localDir, @isManaged, @activeBranch, @lastSyncedAt, @now, @now)
         ON CONFLICT(project_id) DO UPDATE SET
           local_dir = excluded.local_dir,
           is_managed = excluded.is_managed,
           active_branch = excluded.active_branch,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`
      )
      .run({
        projectId: binding.projectId,
        localDir: binding.localDir,
        isManaged: binding.isManaged ? 1 : 0,
        activeBranch: binding.activeBranch ?? null,
        lastSyncedAt: binding.lastSyncedAt ?? now,
        now
      });
    return this.getProjectBinding(binding.projectId)!;
  }

  deleteProjectBinding(projectId: string): boolean {
    return this.db.prepare('DELETE FROM local_project_bindings WHERE project_id = ?').run(projectId).changes > 0;
  }

  // --- Local repository bindings ---

  listRepoBindings(projectId: string): LocalRepoBinding[] {
    const rows = this.db.prepare('SELECT * FROM local_repo_bindings WHERE project_id = ?').all(projectId) as any[];
    return rows.map(row => ({ ...toBinding(row), repo: row.repo }));
  }

  getRepoBinding(projectId: string, repo: string): LocalRepoBinding | null {
    const row = this.db
      .prepare('SELECT * FROM local_repo_bindings WHERE project_id = ? AND repo = ?')
      .get(projectId, repo.toLowerCase()) as any;
    return row ? { ...toBinding(row), repo: row.repo } : null;
  }

  saveRepoBinding(binding: {
    projectId: string;
    repo: string;
    localDir: string;
    isManaged?: boolean;
    activeBranch?: string;
  }): LocalRepoBinding {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO local_repo_bindings
           (project_id, repo, local_dir, is_managed, active_branch, last_synced_at, created_at, updated_at)
         VALUES (@projectId, @repo, @localDir, @isManaged, @activeBranch, @now, @now, @now)
         ON CONFLICT(project_id, repo) DO UPDATE SET
           local_dir = excluded.local_dir,
           is_managed = excluded.is_managed,
           active_branch = excluded.active_branch,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`
      )
      .run({
        projectId: binding.projectId,
        repo: binding.repo.toLowerCase(),
        localDir: binding.localDir,
        isManaged: binding.isManaged ? 1 : 0,
        activeBranch: binding.activeBranch ?? null,
        now
      });
    return this.getRepoBinding(binding.projectId, binding.repo)!;
  }

  deleteRepoBinding(projectId: string, repo: string): boolean {
    return (
      this.db.prepare('DELETE FROM local_repo_bindings WHERE project_id = ? AND repo = ?').run(projectId, repo.toLowerCase())
        .changes > 0
    );
  }

  deleteRepoBindings(projectId: string): number {
    return this.db.prepare('DELETE FROM local_repo_bindings WHERE project_id = ?').run(projectId).changes;
  }

  addAllowedPath(filePath: string, name: string) {
    const normalized = path.resolve(filePath);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO allowed_paths (path, name, added_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(normalized, name, new Date().toISOString());
  }

  getAllowedPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM allowed_paths').all() as { path: string }[];
    return rows.map(r => r.path);
  }

  isPathAllowed(targetPath: string): boolean {
    const normalized = path.resolve(targetPath);
    const allowed = this.getAllowedPaths();
    return allowed.some(p => normalized === p || normalized.startsWith(p + path.sep));
  }

  // --- Projects ---
  /**
   * Point every reference to one id at another, in the tables that have the
   * column. Tables and columns are checked rather than assumed: some are
   * created by other modules on first use, or added by a later migration.
   */
  private repoint(refs: ReadonlyArray<readonly [string, string, string?]>, from: string, to: string): void {
    for (const [table, column, where] of refs) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some(c => c.name === column)) continue;
      this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?${where ? ` AND ${where}` : ''}`).run(to, from);
    }
  }

  /**
   * Move a project this machine made onto the team's id and key.
   *
   * Every installed desktop up to 2.0.6 ran without its team board -- the
   * Supabase client never started under Electron's Node -- so each one made
   * its own projects for the organisation's repositories, under ids nobody
   * else has. The team's copy then clashed with them on every pull, and the
   * team's cards for those repositories never arrived. Adopting the team's id
   * keeps this machine's history -- runs, chats, calls, build steps, its
   * folder -- attached to the same project, which is what it always was.
   *
   * One transaction, foreign keys checked at commit, so a failure changes
   * nothing. Returns false when the team's id or key is already taken here.
   */
  rekeyProject(from: string, to: string, toKey: string): boolean {
    if (from === to) return true;
    const exists = (sql: string, ...args: unknown[]) => Boolean(this.db.prepare(sql).get(...args));
    if (!exists('SELECT 1 FROM projects WHERE id = ?', from)) return false;
    if (exists('SELECT 1 FROM projects WHERE id = ?', to)) return false;
    if (exists('SELECT 1 FROM projects WHERE key = ? AND id <> ?', toKey, from)) return false;

    this.db.transaction(() => {
      this.db.pragma('defer_foreign_keys = ON');
      this.db.prepare('UPDATE projects SET id = ?, key = ? WHERE id = ?').run(to, toKey, from);
      this.repoint(
        [
          ['issues', 'project_id'],
          ['prototype_runs', 'project_id'],
          ['squad_runs', 'project_id'],
          ['chat_threads', 'project_id'],
          ['agent_calls', 'project_id'],
          ['agent_call_artifacts', 'project_id'],
          ['local_project_bindings', 'project_id'],
          ['project_build_steps', 'project_id'],
          ['workspace_project_assignments', 'project_id'],
          ['workspace_squad_projects', 'project_id'],
          ['workspace_entity_bindings', 'entity_id', "entity_type = 'projects'"]
        ],
        from,
        to
      );
    })();
    return true;
  }

  /**
   * Move a card this machine made onto the team's id and identifier: the same
   * GitHub issue, which the team holds under another id. Its comments, runs
   * and audit trail move with it. False when the team's id or identifier is
   * already another card's here.
   */
  rekeyIssue(from: string, to: string, toIdentifier: string): boolean {
    if (from === to) return true;
    const exists = (sql: string, ...args: unknown[]) => Boolean(this.db.prepare(sql).get(...args));
    if (!exists('SELECT 1 FROM issues WHERE id = ?', from)) return false;
    if (exists('SELECT 1 FROM issues WHERE id = ?', to)) return false;
    if (exists('SELECT 1 FROM issues WHERE identifier = ? AND id <> ?', toIdentifier, from)) return false;

    this.db.transaction(() => {
      this.db.pragma('defer_foreign_keys = ON');
      this.db.prepare('UPDATE issues SET id = ?, identifier = ? WHERE id = ?').run(to, toIdentifier, from);
      this.repoint(
        [
          ['issue_comments', 'issue_id'],
          ['prototype_runs', 'issue_id'],
          ['squad_runs', 'issue_id'],
          ['remote_actions', 'issue_id'],
          ['chat_threads', 'issue_id'],
          ['workspace_entity_bindings', 'entity_id', "entity_type = 'issues'"]
        ],
        from,
        to
      );
    })();
    return true;
  }

  getProjects(): Project[] {
    const rows = this.db.prepare(`SELECT p.*,
      (SELECT squad_id FROM workspace_squad_projects a WHERE a.workspace_id = p.workspace_id AND a.project_id = p.id
       AND a.relationship = 'owned' AND a.status = 'active' ORDER BY a.created_at LIMIT 1) AS lead_squad_id
      FROM projects p WHERE workspace_id = ? ORDER BY created_at DESC`).all(this.workspaceId()) as any[];
    return rows.map(r => ({
      ...r,
      startDate: r.start_date,
      targetDate: r.target_date,
      leadType: r.lead_type,
      leadName: r.lead_name,
      leadAgentId: r.lead_agent_id,
      leadSquadId: r.lead_squad_id || undefined,
      resources: JSON.parse(r.resources || '[]'),
      githubOrg: r.github_org || undefined,
      createdBy: r.created_by || undefined,
      envVars: JSON.parse(r.env_vars || '[]'),
      createdAt: r.created_at
    }));
  }

  /**
   * Create a project, defaulting everything the caller did not supply.
   *
   * `better-sqlite3` requires every named parameter to be bound, so a payload
   * missing `id` threw `RangeError: Missing named parameter "id"` — which
   * Express turned into a 500 HTML error page rather than anything a client
   * could read. The browser happened to work because `AppContext.createProject`
   * mints an id before posting; every other caller got the crash.
   *
   * This is the same defect `createChatThread` documents and already fixed for
   * the "New Conversation" button. Minting server-side is the correct place:
   * the client should not have to know the id format to create a row.
   */
  createProject(p: Partial<Project>): Project {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const complete: Project = {
        ...p,
        id: p.id || `proj-${Date.now()}`,
        name: p.name || 'Untitled Project',
        key: p.key || `P${Date.now().toString().slice(-4)}`,
        description: p.description ?? '',
        color: p.color || '#6366f1',
        icon: p.icon || '📁',
        status: p.status || 'in_progress',
        priority: p.priority || 'medium',
        targetDate: p.targetDate || '',
        createdAt: p.createdAt || now
      } as Project;

      const stmt = this.db.prepare(`
        INSERT INTO projects (id, workspace_id, name, key, description, color, icon, status, priority, start_date, target_date, lead_type, lead_name, lead_agent_id, resources, github_org, created_by, env_vars, created_at)
        VALUES (@id, @workspaceId, @name, @key, @description, @color, @icon, @status, @priority, @startDate, @targetDate, @leadType, @leadName, @leadAgentId, @resources, @githubOrg, @createdBy, @envVars, @createdAt)
      `);
      stmt.run({
        ...complete,
        workspaceId: this.workspaceId(),
        startDate: complete.startDate || now,
        targetDate: complete.targetDate || null,
        leadType: complete.leadType || 'agent',
        leadName: complete.leadName || '',
        leadAgentId: complete.leadAgentId || null,
        resources: JSON.stringify(complete.resources || []),
        githubOrg: complete.githubOrg || null,
        createdBy: complete.createdBy || null,
        envVars: JSON.stringify(complete.envVars || []),
        createdAt: complete.createdAt || now
      });

      // The completed row, not the caller's partial — it now carries the id and
      // defaults the caller did not send, which is what the client needs back.
      if (p.leadSquadId) {
        this.db.prepare(`INSERT INTO workspace_squad_projects (id, workspace_id, squad_id, project_id, relationship, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'owned', 'active', ?, ?)`).run(`squad-project-${randomUUID()}`, this.workspaceId(), p.leadSquadId, complete.id, now, now);
      }
      return complete;
    })();
  }

  updateProject(id: string, updates: Partial<Project>): Project | null {
    return this.db.transaction(() => {
      const existing = this.getProjects().find(p => p.id === id);
      if (!existing) return null;
      const merged = { ...existing, ...updates };
      const stmt = this.db.prepare(`
        UPDATE projects SET
          name = @name, key = @key, description = @description, color = @color, icon = @icon,
          status = @status, priority = @priority, start_date = @startDate, target_date = @targetDate,
          lead_type = @leadType, lead_name = @leadName, lead_agent_id = @leadAgentId, resources = @resources,
          github_org = @githubOrg, created_by = @createdBy, env_vars = @envVars
        WHERE id = @id AND workspace_id = @workspaceId
      `);
      stmt.run({
        ...merged,
        workspaceId: this.workspaceId(),
        leadAgentId: merged.leadAgentId || null,
        resources: JSON.stringify(merged.resources || []),
        githubOrg: merged.githubOrg || null,
        createdBy: merged.createdBy || null,
        envVars: JSON.stringify(merged.envVars || [])
      });
      if (Object.prototype.hasOwnProperty.call(updates, 'leadAgentId') || Object.prototype.hasOwnProperty.call(updates, 'leadSquadId')) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE workspace_squad_projects SET relationship = 'assigned', updated_at = ? WHERE workspace_id = ? AND project_id = ? AND relationship = 'owned' AND (? IS NULL OR squad_id <> ?)").run(now, this.workspaceId(), id, merged.leadSquadId || null, merged.leadSquadId || null);
        if (merged.leadSquadId) this.db.prepare(`INSERT INTO workspace_squad_projects (id, workspace_id, squad_id, project_id, relationship, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'owned', 'active', ?, ?)
          ON CONFLICT(workspace_id, squad_id, project_id) DO UPDATE SET relationship = 'owned', status = 'active', updated_at = excluded.updated_at`).run(`squad-project-${randomUUID()}`, this.workspaceId(), merged.leadSquadId, id, now, now);
      }
      return merged;
    })();
  }

  deleteProject(id: string): boolean {
    const workspaceId = this.workspaceId();
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM project_build_steps WHERE project_id = ? AND workspace_id = ?').run(id, workspaceId);
      return this.db.prepare('DELETE FROM projects WHERE id = ? AND workspace_id = ?').run(id, workspaceId).changes > 0;
    });
    return remove();
  }

  // --- Project Build Room ---
  getProjectBuildSteps(projectId: string): ProjectBuildStep[] {
    const workspaceId = this.workspaceId();
    const project = this.db
      .prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?')
      .get(projectId, workspaceId);
    if (!project) throw new Error('Project not found');

    const rows = this.db.prepare(`
      SELECT * FROM project_build_steps
      WHERE project_id = ? AND workspace_id = ?
      ORDER BY position ASC, created_at ASC
    `).all(projectId, workspaceId) as any[];

    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      label: row.label,
      phase: row.phase as BuildStepPhase,
      agentId: row.agent_id || undefined,
      squadId: row.squad_id || undefined,
      position: Number(row.position) || 0,
      enabled: Boolean(row.enabled),
      required: Boolean(row.required),
      approvalGate: Boolean(row.approval_gate),
      dependsOn: this.parseJsonArray(row.depends_on),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  getProjectOrchestrationSetting(projectId: string): { enabled: boolean; updatedAt?: string; updatedBy?: string } {
    const row = this.db.prepare(`SELECT enabled, updated_at, updated_by
      FROM project_orchestration_settings WHERE workspace_id = ? AND project_id = ?`)
      .get(this.workspaceId(), projectId) as { enabled: number; updated_at: string; updated_by: string | null } | undefined;
    // Keep old per-project rows readable for migration history, but an old
    // disabled value can no longer route desktop builds around the orchestrator.
    return row ? { enabled: true, updatedAt: row.updated_at, updatedBy: row.updated_by ?? undefined } : { enabled: true };
  }

  setProjectOrchestrationEnabled(projectId: string, enabled: boolean, updatedBy: string): { enabled: boolean; updatedAt: string; updatedBy: string } {
    const workspaceId = this.workspaceId();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const project = this.db.prepare('SELECT id FROM projects WHERE workspace_id = ? AND id = ?').get(workspaceId, projectId);
      if (!project) throw new Error('Project not found');
      if (!enabled) throw new Error('Project orchestration is always enabled on desktop');
      this.db.prepare(`INSERT INTO project_orchestration_settings (workspace_id, project_id, enabled, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, project_id) DO UPDATE SET enabled = excluded.enabled,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(workspaceId, projectId, 1, updatedBy, now);
      return { enabled: true, updatedAt: now, updatedBy };
    })();
  }

  saveProjectBuildSteps(
    projectId: string,
    input: Array<Partial<ProjectBuildStep>>
  ): ProjectBuildStep[] {
    const workspaceId = this.workspaceId();
    const project = this.db
      .prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?')
      .get(projectId, workspaceId);
    if (!project) throw new Error('Project not found');

    const agentIds = new Set(
      (this.db.prepare('SELECT id FROM agents WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string }>)
        .map(row => row.id)
    );
    const normalized = normalizeBuildSteps(projectId, input, agentIds);

    const replace = this.db.transaction(() => {
      this.db.prepare(
        'DELETE FROM project_build_steps WHERE project_id = ? AND workspace_id = ?'
      ).run(projectId, workspaceId);

      const insert = this.db.prepare(`
        INSERT INTO project_build_steps
          (id, workspace_id, project_id, label, phase, agent_id, squad_id, position,
           enabled, required, approval_gate, depends_on, created_at, updated_at)
        VALUES
          (@id, @workspaceId, @projectId, @label, @phase, @agentId, @squadId, @position,
           @enabled, @required, @approvalGate, @dependsOn, @createdAt, @updatedAt)
      `);

      for (const step of normalized) {
        insert.run({
          ...step,
          workspaceId,
          agentId: step.agentId ?? null,
          squadId: step.squadId ?? null,
          enabled: step.enabled ? 1 : 0,
          required: step.required ? 1 : 0,
          approvalGate: step.approvalGate ? 1 : 0,
          dependsOn: JSON.stringify(step.dependsOn ?? [])
        });
      }
    });
    replace();

    return this.getProjectBuildSteps(projectId);
  }

  private parseJsonArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
    try {
      const parsed = JSON.parse(String(value ?? '[]'));
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }

  // --- Agents ---
  /**
   * Per-agent run statistics, computed from the runs table.
   *
   * These were four hardcoded constants — 142 runs, 98.4% success, 620,000
   * tokens, 280ms — returned identically for every agent, including one
   * created a second ago. The billing screen multiplies that token figure by a
   * rate to show money, so a brand-new install displayed a bill for work that
   * never happened.
   *
   * Now that runs persist their token counts (see the prototype_runs
   * migration) these are all answerable from data.
   */
  private agentStats(): Map<string, { totalRuns: number; successRate: number; tokensUsed: number; avgLatencyMs: number; costUsd: number }> {
    const rows = this.db.prepare(`
      SELECT
        agent_id,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status IN ('completed', 'awaiting_approval') THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status IN ('completed', 'awaiting_approval', 'failed') THEN 1 ELSE 0 END) AS judged,
        SUM(
          COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) +
          COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0) +
          COALESCE(thinking_tokens, 0)
        ) AS tokens_used,
        SUM(COALESCE(cost_usd, 0)) AS cost_usd,
        AVG(
          CASE WHEN status NOT IN ('running', 'validating')
          THEN (julianday(updated_at) - julianday(created_at)) * 86400000 END
        ) AS avg_latency_ms
      FROM prototype_runs
      WHERE workspace_id = ?
      GROUP BY agent_id
    `).all(this.workspaceId()) as any[];

    return new Map(rows.map(r => [
      r.agent_id,
      {
        totalRuns: r.total_runs ?? 0,
        /**
         * Judged runs only: cancelled runs are excluded from the denominator
         * because the operator stopped them, which says nothing about whether
         * the agent could have succeeded. An agent with no judged runs gets 0
         * rather than an assumed 100 — the UI should read totalRuns to decide
         * whether a rate is worth showing at all.
         */
        successRate: r.judged ? Math.round((r.succeeded / r.judged) * 1000) / 10 : 0,
        tokensUsed: r.tokens_used ?? 0,
        costUsd: r.cost_usd ?? 0,
        avgLatencyMs: Math.round(r.avg_latency_ms ?? 0)
      }
    ]));
  }

  getAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at ASC').all(this.workspaceId()) as any[];
    const stats = this.agentStats();
    return rows.map(r => ({
      ...r,
      isMine: Boolean(r.is_mine),
      isArchived: Boolean(r.is_archived),
      modelProvider: r.model_provider,
      modelName: r.model_name,
      reasoningEffort: r.reasoning_effort ?? undefined,
      systemPrompt: r.system_prompt,
      autonomyLevel: r.autonomy_level,
      concurrencyLimit: r.concurrency_limit,
      skills: JSON.parse(r.skills || '[]'),
      mcpServers: JSON.parse(r.mcp_servers || '[]'),
      envVars: JSON.parse(r.env_vars || '[]'),
      customCliArgs: r.custom_cli_args,
      // Defaulted on read so a row predating the column behaves like the form's
      // own default, while the column itself stays nullable to keep "never set"
      // distinguishable from "deliberately set to team".
      allowedUsers: r.allowed_users ?? 'team',
      templateKey: r.template_key ?? undefined,
      templateVersion: r.template_version ?? undefined,
      phase: r.phase ?? undefined,
      isSeeded: Boolean(r.is_seeded),
      sharedKey: r.shared_key ?? undefined,
      stats: stats.get(r.id) ?? {
        totalRuns: 0,
        successRate: 0,
        tokensUsed: 0,
        costUsd: 0,
        avgLatencyMs: 0
      },
      /**
       * Archiving is a real state, not a UI flourish.
       *
       * This state used to be hardcoded, so an archived agent came back reporting
       * 'online' and 'idle' like any other. The client set 'offline' locally on
       * archive and a reload silently undid it — which also meant the roster
       * could not be trusted about what was actually retired.
       *
       * Physical liveness is added by the data controller from a runtime scan,
       * so this persistence mapper deliberately does not claim it.
       */
      workStatus: 'idle',
      status: r.is_archived ? 'offline' : 'idle',
      createdAt: r.created_at
    }));
  }

  createAgent(a: Agent): Agent {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, workspace_id, name, role, avatar, color, description, owner, is_mine, model_provider, model_name, reasoning_effort, system_prompt, autonomy_level, temperature, skills, mcp_servers, custom_cli_args, env_vars, concurrency_limit, is_archived, allowed_users, template_key, template_version, phase, is_seeded, created_at)
      VALUES (@id, @workspaceId, @name, @role, @avatar, @color, @description, @owner, @isMine, @modelProvider, @modelName, @reasoningEffort, @systemPrompt, @autonomyLevel, @temperature, @skills, @mcpServers, @customCliArgs, @envVars, @concurrencyLimit, @isArchived, @allowedUsers, @templateKey, @templateVersion, @phase, @isSeeded, @createdAt)
    `);
    stmt.run({
      ...a,
      workspaceId: this.workspaceId(),
      // As in createSquad: an unbound named parameter fails the insert, so
      // what a caller may reasonably omit takes its default here.
      avatar: a.avatar ?? '',
      color: a.color ?? '',
      description: a.description ?? '',
      owner: a.owner ?? 'Unassigned',
      systemPrompt: a.systemPrompt ?? '',
      isMine: a.isMine ? 1 : 0,
      isArchived: a.isArchived ? 1 : 0,
      temperature: a.temperature ?? 0.7,
      skills: JSON.stringify(a.skills || []),
      mcpServers: JSON.stringify(a.mcpServers || []),
      envVars: JSON.stringify(a.envVars || []),
      customCliArgs: a.customCliArgs || '',
      reasoningEffort: a.reasoningEffort ?? null,
      concurrencyLimit: a.concurrencyLimit ?? 2,
      // The column is nullable and the field optional, but better-sqlite3 needs
      // every named parameter bound, so the absence has to be explicit.
      allowedUsers: a.allowedUsers ?? null,
      templateKey: a.templateKey ?? null,
      templateVersion: a.templateVersion ?? null,
      phase: a.phase ?? null,
      isSeeded: a.isSeeded ? 1 : 0,
      createdAt: a.createdAt || new Date().toISOString()
    });

    // Project the new agent to its persona file. Hooked here rather than in the
    // controller so that seeding (defaultAgents.forEach(createAgent)) produces
    // files too, and so no future caller can create an agent without one.
    // 'replace' because there is no prior body to protect on a create.
    syncAgentFile(a, 'replace');
    ensureMemoryScaffold({ agentId: a.id });

    return a;
  }

  updateAgent(id: string, updates: Partial<Agent>): Agent | null {
    const existing = this.getAgents().find(a => a.id === id);
    if (!existing) return null;

    /**
     * Database row, then the persona file, then what is actually being changed.
     *
     * The file layer has to sit in the middle or this method destroys it. The
     * projection below rewrites the file's frontmatter from `merged`, and
     * `existing` is the raw database row — so editing any one field in the UI
     * used to rewrite EVERY frontmatter key from a stale column. An agent whose
     * file said `model: claude-opus-5` would silently drop back to whatever the
     * database still held, purely because someone renamed it.
     *
     * Layered this way the file keeps what it declares, and an explicit update
     * still wins — which is what makes editing in the UI write through to the
     * file rather than fight with it.
     */
    let overlay: Partial<Agent> = {};
    try {
      overlay = readAgentFile(id) ?? {};
    } catch {
      // A broken persona file must not block an update to the row.
    }

    const merged = { ...existing, ...overlay, ...updates };
    const sharedKey = this.db.prepare('SELECT shared_key FROM agents WHERE id = ? AND workspace_id = ?')
      .get(id, this.workspaceId()) as { shared_key: string | null } | undefined;
    const stmt = this.db.prepare(`
      UPDATE agents SET
        name = @name, role = @role, avatar = @avatar, color = @color, description = @description,
        model_provider = @modelProvider, model_name = @modelName, reasoning_effort = @reasoningEffort, system_prompt = @systemPrompt,
        autonomy_level = @autonomyLevel, temperature = @temperature, skills = @skills,
        mcp_servers = @mcpServers, custom_cli_args = @customCliArgs, env_vars = @envVars,
        concurrency_limit = @concurrencyLimit, is_archived = @isArchived,
        allowed_users = @allowedUsers
      WHERE id = @id AND workspace_id = @workspaceId
    `);
    stmt.run({
      ...merged,
      workspaceId: this.workspaceId(),
      isArchived: merged.isArchived ? 1 : 0,
      allowedUsers: merged.allowedUsers ?? null,
      reasoningEffort: merged.reasoningEffort ?? null,
      skills: JSON.stringify(merged.skills || []),
      mcpServers: JSON.stringify(merged.mcpServers || []),
      envVars: JSON.stringify(merged.envVars || [])
    });

    if (sharedKey?.shared_key) {
      this.db.prepare(`
        UPDATE agents SET
          name = @name, role = @role, avatar = @avatar, color = @color, description = @description,
          model_provider = @modelProvider, model_name = @modelName, reasoning_effort = @reasoningEffort,
          system_prompt = @systemPrompt, autonomy_level = @autonomyLevel, temperature = @temperature,
          skills = @skills, concurrency_limit = @concurrencyLimit, is_archived = @isArchived,
          allowed_users = @allowedUsers
        WHERE shared_key = @sharedKey
      `).run({
        ...merged,
        sharedKey: sharedKey.shared_key,
        isArchived: merged.isArchived ? 1 : 0,
        allowedUsers: merged.allowedUsers ?? null,
        reasoningEffort: merged.reasoningEffort ?? null,
        skills: JSON.stringify(merged.skills || [])
      });

      const copies = this.db.prepare('SELECT id FROM agents WHERE shared_key = ? AND id <> ?')
        .all(sharedKey.shared_key, id) as Array<{ id: string }>;
      for (const copy of copies) {
        syncAgentFile({ ...merged, id: copy.id }, 'systemPrompt' in updates ? 'replace' : 'preserve');
      }
    }

    /**
     * Refresh the persona file's frontmatter, but keep its body unless this
     * update actually changed the system prompt.
     *
     * Without that distinction, renaming an agent in the UI would overwrite a
     * hand-written persona with whatever one-liner is still in the column —
     * which would make the file layer unusable for its main purpose.
     */
    syncAgentFile(merged, 'systemPrompt' in updates ? 'replace' : 'preserve');

    /**
     * Re-read rather than return `merged`.
     *
     * `merged` is built from `existing`, which was read before the write, so its
     * derived fields still describe the old row. Archiving an agent returned
     * `status: 'idle'` while the very next GET said `'offline'` — harmless while
     * the client ignored the response, and wrong the moment it started
     * reconciling against it.
     *
     * Falls back to `merged` only if the row somehow disappeared between the
     * write and the read, which would mean a concurrent delete.
     */
    return this.getAgents().find(a => a.id === id) ?? merged;
  }

  deleteAgent(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM agents WHERE id = ? AND workspace_id = ?');
    const res = stmt.run(id, this.workspaceId());

    // Only when a row really went away, so a delete of an unknown id does not
    // remove a file that some other agent might still be using.
    if (res.changes > 0) deleteAgentFile(id);

    return res.changes > 0;
  }

  // --- Issues ---
  getIssues(): Issue[] {
    const workspaceId = this.workspaceId();
    const rows = this.db.prepare('SELECT * FROM issues WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as any[];
    const comments = this.db.prepare(`
      SELECT c.* FROM issue_comments c
      JOIN issues i ON i.id = c.issue_id
      WHERE i.workspace_id = ?
      ORDER BY c.created_at ASC
    `).all(workspaceId) as any[];

    const commentsByIssue = new Map<string, IssueComment[]>();
    comments.forEach(c => {
      const list = commentsByIssue.get(c.issue_id) || [];
      list.push({
        id: c.id,
        issueId: c.issue_id,
        authorType: c.author_type,
        authorName: c.author_name,
        authorAvatar: c.author_avatar,
        agentId: c.agent_id,
        content: c.content,
        isThinking: Boolean(c.is_thinking),
        githubId: c.github_id ?? undefined,
        createdAt: c.created_at
      });
      commentsByIssue.set(c.issue_id, list);
    });

    return rows.map(r => ({
      id: r.id,
      identifier: r.identifier,
      title: r.title,
      description: r.description || '',
      status: r.status,
      priority: r.priority,
      projectId: r.project_id,
      // `?? undefined` rather than the raw NULL: `Issue` declares these
      // optional, and a null reaching the API is a field the cloud store
      // reports as absent and this one reported as present-and-empty.
      assignedAgentId: r.assigned_agent_id ?? undefined,
      assignedSquadId: r.assigned_squad_id ?? undefined,
      createdBy: r.created_by ?? undefined,
      githubRepo: r.github_repo ?? undefined,
      githubNumber: r.github_number ?? undefined,
      githubUrl: r.github_url ?? undefined,
      assignedHuman: r.assigned_human ?? undefined,
      labels: JSON.parse(r.labels || '[]'),
      subtasks: JSON.parse(r.subtasks || '[]'),
      branchName: r.branch_name ?? undefined,
      prUrl: r.pr_url ?? undefined,
      comments: commentsByIssue.get(r.id) || [],
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  /**
   * The next free `KEY-nnn` for a project.
   *
   * Derived from the rows that exist rather than a counter, so it stays correct
   * after a deletion and needs no extra state. Starts at 101 to match the
   * seeded issues, which is also why it reads as a number rather than an index.
   */
  private nextIssueIdentifier(projectId: string): string {
    const project = this.getProjects().find(p => p.id === projectId);
    const key = (project?.key || 'ISS').toUpperCase();

    const used = this.db
      .prepare('SELECT identifier FROM issues WHERE project_id = ? AND workspace_id = ?')
      .all(projectId, this.workspaceId()) as { identifier: string }[];

    const highest = used.reduce((max, r) => {
      const n = Number(String(r.identifier).split('-').pop());
      return Number.isFinite(n) && n > max ? n : max;
    }, 100);

    return `${key}-${highest + 1}`;
  }

  /**
   * Create an issue, defaulting everything the caller did not supply.
   *
   * Same defect as `createProject`: `id` and `identifier` were bound but never
   * defaulted, so a payload without them threw `RangeError: Missing named
   * parameter` and Express returned a 500 HTML page. Only the browser worked,
   * because `AppContext` builds both before posting — which also meant the
   * identifier sequence lived in the client, where a second client would have
   * happily reused a number.
   */
  createIssue(issue: Partial<Issue>): Issue {
    const now = new Date().toISOString();
    const projects = this.getProjects();
    const projectId = projects.some(project => project.id === issue.projectId)
      ? issue.projectId as string
      : projects[0]?.id || '';
    const squadId = issue.assignedSquadId && this.getSquads().some(squad => squad.id === issue.assignedSquadId)
      ? issue.assignedSquadId
      : undefined;
    const agentId = !squadId && issue.assignedAgentId && this.getAgents().some(agent => agent.id === issue.assignedAgentId)
      ? issue.assignedAgentId
      : undefined;

    const complete: Issue = {
      ...issue,
      // Random as well as timed: two cards made in the same millisecond -- a
      // sync pass, a test -- had the same id, and the second insert failed.
      id: issue.id || `issue-${Date.now()}-${randomUUID().slice(0, 8)}`,
      identifier: issue.identifier || this.nextIssueIdentifier(projectId),
      title: issue.title || 'Untitled Issue',
      description: issue.description ?? '',
      status: issue.status || 'todo',
      priority: issue.priority || 'medium',
      projectId,
      assignedAgentId: agentId,
      assignedSquadId: squadId,
      labels: issue.labels || [],
      subtasks: issue.subtasks || [],
      comments: issue.comments || [],
      createdAt: issue.createdAt || now,
      updatedAt: issue.updatedAt || now
    } as Issue;

    const stmt = this.db.prepare(`
      INSERT INTO issues (id, workspace_id, identifier, title, description, status, priority, project_id, assigned_agent_id, assigned_squad_id, assigned_human, labels, subtasks, branch_name, pr_url, created_by, github_repo, github_number, github_url, created_at, updated_at)
      VALUES (@id, @workspaceId, @identifier, @title, @description, @status, @priority, @projectId, @assignedAgentId, @assignedSquadId, @assignedHuman, @labels, @subtasks, @branchName, @prUrl, @createdBy, @githubRepo, @githubNumber, @githubUrl, @createdAt, @updatedAt)
    `);
    stmt.run({
      ...complete,
      workspaceId: this.workspaceId(),
      labels: JSON.stringify(complete.labels),
      subtasks: JSON.stringify(complete.subtasks),
      assignedAgentId: complete.assignedAgentId || null,
      assignedSquadId: complete.assignedSquadId || null,
      assignedHuman: complete.assignedHuman || null,
      branchName: complete.branchName || null,
      prUrl: complete.prUrl || null,
      createdBy: complete.createdBy || null,
      githubRepo: complete.githubRepo || null,
      githubNumber: complete.githubNumber ?? null,
      githubUrl: complete.githubUrl || null
    });

    /**
     * Comments arrive from a caller that has no issue id to give them.
     *
     * `addIssueComment` binds `@issueId`, and a client composing a comment for
     * an issue it is in the middle of creating cannot know one. The bind threw
     * `RangeError: Missing named parameter "issueId"` — after the issue row was
     * already written. So the issue existed, the request answered 500, and the
     * browser reported "Issue not saved" about an issue that was saved.
     *
     * Filled in here rather than demanded of the caller: this method is the
     * first moment the id exists.
     */
    for (const c of complete.comments) {
      this.addIssueComment({ ...c, issueId: complete.id });
    }

    return complete;
  }

  updateIssue(id: string, updates: Partial<Issue>): Issue | null {
    const existing = this.getIssues().find(i => i.id === id);
    if (!existing) return null;
    const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    if (updates.projectId && !this.getProjects().some(project => project.id === updates.projectId)) {
      merged.projectId = existing.projectId;
    }
    if (updates.assignedAgentId && !this.getAgents().some(agent => agent.id === updates.assignedAgentId)) {
      merged.assignedAgentId = undefined;
    }
    if (updates.assignedSquadId && !this.getSquads().some(squad => squad.id === updates.assignedSquadId)) {
      merged.assignedSquadId = undefined;
    }
    // An issue has one execution owner. A squad wins when a legacy caller
    // sends both fields; ordinary agent/squad edits clear the other owner.
    if (merged.assignedAgentId && merged.assignedSquadId) {
      if (updates.assignedSquadId) merged.assignedAgentId = undefined;
      else merged.assignedSquadId = undefined;
    }
    const stmt = this.db.prepare(`
      UPDATE issues SET
        title = @title, description = @description, status = @status, priority = @priority,
        project_id = @projectId, assigned_agent_id = @assignedAgentId,
        assigned_squad_id = @assignedSquadId, assigned_human = @assignedHuman,
        labels = @labels, subtasks = @subtasks, branch_name = @branchName, pr_url = @prUrl,
        github_repo = @githubRepo, github_number = @githubNumber, github_url = @githubUrl,
        updated_at = @updatedAt
      WHERE id = @id AND workspace_id = @workspaceId
    `);
    stmt.run({
      ...merged,
      workspaceId: this.workspaceId(),
      assignedSquadId: merged.assignedSquadId || null,
      githubRepo: merged.githubRepo || null,
      githubNumber: merged.githubNumber ?? null,
      githubUrl: merged.githubUrl || null,
      labels: JSON.stringify(merged.labels || []),
      subtasks: JSON.stringify(merged.subtasks || [])
    });
    return merged;
  }

  deleteIssue(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM issues WHERE id = ? AND workspace_id = ?');
    const res = stmt.run(id, this.workspaceId());
    return res.changes > 0;
  }

  addIssueComment(c: IssueComment): IssueComment {
    if (!this.getIssues().some(issue => issue.id === c.issueId)) return c;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO issue_comments (id, issue_id, author_type, author_name, author_avatar, agent_id, content, is_thinking, github_id, created_at)
      VALUES (@id, @issueId, @authorType, @authorName, @authorAvatar, @agentId, @content, @isThinking, @githubId, @createdAt)
    `);
    stmt.run({
      ...c,
      authorAvatar: c.authorAvatar || null,
      agentId: c.agentId || null,
      isThinking: c.isThinking ? 1 : 0,
      githubId: c.githubId ?? null,
      createdAt: c.createdAt || new Date().toISOString()
    });
    return c;
  }

  // --- Prototype Runs ---
  getPrototypeRuns(): PrototypeRun[] {
    const rows = this.db.prepare('SELECT * FROM prototype_runs WHERE workspace_id = ? ORDER BY created_at DESC').all(this.workspaceId()) as any[];
    return rows.map(r => ({
      id: r.id,
      workspaceId: r.workspace_id,
      issueId: r.issue_id,
      projectId: r.project_id,
      agentId: r.agent_id,
      status: r.status,
      scenario: r.scenario,
      plan: JSON.parse(r.plan || '[]'),
      currentStageIndex: r.current_stage_index,
      stages: JSON.parse(r.stages || '[]'),
      activities: JSON.parse(r.activities || '[]'),
      branchName: r.branch_name,
      checkpointCommit: r.checkpoint_commit ?? undefined,
      prUrl: r.pr_url,
      changedFiles: r.changed_files,
      insertions: r.insertions,
      deletions: r.deletions,
      testSummary: r.test_summary,
      verificationEvidence: parseJson(r.verification_evidence, undefined),
      usage: usageFromRow(r),
      squadRunId: r.squad_run_id ?? undefined,
      squadOrder: r.squad_order ?? undefined,
      orchestrationRunId: r.orchestration_run_id ?? undefined,
      orchestrationTaskId: r.orchestration_task_id ?? undefined,
      orchestrationAttemptId: r.orchestration_attempt_id ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  /**
   * Aggregate the run records that actually exist on this machine.
   *
   * Analytics used to be a frontend seed object, so a fresh install showed
   * millions of tokens and a 98.4% success rate before a single run happened.
   * Keep the aggregation here beside the persisted usage columns: missing CLI
   * telemetry stays unmeasured, while run counts and statuses remain useful.
   */
  getAnalytics(now = new Date()): AnalyticsData {
    return analyticsFrom(this.getPrototypeRuns(), this.getAgents(), now);
  }

  savePrototypeRun(run: PrototypeRun): PrototypeRun {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO prototype_runs (id, workspace_id, issue_id, project_id, agent_id, status, scenario, plan, current_stage_index, stages, branch_name, checkpoint_commit, pr_url, changed_files, insertions, deletions, test_summary, verification_evidence, activities, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, cost_usd, num_turns, squad_run_id, squad_order, orchestration_run_id, orchestration_task_id, orchestration_attempt_id, created_at, updated_at)
      VALUES (@id, @workspaceId, @issueId, @projectId, @agentId, @status, @scenario, @plan, @currentStageIndex, @stages, @branchName, @checkpointCommit, @prUrl, @changedFiles, @insertions, @deletions, @testSummary, @verificationEvidence, @activities, @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreationTokens, @thinkingTokens, @costUsd, @numTurns, @squadRunId, @squadOrder, @orchestrationRunId, @orchestrationTaskId, @orchestrationAttemptId, @createdAt, @updatedAt)
    `);
    stmt.run({
      id: run.id,
      workspaceId: this.workspaceId(),
      issueId: run.issueId,
      projectId: run.projectId,
      agentId: run.agentId,
      status: run.status,
      scenario: run.scenario || 'success',
      plan: JSON.stringify(run.plan || []),
      currentStageIndex: run.currentStageIndex,
      stages: JSON.stringify(run.stages || []),
      branchName: run.branchName || null,
      checkpointCommit: run.checkpointCommit ?? null,
      prUrl: run.prUrl || null,
      changedFiles: run.changedFiles || 0,
      insertions: run.insertions || 0,
      deletions: run.deletions || 0,
      testSummary: run.testSummary || null,
      verificationEvidence: run.verificationEvidence ? JSON.stringify(run.verificationEvidence) : null,
      activities: JSON.stringify(run.activities || []),
      /**
       * `?? null`, never `|| 0`. A reported zero has to survive the round trip
       * as a zero, and an unreported figure has to stay NULL — the whole point
       * of the nullable columns. `||` would collapse both into 0.
       */
      inputTokens: run.usage?.inputTokens ?? null,
      outputTokens: run.usage?.outputTokens ?? null,
      cacheReadTokens: run.usage?.cacheReadTokens ?? null,
      cacheCreationTokens: run.usage?.cacheCreationTokens ?? null,
      thinkingTokens: run.usage?.thinkingTokens ?? null,
      costUsd: run.usage?.costUsd ?? null,
      numTurns: run.usage?.numTurns ?? null,
      squadRunId: run.squadRunId ?? null,
      squadOrder: run.squadOrder ?? null,
      orchestrationRunId: run.orchestrationRunId ?? null,
      orchestrationTaskId: run.orchestrationTaskId ?? null,
      orchestrationAttemptId: run.orchestrationAttemptId ?? null,
      createdAt: run.createdAt || new Date().toISOString(),
      updatedAt: run.updatedAt || new Date().toISOString()
    });
    return run;
  }

  // --- Squad Runs ---

  /**
   * A squad's turn-by-turn execution over one issue.
   *
   * Kept separate from `squads` because a squad is a reusable roster while a
   * squad run is one attempt at one issue. The member list is copied onto the
   * run so that editing the squad afterwards cannot rewrite the history of a
   * run that already happened.
   */
  getSquadRuns(): SquadRun[] {
    const rows = this.db.prepare('SELECT * FROM squad_runs WHERE workspace_id = ? ORDER BY created_at DESC').all(this.workspaceId()) as any[];
    return rows.map(squadRunFromRow);
  }

  private appendOrchestrationEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    actorId?: string,
    createdAt = new Date().toISOString()
  ): void {
    const workspaceId = this.workspaceId();
    const sequence = (this.db.prepare('SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next FROM orchestration_events WHERE workspace_id = ? AND run_id = ?').get(workspaceId, runId) as any).next as number;
    const eventId = randomUUID();
    const serialized = JSON.stringify(payload);
    this.db.prepare('INSERT INTO orchestration_events (event_id, workspace_id, run_id, run_sequence, actor_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(eventId, workspaceId, runId, sequence, actorId ?? null, eventType, serialized, createdAt);
    this.db.prepare('INSERT INTO orchestration_outbox (workspace_id, run_id, event_id, payload_json, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(workspaceId, runId, eventId, serialized, createdAt, createdAt);
  }

  createOrchestrationSnapshot(
    run: OrchestrationRunRecord,
    tasks: readonly OrchestrationTaskRecord[],
    planSource: 'template' | 'model' | 'manual' = 'template',
    expectedPlanningOwnerSessionId?: string
  ): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    if (run.workspaceId !== workspaceId) throw new Error('The orchestration run belongs to a different workspace.');
    if (tasks.length !== run.plan.tasks.length || tasks.some(task => !run.plan.tasks.some(definition => definition.id === task.id))) {
      throw new Error('The task records do not match the activated plan.');
    }
    if (run.status !== 'planning' || run.revision !== 0 || run.planVersion !== 1) {
      throw new Error('A new orchestration must start at plan version 1 in planning state.');
    }
    for (const workspace of run.repositoryWorkspaces ?? []) {
      if (!workspace.repository.trim() || !/^[A-Za-z0-9._/-]{1,200}$/.test(workspace.branchName) ||
          !/^[a-f0-9]{40,64}$/i.test(workspace.baseCommit) || !path.isAbsolute(workspace.worktreePath) ||
          !this.isPathAllowed(workspace.worktreePath)) {
        throw new Error('A selected codebase workspace is incomplete or outside Alpha’s approved project folder.');
      }
    }

    const create = this.db.transaction(() => {
      if (expectedPlanningOwnerSessionId !== undefined) {
        const reservation = this.db.prepare(`SELECT request_fingerprint, owner_session_id
          FROM orchestration_planning_reservations WHERE workspace_id = ? AND request_key = ?`)
          .get(workspaceId, run.requestKey) as { request_fingerprint: string; owner_session_id: string | null } | undefined;
        if (!reservation || reservation.request_fingerprint !== run.requestFingerprint ||
            reservation.owner_session_id !== expectedPlanningOwnerSessionId) {
          throw new Error('The planning reservation is no longer owned by this Alpha session. Reconcile it before activating the plan.');
        }
      }
      const { plan: _plan, ...runRow } = run;
      this.db.prepare('INSERT INTO orchestration_runs (id, workspace_id, project_id, issue_id, origin_chat_thread_id, origin_build_message_id, repository, request_key, request_fingerprint, created_by, executor_id, ownership_epoch, workflow_version, plan_version, status, revision, current_task_id, pause_requested_at, pause_requested_by, stopped_reason, branch_name, base_ref, base_commit, worktree_path, repository_workspaces_json, created_at, updated_at) VALUES (@id, @workspaceId, @projectId, @issueId, @originChatThreadId, @originBuildMessageId, @repository, @requestKey, @requestFingerprint, @createdBy, @executorId, @ownershipEpoch, @workflowVersion, @planVersion, @status, @revision, @currentTaskId, @pauseRequestedAt, @pauseRequestedBy, @stoppedReason, @branchName, @baseRef, @baseCommit, @worktreePath, @repositoryWorkspacesJson, @createdAt, @updatedAt)')
        .run({ ...runRow, workspaceId,
          originChatThreadId: run.originChatThreadId ?? null,
          originBuildMessageId: run.originBuildMessageId ?? null,
          currentTaskId: run.currentTaskId ?? null,
          pauseRequestedAt: run.pauseRequestedAt ?? null, pauseRequestedBy: run.pauseRequestedBy ?? null,
          stoppedReason: run.stoppedReason ?? null,
          branchName: run.branchName ?? null, baseRef: run.baseRef ?? null, baseCommit: run.baseCommit ?? null, worktreePath: run.worktreePath ?? null,
          repositoryWorkspacesJson: JSON.stringify(run.repositoryWorkspaces ?? []) });
      this.db.prepare('INSERT INTO orchestration_plans (workspace_id, run_id, version, schema_version, plan_json, source, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(workspaceId, run.id, run.planVersion, run.plan.schemaVersion, JSON.stringify(run.plan), planSource, run.createdAt, run.createdAt);

      const insertTask = this.db.prepare('INSERT INTO orchestration_tasks (workspace_id, run_id, plan_version, task_id, title, description, kind, owner_agent_id, depends_on_json, requirement_ids_json, acceptance_json, checks_json, scope_json, required, status, revision, attempt_count, accepted_revision, correction_of_task_id, correction_cycle, updated_at) VALUES (@workspaceId, @runId, @planVersion, @taskId, @title, @description, @kind, @ownerAgentId, @dependsOn, @requirementIds, @acceptance, @checks, @scope, @required, @status, @revision, @attemptCount, @acceptedRevision, @correctionOfTaskId, @correctionCycle, @updatedAt)');
      for (const task of tasks) {
        insertTask.run({
          workspaceId,
          runId: run.id,
          planVersion: run.planVersion,
          taskId: task.id,
          title: task.title,
          description: task.description,
          kind: task.kind,
          ownerAgentId: task.ownerAgentId,
          dependsOn: JSON.stringify(task.dependsOn),
          requirementIds: JSON.stringify(task.requirementIds),
          acceptance: JSON.stringify(task.acceptanceCriteria),
          checks: JSON.stringify(task.requiredChecks),
          scope: JSON.stringify(task.scope),
          required: task.required ? 1 : 0,
          status: task.status,
          revision: task.revision,
          attemptCount: task.attemptCount,
          acceptedRevision: task.acceptedRevision ?? null,
          correctionOfTaskId: task.correctionOfTaskId ?? null,
          correctionCycle: task.correctionCycle ?? null,
          updatedAt: task.updatedAt ?? run.createdAt
        });
      }
      this.appendOrchestrationEvent(run.id, 'plan_activated', {
        planVersion: run.planVersion,
        taskCount: tasks.length,
        goal: run.plan.goal
      }, run.createdBy, run.createdAt);
      const released = expectedPlanningOwnerSessionId === undefined
        ? this.db.prepare('DELETE FROM orchestration_planning_reservations WHERE workspace_id = ? AND request_key = ? AND request_fingerprint = ?')
          .run(workspaceId, run.requestKey, run.requestFingerprint)
        : this.db.prepare(`DELETE FROM orchestration_planning_reservations
          WHERE workspace_id = ? AND request_key = ? AND request_fingerprint = ? AND owner_session_id = ?`)
          .run(workspaceId, run.requestKey, run.requestFingerprint, expectedPlanningOwnerSessionId);
      if (expectedPlanningOwnerSessionId !== undefined && released.changes !== 1) {
        throw new Error('The planning reservation changed before the plan could be activated.');
      }
    });
    create();
    return this.getOrchestrationSnapshot(run.id)!;
  }

  bindOrchestrationWorkspace(input: {
    runId: string;
    repository?: string;
    branchName: string;
    baseRef: string;
    baseCommit: string;
    worktreePath: string;
    actorId?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    if (!/^[a-f0-9]{40,64}$/i.test(input.baseCommit)) throw new Error('The orchestration base commit is invalid.');
    if (!path.isAbsolute(input.worktreePath) || !this.isPathAllowed(input.worktreePath)) {
      throw new Error('The orchestration worktree is outside the approved local workspace.');
    }
    const bind = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (!['executing', 'blocked'].includes(snapshot.run.status)) throw new Error(`Cannot bind a worktree while the build is ${snapshot.run.status}.`);
      const run = snapshot.run;
      if (input.repository && run.repositoryWorkspaces?.length) {
        const authorized = run.repositoryWorkspaces.find(item => canonicalOrchestrationRepository(item.repository) === canonicalOrchestrationRepository(input.repository!));
        if (!authorized || authorized.branchName !== input.branchName || authorized.baseRef !== input.baseRef ||
            authorized.baseCommit !== input.baseCommit || path.resolve(authorized.worktreePath) !== path.resolve(input.worktreePath)) {
          throw new Error('The task workspace differs from the private branch assigned to its selected codebase.');
        }
        return;
      }
      if ((run.branchName && run.branchName !== input.branchName) ||
          (run.baseRef && run.baseRef !== input.baseRef) ||
          (run.worktreePath && path.resolve(run.worktreePath) !== path.resolve(input.worktreePath))) {
        throw new Error('The orchestration run is already bound to a different branch, base, or worktree.');
      }
      if (run.branchName && run.baseCommit && run.worktreePath) return;
      const result = this.db.prepare('UPDATE orchestration_runs SET branch_name = ?, base_ref = ?, base_commit = COALESCE(base_commit, ?), worktree_path = ?, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND revision = ?')
        .run(input.branchName, input.baseRef, input.baseCommit, input.worktreePath, now, workspaceId, input.runId, run.revision);
      if (result.changes !== 1) throw new Error('Build changed before its worktree could be bound.');
      this.appendOrchestrationEvent(input.runId, 'workspace_prepared', {
        branchName: input.branchName,
        baseRef: input.baseRef,
        baseCommit: run.baseCommit ?? input.baseCommit
      }, input.actorId, now);
    });
    bind();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  getOrchestrationSnapshot(runId: string): OrchestrationSnapshot | undefined {
    const workspaceId = this.workspaceId();
    const row = this.db.prepare('SELECT * FROM orchestration_runs WHERE workspace_id = ? AND id = ?').get(workspaceId, runId) as any;
    if (!row) return undefined;
    const planRow = this.db.prepare('SELECT plan_json FROM orchestration_plans WHERE workspace_id = ? AND run_id = ? AND version = ?')
      .get(workspaceId, runId, row.plan_version) as any;
    if (!planRow) throw new Error('The orchestration plan version is missing.');
    const plan = JSON.parse(planRow.plan_json) as OrchestrationPlan;
    const tasks = this.db.prepare('SELECT * FROM orchestration_tasks WHERE workspace_id = ? AND run_id = ? AND plan_version = ? ORDER BY rowid')
      .all(workspaceId, runId, row.plan_version) as any[];
    const attempts = this.db.prepare('SELECT * FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? ORDER BY created_at, attempt_number')
      .all(workspaceId, runId) as any[];
    const artifacts = this.db.prepare('SELECT * FROM orchestration_artifacts WHERE workspace_id = ? AND run_id = ? ORDER BY created_at, id')
      .all(workspaceId, runId) as any[];
    const findings = this.db.prepare('SELECT * FROM orchestration_findings WHERE workspace_id = ? AND run_id = ? ORDER BY created_at, id')
      .all(workspaceId, runId) as any[];
    const completedEvent = this.db.prepare(`SELECT payload_json FROM orchestration_events
      WHERE workspace_id = ? AND run_id = ? AND event_type = 'run_completed'
      ORDER BY run_sequence DESC LIMIT 1`).get(workspaceId, runId) as { payload_json: string } | undefined;
    const completionPayload = parseJson<{ evidence?: Record<string, unknown> }>(completedEvent?.payload_json, {});
    const completionEvidence = completionPayload.evidence?.decision === 'approved' ? completionPayload.evidence : undefined;
    const publication = completionEvidence?.publication as Record<string, unknown> | undefined;
    const publications = Array.isArray(completionEvidence?.publications)
      ? completionEvidence!.publications as Array<Record<string, unknown>>
      : publication ? [publication] : [];
    const run = orchestrationRunFromRow(row, plan);
    const expectedWorkspaces = run.repositoryWorkspaces?.length ? run.repositoryWorkspaces : [{
      repository: run.repository, branchName: run.branchName ?? '', baseRef: run.baseRef ?? '',
      baseCommit: run.baseCommit ?? '', worktreePath: run.worktreePath ?? ''
    }];
    const validation = this.db.prepare(`SELECT payload_json FROM orchestration_events
      WHERE workspace_id = ? AND run_id = ? AND event_type = 'run_awaiting_approval'
      ORDER BY run_sequence DESC LIMIT 1`).get(workspaceId, runId) as { payload_json: string } | undefined;
    const validationEvidence = parseJson<{ evidence?: Record<string, unknown> }>(validation?.payload_json, {}).evidence;
    const validatedRepositories = Array.isArray(validationEvidence?.repositories)
      ? validationEvidence!.repositories as Array<Record<string, unknown>> : [];
    const validPublications = publications.filter(item => {
      const repo = typeof item.repository === 'string' ? item.repository : run.repository;
      const workspace = expectedWorkspaces.find(candidate => canonicalOrchestrationRepository(candidate.repository).toLowerCase() ===
        canonicalOrchestrationRepository(repo).toLowerCase());
      const validated = validatedRepositories.find(candidate => typeof candidate.repository === 'string' &&
        canonicalOrchestrationRepository(candidate.repository).toLowerCase() === canonicalOrchestrationRepository(repo).toLowerCase());
      const resultCommit = typeof validated?.resultCommit === 'string' ? validated.resultCommit
        : repo.toLowerCase() === run.repository.toLowerCase() ? validationEvidence?.resultCommit : undefined;
      const branchName = typeof validated?.branchName === 'string' ? validated.branchName
        : repo.toLowerCase() === run.repository.toLowerCase() ? validationEvidence?.branchName : undefined;
      const pullUrl = typeof item.pullRequestUrl === 'string' ? item.pullRequestUrl.toLowerCase() : '';
      const expectedPullPrefix = `https://github.com/${canonicalOrchestrationRepository(repo).toLowerCase()}/pull/`;
      const pullNumber = pullUrl.startsWith(expectedPullPrefix) ? pullUrl.slice(expectedPullPrefix.length) : '';
      return Boolean(workspace && isSafeOrchestrationBranchName(item.branchName) &&
        item.branchName === workspace.branchName && item.baseBranch !== item.branchName &&
        isSafeOrchestrationBranchName(item.baseBranch) && typeof resultCommit === 'string' &&
        /^[a-f0-9]{40,64}$/i.test(resultCommit) && item.resultCommit === resultCommit && item.branchName === branchName &&
        /^\d+$/.test(pullNumber) && typeof item.publishedAt === 'string' && Number.isFinite(Date.parse(item.publishedAt)));
    });
    const publishedRepositoryKeys = validPublications.map(item => typeof item.repository === 'string'
      ? canonicalOrchestrationRepository(item.repository) : canonicalOrchestrationRepository(run.repository));
    const allRepositoriesCovered = expectedWorkspaces.every(workspace =>
      publishedRepositoryKeys.includes(canonicalOrchestrationRepository(workspace.repository)));
    if (publications.length === expectedWorkspaces.length && validPublications.length === expectedWorkspaces.length &&
        new Set(publishedRepositoryKeys).size === expectedWorkspaces.length && allRepositoriesCovered) {
      const toRecord = (item: Record<string, unknown>) => ({
        repository: typeof item.repository === 'string' ? item.repository : run.repository,
        branchName: item.branchName as string,
        baseBranch: item.baseBranch as string,
        resultCommit: item.resultCommit as string,
        pullRequestUrl: item.pullRequestUrl as string,
        publishedAt: item.publishedAt as string
      });
      run.publications = validPublications.map(toRecord);
      run.publication = run.publications.find(item => item.repository?.toLowerCase() === run.repository.toLowerCase()) ?? run.publications[0];
    }
    return {
      run,
      tasks: tasks.map(row => orchestrationTaskFromRow(row, plan.tasks.find(task => task.id === row.task_id))),
      attempts: attempts.map(orchestrationAttemptFromRow),
      artifacts: artifacts.map(orchestrationArtifactFromRow),
      findings: findings.map(orchestrationFindingFromRow)
    };
  }

  bindOrchestrationChat(input: {
    runId: string;
    threadId: string;
    buildMessageId: string;
    actorId: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const bind = this.db.transaction(() => {
      const run = this.db.prepare(`SELECT project_id, created_by, origin_chat_thread_id, origin_build_message_id, revision
        FROM orchestration_runs WHERE workspace_id = ? AND id = ?`).get(workspaceId, input.runId) as any;
      if (!run) throw new Error('Orchestration run not found.');
      if (run.created_by !== input.actorId) throw new Error('Only the build owner can bind its recovery conversation.');
      const thread = this.db.prepare(`SELECT project_id, owner_id FROM chat_threads WHERE workspace_id = ? AND id = ?`)
        .get(workspaceId, input.threadId) as any;
      if (!thread || thread.project_id !== run.project_id || thread.owner_id !== input.actorId) {
        throw new Error('The build conversation is not owned by the initiating project member.');
      }
      const message = this.db.prepare(`SELECT thread_id, message_type, orchestration_run_id FROM chat_messages
        WHERE thread_id = ? AND id = ?`).get(input.threadId, input.buildMessageId) as any;
      if (!message || message.thread_id !== input.threadId || message.message_type !== 'build' || message.orchestration_run_id !== input.runId) {
        throw new Error('The build message does not identify this orchestration run.');
      }
      if ((run.origin_chat_thread_id && run.origin_chat_thread_id !== input.threadId) ||
          (run.origin_build_message_id && run.origin_build_message_id !== input.buildMessageId)) {
        throw new Error('This build is already bound to another chat message.');
      }
      if (run.origin_chat_thread_id === input.threadId && run.origin_build_message_id === input.buildMessageId) return;
      const updated = this.db.prepare(`UPDATE orchestration_runs SET origin_chat_thread_id = ?, origin_build_message_id = ?,
        revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND revision = ?`)
        .run(input.threadId, input.buildMessageId, now, workspaceId, input.runId, run.revision);
      if (updated.changes !== 1) throw new Error('The build changed before its chat conversation could be bound.');
      this.appendOrchestrationEvent(input.runId, 'chat_bound', { threadId: input.threadId, buildMessageId: input.buildMessageId }, input.actorId, now);
    });
    bind();
    const snapshot = this.getOrchestrationSnapshot(input.runId);
    if (!snapshot) throw new Error('The build disappeared after binding its chat conversation.');
    return snapshot;
  }

  getOrchestrationChatBinding(runId: string): { runId: string; projectId: string; threadId: string; buildMessageId: string; ownerId: string } | undefined {
    const workspaceId = this.workspaceId();
    let run = this.db.prepare(`SELECT project_id, created_by, origin_chat_thread_id, origin_build_message_id
      FROM orchestration_runs WHERE workspace_id = ? AND id = ?`).get(workspaceId, runId) as any;
    if (!run) return undefined;
    if (!run.origin_chat_thread_id || !run.origin_build_message_id) {
      const candidates = this.db.prepare(`SELECT m.thread_id, m.id AS message_id, t.owner_id
        FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id AND t.workspace_id = ?
        WHERE m.orchestration_run_id = ? AND m.message_type = 'build' AND t.project_id = ? AND t.owner_id = ?
        ORDER BY m.timestamp ASC LIMIT 2`).all(workspaceId, runId, run.project_id, run.created_by) as any[];
      if (candidates.length !== 1) return undefined;
      const candidate = candidates[0];
      this.db.prepare(`UPDATE orchestration_runs SET origin_chat_thread_id = ?, origin_build_message_id = ?
        WHERE workspace_id = ? AND id = ? AND origin_chat_thread_id IS NULL AND origin_build_message_id IS NULL`)
        .run(candidate.thread_id, candidate.message_id, workspaceId, runId);
      run = this.db.prepare(`SELECT project_id, created_by, origin_chat_thread_id, origin_build_message_id
        FROM orchestration_runs WHERE workspace_id = ? AND id = ?`).get(workspaceId, runId) as any;
    }
    const thread = this.db.prepare('SELECT owner_id FROM chat_threads WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, run.origin_chat_thread_id) as { owner_id: string | null } | undefined;
    if (!thread || !thread.owner_id || thread.owner_id !== run.created_by || !run.origin_build_message_id) return undefined;
    return {
      runId,
      projectId: run.project_id,
      threadId: run.origin_chat_thread_id,
      buildMessageId: run.origin_build_message_id,
      ownerId: thread.owner_id
    };
  }

  /**
   * What one agent did in builds: its attempts, and the independent review
   * findings raised against tasks it owned. Read-only; feeds the scorecard
   * and the lesson suggestions in the Agent Directory.
   */
  getAgentBuildHistory(agentId: string): {
    attempts: Array<{ runId: string; taskId: string; attemptNumber: number; status: string; failureReason?: string; reportRetry: boolean; createdAt: string }>;
    reviewFindings: Array<{ runId: string; taskId: string; severity: string; path?: string; title?: string; instruction?: string; status: string; createdAt: string }>;
  } {
    const workspaceId = this.workspaceId();
    const attempts = (this.db.prepare(`SELECT run_id, task_id, attempt_number, status, failure_reason, context_manifest_json, created_at
      FROM orchestration_attempts WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at`).all(workspaceId, agentId) as any[])
      .map(row => ({
        runId: row.run_id,
        taskId: row.task_id,
        attemptNumber: Number(row.attempt_number),
        status: row.status,
        failureReason: row.failure_reason ?? undefined,
        reportRetry: parseJson<Record<string, unknown>>(row.context_manifest_json, {}).reportOnlyReportRetry === true,
        createdAt: row.created_at
      }));
    const reviewFindings = (this.db.prepare(`SELECT f.run_id, f.task_id, f.severity, f.path, f.evidence, f.status, f.created_at
      FROM orchestration_findings f
      WHERE f.workspace_id = ? AND f.source_task_id <> f.task_id AND EXISTS (
        SELECT 1 FROM orchestration_tasks t
        WHERE t.workspace_id = f.workspace_id AND t.run_id = f.run_id AND t.task_id = f.task_id AND t.owner_agent_id = ?
      ) ORDER BY f.created_at`).all(workspaceId, agentId) as any[])
      .map(row => {
        const evidence = parseJson<Record<string, unknown>>(row.evidence, {});
        return {
          runId: row.run_id,
          taskId: row.task_id,
          severity: row.severity,
          path: row.path ?? undefined,
          title: typeof evidence.title === 'string' ? evidence.title : undefined,
          instruction: typeof evidence.instruction === 'string' ? evidence.instruction : undefined,
          status: row.status,
          createdAt: row.created_at
        };
      });
    return { attempts, reviewFindings };
  }

  getAgentLessonDecisions(agentId: string): Array<{ lessonId: string; status: 'accepted' | 'dismissed'; text: string; decidedBy: string; decidedAt: string }> {
    return (this.db.prepare(`SELECT lesson_id, status, text, decided_by, decided_at FROM agent_lesson_decisions
      WHERE workspace_id = ? AND agent_id = ? ORDER BY decided_at`).all(this.workspaceId(), agentId) as any[])
      .map(row => ({ lessonId: row.lesson_id, status: row.status, text: row.text, decidedBy: row.decided_by, decidedAt: row.decided_at }));
  }

  saveAgentLessonDecision(input: { agentId: string; lessonId: string; status: 'accepted' | 'dismissed'; text: string; decidedBy: string; now?: string }): void {
    this.db.prepare(`INSERT INTO agent_lesson_decisions (workspace_id, agent_id, lesson_id, status, text, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, agent_id, lesson_id) DO UPDATE SET status = excluded.status, text = excluded.text,
        decided_by = excluded.decided_by, decided_at = excluded.decided_at`)
      .run(this.workspaceId(), input.agentId, input.lessonId, input.status, input.text, input.decidedBy, input.now ?? new Date().toISOString());
  }


  listOrchestrationRecoveryEpisodes(runId: string): OrchestrationRecoveryEpisode[] {
    const rows = this.db.prepare(`SELECT * FROM orchestration_recovery_episodes
      WHERE workspace_id = ? AND run_id = ? ORDER BY episode_number ASC, created_at ASC`)
      .all(this.workspaceId(), runId) as any[];
    return rows.map(orchestrationRecoveryEpisodeFromRow);
  }

  getOpenOrchestrationRecoveryEpisode(runId: string): OrchestrationRecoveryEpisode | undefined {
    const row = this.db.prepare(`SELECT * FROM orchestration_recovery_episodes
      WHERE workspace_id = ? AND run_id = ? AND phase IN ('repairing', 'waiting_for_user', 'ready_to_continue')
      ORDER BY created_at DESC LIMIT 1`).get(this.workspaceId(), runId) as any;
    return row ? orchestrationRecoveryEpisodeFromRow(row) : undefined;
  }

  getOrchestrationRecoveryEpisode(runId: string, recoveryId: string): OrchestrationRecoveryEpisode | undefined {
    const row = this.db.prepare(`SELECT * FROM orchestration_recovery_episodes
      WHERE workspace_id = ? AND run_id = ? AND id = ?`).get(this.workspaceId(), runId, recoveryId) as any;
    return row ? orchestrationRecoveryEpisodeFromRow(row) : undefined;
  }

  saveOrchestrationRecoveryEpisode(input: {
    episode: OrchestrationRecoveryEpisode;
    expectedRevision?: number;
    milestone?: { key: string; content: string };
    actorId?: string;
    now?: string;
  }): { episode: OrchestrationRecoveryEpisode; changed: boolean; milestone?: OrchestrationRecoveryMilestone } {
    const workspaceId = this.workspaceId();
    const episode = input.episode;
    if (episode.workspaceId !== workspaceId) throw new Error('Recovery episode belongs to a different workspace.');
    const now = input.now ?? episode.updatedAt ?? new Date().toISOString();
    let saved!: OrchestrationRecoveryEpisode;
    let changed = false;
    let milestone: OrchestrationRecoveryMilestone | undefined;
    const save = this.db.transaction(() => {
      const current = this.db.prepare(`SELECT * FROM orchestration_recovery_episodes
        WHERE workspace_id = ? AND id = ?`).get(workspaceId, episode.id) as any;
      if (current) {
        const currentEpisode = orchestrationRecoveryEpisodeFromRow(current);
        const same = currentEpisode.phase === episode.phase && currentEpisode.taskId === episode.taskId &&
          currentEpisode.attemptId === episode.attemptId && currentEpisode.category === episode.category &&
          currentEpisode.code === episode.code && currentEpisode.summary === episode.summary &&
          currentEpisode.fingerprint === episode.fingerprint && currentEpisode.attemptsUsed === episode.attemptsUsed &&
          currentEpisode.guidance === episode.guidance && JSON.stringify(currentEpisode.evidence) === JSON.stringify(episode.evidence) &&
          currentEpisode.resolvedAt === episode.resolvedAt;
        if (same) {
          saved = currentEpisode;
        } else {
          const expectedRevision = input.expectedRevision ?? currentEpisode.revision;
          if (currentEpisode.revision !== expectedRevision) throw new Error('Recovery changed while this action was open. Refresh the build before continuing.');
          const revision = currentEpisode.revision + 1;
          const updated = this.db.prepare(`UPDATE orchestration_recovery_episodes SET
            task_id = ?, attempt_id = ?, source = ?, category = ?, error_code = ?, summary = ?, fingerprint = ?, phase = ?,
            episode_number = ?, repair_budget = ?, attempts_used = ?, guidance = ?, evidence_json = ?, thread_id = ?,
            build_message_id = ?, initiated_by = ?, revision = ?, updated_at = ?, resolved_at = ?
            WHERE workspace_id = ? AND id = ? AND revision = ?`).run(
            episode.taskId ?? null, episode.attemptId ?? null, episode.source, episode.category, episode.code,
            episode.summary, episode.fingerprint, episode.phase, episode.episodeNumber, episode.repairBudget,
            episode.attemptsUsed, episode.guidance ?? null, JSON.stringify(episode.evidence), episode.threadId ?? null,
            episode.buildMessageId ?? null, episode.initiatedBy, revision, now, episode.resolvedAt ?? null,
            workspaceId, episode.id, expectedRevision
          );
          if (updated.changes !== 1) throw new Error('Recovery changed while this action was being saved. Refresh the build.');
          saved = { ...episode, revision, updatedAt: now };
          changed = true;
          this.appendOrchestrationEvent(episode.runId, `recovery_${episode.phase}`, {
            recoveryId: episode.id, phase: episode.phase, category: episode.category, code: episode.code,
            taskId: episode.taskId, attemptsUsed: episode.attemptsUsed, summary: episode.summary
          }, input.actorId ?? episode.initiatedBy, now);
        }
      } else {
        const open = this.getOpenOrchestrationRecoveryEpisode(episode.runId);
        if (open) throw new Error('Another recovery is already active for this build. Refresh the recovery panel.');
        this.db.prepare(`INSERT INTO orchestration_recovery_episodes (
          id, workspace_id, project_id, run_id, issue_id, task_id, attempt_id, source, category, error_code,
          summary, fingerprint, phase, episode_number, repair_budget, attempts_used, guidance, evidence_json,
          thread_id, build_message_id, initiated_by, revision, created_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          episode.id, workspaceId, episode.projectId, episode.runId, episode.issueId, episode.taskId ?? null,
          episode.attemptId ?? null, episode.source, episode.category, episode.code, episode.summary,
          episode.fingerprint, episode.phase, episode.episodeNumber, episode.repairBudget, episode.attemptsUsed,
          episode.guidance ?? null, JSON.stringify(episode.evidence), episode.threadId ?? null,
          episode.buildMessageId ?? null, episode.initiatedBy, episode.revision, episode.createdAt, now,
          episode.resolvedAt ?? null
        );
        saved = { ...episode, updatedAt: now };
        changed = true;
        this.appendOrchestrationEvent(episode.runId, `recovery_${episode.phase}`, {
          recoveryId: episode.id, phase: episode.phase, category: episode.category, code: episode.code,
          taskId: episode.taskId, attemptsUsed: episode.attemptsUsed, summary: episode.summary
        }, input.actorId ?? episode.initiatedBy, now);
      }
      if (input.milestone && saved.threadId) {
        const milestoneId = `recovery-milestone-${episode.id}-${createHash('sha256').update(input.milestone.key).digest('hex').slice(0, 20)}`;
        const messageId = milestoneId;
        this.db.prepare(`INSERT OR IGNORE INTO orchestration_recovery_milestones
          (id, workspace_id, run_id, recovery_id, milestone_key, thread_id, message_id, content, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          milestoneId, workspaceId, episode.runId, episode.id, input.milestone.key, saved.threadId,
          messageId, input.milestone.content.slice(0, 1200), now
        );
        const row = this.db.prepare(`SELECT * FROM orchestration_recovery_milestones
          WHERE workspace_id = ? AND recovery_id = ? AND milestone_key = ?`)
          .get(workspaceId, episode.id, input.milestone.key) as any;
        milestone = row ? orchestrationRecoveryMilestoneFromRow(row) : undefined;
      }
    });
    save();
    return { episode: saved, changed, milestone };
  }

  createOrchestrationRecoveryAction(input: {
    id: string;
    runId: string;
    recoveryId: string;
    actorId: string;
    idempotencyKey: string;
    expectedRunRevision: number;
    expectedRecoveryRevision: number;
    expectedTaskRevision?: number;
    action: OrchestrationRecoveryActionName;
    guidance?: string;
    now?: string;
  }): { action: OrchestrationRecoveryActionRecord; created: boolean } {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const existingRow = this.db.prepare(`SELECT * FROM orchestration_recovery_actions
      WHERE workspace_id = ? AND recovery_id = ? AND idempotency_key = ?`)
      .get(workspaceId, input.recoveryId, input.idempotencyKey) as any;
    if (existingRow) {
      const existingAction = orchestrationRecoveryActionFromRow(existingRow);
      if (existingAction.actorId !== input.actorId || existingAction.action !== input.action ||
          existingAction.guidance !== input.guidance || existingAction.expectedRunRevision !== input.expectedRunRevision ||
          existingAction.expectedRecoveryRevision !== input.expectedRecoveryRevision ||
          existingAction.expectedTaskRevision !== input.expectedTaskRevision) {
        throw new Error('This action key was already used for a different recovery request.');
      }
      return { action: existingAction, created: false };
    }
    const currentRun = this.db.prepare('SELECT revision FROM orchestration_runs WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, input.runId) as { revision: number } | undefined;
    const currentRecovery = this.getOrchestrationRecoveryEpisode(input.runId, input.recoveryId);
    if (!currentRun || !currentRecovery || currentRun.revision !== input.expectedRunRevision ||
        currentRecovery.revision !== input.expectedRecoveryRevision) {
      throw new Error('The build or recovery changed. Refresh its current status before acting.');
    }
    if (input.expectedTaskRevision !== undefined) {
      const task = this.db.prepare(`SELECT revision FROM orchestration_tasks
        WHERE workspace_id = ? AND run_id = ? AND task_id = ?`).get(workspaceId, input.runId,
        currentRecovery.taskId ?? '') as { revision: number } | undefined;
      if (!task || task.revision !== input.expectedTaskRevision) throw new Error('This task changed. Refresh the build before retrying.');
    }
    const result = this.db.prepare(`INSERT OR IGNORE INTO orchestration_recovery_actions
      (id, workspace_id, run_id, recovery_id, actor_id, idempotency_key, expected_run_revision,
       expected_recovery_revision, expected_task_revision, action, guidance, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(input.id, workspaceId, input.runId, input.recoveryId, input.actorId, input.idempotencyKey,
        input.expectedRunRevision, input.expectedRecoveryRevision, input.expectedTaskRevision ?? null,
        input.action, input.guidance ?? null, now);
    const row = this.db.prepare(`SELECT * FROM orchestration_recovery_actions
      WHERE workspace_id = ? AND recovery_id = ? AND idempotency_key = ?`)
      .get(workspaceId, input.recoveryId, input.idempotencyKey) as any;
    if (!row) throw new Error('Recovery action could not be recorded.');
    const action = orchestrationRecoveryActionFromRow(row);
    if (action.actorId !== input.actorId || action.action !== input.action || action.guidance !== input.guidance ||
        action.expectedRunRevision !== input.expectedRunRevision || action.expectedRecoveryRevision !== input.expectedRecoveryRevision ||
        action.expectedTaskRevision !== input.expectedTaskRevision) {
      throw new Error('This action key was already used for a different recovery request.');
    }
    return { action, created: result.changes === 1 };
  }

  finishOrchestrationRecoveryAction(input: {
    recoveryId: string;
    idempotencyKey: string;
    actorId: string;
    status: 'completed' | 'failed';
    result?: Record<string, unknown>;
    errorCode?: string;
    now?: string;
  }): OrchestrationRecoveryActionRecord | undefined {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`UPDATE orchestration_recovery_actions SET status = ?, result_json = ?, error_code = ?, completed_at = ?
      WHERE workspace_id = ? AND recovery_id = ? AND idempotency_key = ? AND actor_id = ? AND status = 'pending'`)
      .run(input.status, input.result ? JSON.stringify(input.result) : null, input.errorCode ?? null, now,
        workspaceId, input.recoveryId, input.idempotencyKey, input.actorId);
    const row = this.db.prepare(`SELECT * FROM orchestration_recovery_actions
      WHERE workspace_id = ? AND recovery_id = ? AND idempotency_key = ? AND actor_id = ?`)
      .get(workspaceId, input.recoveryId, input.idempotencyKey, input.actorId) as any;
    return row ? orchestrationRecoveryActionFromRow(row) : undefined;
  }

  listPendingOrchestrationRecoveryMilestones(limit = 100): OrchestrationRecoveryMilestone[] {
    const rows = this.db.prepare(`SELECT * FROM orchestration_recovery_milestones
      WHERE workspace_id = ? AND delivered_at IS NULL ORDER BY created_at, id LIMIT ?`)
      .all(this.workspaceId(), Math.max(1, Math.min(limit, 500))) as any[];
    return rows.map(orchestrationRecoveryMilestoneFromRow);
  }

  markOrchestrationRecoveryMilestoneDelivered(id: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE orchestration_recovery_milestones SET delivered_at = ?
      WHERE workspace_id = ? AND id = ? AND delivered_at IS NULL`)
      .run(now, this.workspaceId(), id).changes === 1;
  }

  getOrchestrationByRequestKey(requestKey: string): OrchestrationSnapshot | undefined {
    const row = this.db.prepare('SELECT id FROM orchestration_runs WHERE workspace_id = ? AND request_key = ?')
      .get(this.workspaceId(), requestKey) as any;
    return row ? this.getOrchestrationSnapshot(row.id) : undefined;
  }

  listActiveOrchestrationSnapshots(): OrchestrationSnapshot[] {
    const statuses = ['planning', 'awaiting_plan_approval', 'executing', 'paused', 'validating', 'blocked', 'recovery_required', 'publishing', 'cancelling'];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT id FROM orchestration_runs WHERE workspace_id = ? AND status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(this.workspaceId(), ...statuses) as Array<{ id: string }>;
    return rows.map(row => this.getOrchestrationSnapshot(row.id)).filter((item): item is OrchestrationSnapshot => Boolean(item));
  }

  listAllActiveOrchestrationSnapshots(): OrchestrationSnapshot[] {
    const statuses = ['planning', 'awaiting_plan_approval', 'executing', 'paused', 'validating', 'blocked', 'recovery_required', 'publishing', 'cancelling'];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT workspace_id, id FROM orchestration_runs WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...statuses) as Array<{ workspace_id: string; id: string }>;
    return rows.flatMap(row => {
      const snapshot = runWithWorkspace(row.workspace_id, () => this.getOrchestrationSnapshot(row.id));
      return snapshot ? [snapshot] : [];
    });
  }

  /** Published workflows whose project-issue effects may need replay. */
  listAllPublishedOrchestrationSnapshots(): OrchestrationSnapshot[] {
    const rows = this.db.prepare(`SELECT DISTINCT runs.workspace_id, runs.id, events.payload_json
      FROM orchestration_runs AS runs
      JOIN orchestration_events AS events
        ON events.workspace_id = runs.workspace_id AND events.run_id = runs.id
      WHERE runs.status = 'completed' AND events.event_type = 'run_completed'
      ORDER BY runs.updated_at ASC`)
      .all() as Array<{ workspace_id: string; id: string; payload_json: string }>;
    const approved = rows.filter(row => {
      try {
        const payload = JSON.parse(row.payload_json) as { evidence?: { decision?: unknown; publication?: unknown } };
        return payload.evidence?.decision === 'approved' && Boolean(payload.evidence.publication);
      } catch {
        return false;
      }
    });
    return approved.flatMap(row => {
      const snapshot = runWithWorkspace(row.workspace_id, () => this.getOrchestrationSnapshot(row.id));
      return snapshot?.run.publication ? [snapshot] : [];
    });
  }

  getLatestOrchestrationSnapshot(projectId: string): OrchestrationSnapshot | undefined {
    const row = this.db.prepare('SELECT id FROM orchestration_runs WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(this.workspaceId(), projectId) as { id: string } | undefined;
    return row ? this.getOrchestrationSnapshot(row.id) : undefined;
  }

  /** The newest Orchestrator build for each issue in the given projects, for the board's status chips. */
  listLatestIssueBuilds(projectIds: string[]): Array<{ issueId: string; projectId: string; runId: string; status: string; updatedAt: string }> {
    if (!projectIds.length) return [];
    const placeholders = projectIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT issue_id, project_id, id, status, updated_at FROM orchestration_runs
      WHERE workspace_id = ? AND project_id IN (${placeholders}) ORDER BY created_at DESC`)
      .all(this.workspaceId(), ...projectIds) as Array<{ issue_id: string; project_id: string; id: string; status: string; updated_at: string }>;
    const latest = new Map<string, { issueId: string; projectId: string; runId: string; status: string; updatedAt: string }>();
    for (const row of rows) {
      if (!latest.has(row.issue_id)) {
        latest.set(row.issue_id, { issueId: row.issue_id, projectId: row.project_id, runId: row.id, status: row.status, updatedAt: row.updated_at });
      }
    }
    return [...latest.values()];
  }

  reserveOrchestrationPlanning(input: {
    projectId: string;
    repository: string;
    requestKey: string;
    requestFingerprint: string;
    createdBy: string;
    runId: string;
    branchName: string;
    baseCommit: string;
    worktreePath: string;
    ownerSessionId: string;
    now?: string;
  }): {
    runId: string;
    repository: string;
    repositoryKey: string;
    requestKey: string;
    requestFingerprint: string;
    branchName: string;
    baseCommit: string;
    worktreePath: string;
    ownerSessionId: string | null;
    createdAt: string;
    created: boolean;
  } {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const repositoryKey = canonicalOrchestrationRepository(input.repository);
    if (!repositoryKey) throw new Error('A canonical repository identity is required to reserve task planning.');
    if (!/^[a-f0-9]{40,64}$/i.test(input.baseCommit)) throw new Error('The planning base commit is invalid.');
    if (!path.isAbsolute(input.worktreePath) || !this.isPathAllowed(input.worktreePath)) {
      throw new Error('The planning worktree is outside the approved local workspace.');
    }
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM orchestration_planning_reservations WHERE workspace_id = ? AND request_key = ?')
        .get(workspaceId, input.requestKey) as any;
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          throw new Error('This request key is already reserved for a different build request.');
        }
        return {
          runId: existing.run_id, repository: existing.repository, repositoryKey: existing.repository_key,
          requestKey: existing.request_key, requestFingerprint: existing.request_fingerprint,
          branchName: existing.branch_name, baseCommit: existing.base_commit,
          worktreePath: existing.worktree_path, ownerSessionId: existing.owner_session_id ?? null,
          createdAt: existing.created_at, created: false
        };
      }
      const activeStatuses = ['planning', 'awaiting_plan_approval', 'executing', 'paused', 'validating', 'awaiting_approval', 'publishing', 'blocked', 'recovery_required', 'cancelling'];
      const placeholders = activeStatuses.map(() => '?').join(', ');
      const active = this.db.prepare(`SELECT id, repository, repository_workspaces_json FROM orchestration_runs WHERE workspace_id = ? AND project_id = ? AND status IN (${placeholders})`)
        .all(workspaceId, input.projectId, ...activeStatuses) as Array<{ id: string; repository: string; repository_workspaces_json: string }>;
      const activeRepo = active.find(row => {
        const workspaces = parseJson<Array<{ repository?: string }>>(row.repository_workspaces_json, []);
        return canonicalOrchestrationRepository(row.repository) === repositoryKey ||
          workspaces.some(item => typeof item.repository === 'string' && canonicalOrchestrationRepository(item.repository) === repositoryKey);
      });
      if (activeRepo) throw new Error('A task-based build already owns this project repository. Follow or resolve it before planning another.');

      const codeCallLock = this.db.prepare('SELECT owner_call_id FROM project_code_execution_locks WHERE workspace_id = ? AND project_id = ? AND repository_key = ?')
        .get(workspaceId, input.projectId, repositoryKey) as { owner_call_id: string } | undefined;
      if (codeCallLock) throw new Error('An independent project code call or patch is using this repository. Let it finish before starting a task-based build.');

      const runId = input.runId;
      try {
        this.db.prepare(`INSERT INTO orchestration_planning_reservations
          (workspace_id, project_id, repository, repository_key, request_key, request_fingerprint, run_id, created_by, branch_name, base_commit, worktree_path, owner_session_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(workspaceId, input.projectId, input.repository, repositoryKey, input.requestKey,
            input.requestFingerprint, runId, input.createdBy, input.branchName, input.baseCommit,
          input.worktreePath, input.ownerSessionId, now);
      } catch (error) {
        const reserved = this.db.prepare('SELECT request_key FROM orchestration_planning_reservations WHERE workspace_id = ? AND project_id = ? AND repository_key = ?')
          .get(workspaceId, input.projectId, repositoryKey) as { request_key: string } | undefined;
        if (reserved) throw new Error('Another task build is already being planned for this project repository.');
        throw error;
      }
      return {
        runId, repository: input.repository, repositoryKey, requestKey: input.requestKey,
        requestFingerprint: input.requestFingerprint, branchName: input.branchName,
        baseCommit: input.baseCommit, worktreePath: input.worktreePath,
        ownerSessionId: input.ownerSessionId, createdAt: now, created: true
      };
    })();
  }

  releaseOrchestrationPlanningReservation(
    requestKey: string,
    requestFingerprint: string,
    expectedOwnerSessionId: string | null
  ): boolean {
    return this.db.prepare(`DELETE FROM orchestration_planning_reservations
      WHERE workspace_id = ? AND request_key = ? AND request_fingerprint = ? AND owner_session_id IS ?`)
      .run(this.workspaceId(), requestKey, requestFingerprint, expectedOwnerSessionId).changes === 1;
  }

  getOrchestrationPlanningReservation(projectId: string, repository?: string): {
    runId: string;
    repository: string;
    requestKey: string;
    requestFingerprint: string;
    branchName: string;
    baseCommit: string;
    worktreePath: string;
    ownerSessionId: string | null;
    createdAt: string;
  } | undefined {
    const rows = this.db.prepare('SELECT run_id, repository, repository_key, request_key, request_fingerprint, branch_name, base_commit, worktree_path, owner_session_id, created_at FROM orchestration_planning_reservations WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC')
      .all(this.workspaceId(), projectId) as any[];
    const key = repository ? canonicalOrchestrationRepository(repository) : undefined;
    const row = key ? rows.find(item => item.repository_key === key) : rows[0];
    return row ? {
      runId: row.run_id, repository: row.repository, requestKey: row.request_key,
      requestFingerprint: row.request_fingerprint,
      branchName: row.branch_name, baseCommit: row.base_commit,
      worktreePath: row.worktree_path, ownerSessionId: row.owner_session_id ?? null,
      createdAt: row.created_at
    } : undefined;
  }

  getOrchestrationPlanningReservationByRun(projectId: string, runId: string, repository?: string): {
    runId: string;
    repository: string;
    repositoryKey: string;
    requestKey: string;
    requestFingerprint: string;
    branchName: string;
    baseCommit: string;
    worktreePath: string;
    ownerSessionId: string | null;
    createdAt: string;
  } | undefined {
    const rows = this.db.prepare(`SELECT run_id, repository, repository_key, request_key, request_fingerprint,
      branch_name, base_commit, worktree_path, owner_session_id, created_at
      FROM orchestration_planning_reservations
      WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
      .all(this.workspaceId(), projectId, runId) as any[];
    const repositoryKey = repository ? canonicalOrchestrationRepository(repository) : undefined;
    const row = repositoryKey ? rows.find(item => item.repository_key === repositoryKey) : rows[0];
    return row ? {
      runId: row.run_id, repository: row.repository, repositoryKey: row.repository_key,
      requestKey: row.request_key, requestFingerprint: row.request_fingerprint,
      branchName: row.branch_name, baseCommit: row.base_commit,
      worktreePath: row.worktree_path, ownerSessionId: row.owner_session_id ?? null,
      createdAt: row.created_at
    } : undefined;
  }

  listOrchestrationPlanningReservations(projectId: string, limit = 20): NonNullable<ReturnType<SQLiteService['getOrchestrationPlanningReservationByRun']>>[] {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT run_id, repository, repository_key, request_key, request_fingerprint,
      branch_name, base_commit, worktree_path, owner_session_id, created_at
      FROM orchestration_planning_reservations
      WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(this.workspaceId(), projectId, safeLimit) as any[];
    return rows.map(row => ({
      runId: row.run_id, repository: row.repository, repositoryKey: row.repository_key,
      requestKey: row.request_key, requestFingerprint: row.request_fingerprint,
      branchName: row.branch_name, baseCommit: row.base_commit,
      worktreePath: row.worktree_path, ownerSessionId: row.owner_session_id ?? null,
      createdAt: row.created_at
    }));
  }

  recordOrchestrationPlanningRecovery(input: {
    projectId: string;
    reservation: NonNullable<ReturnType<SQLiteService['getOrchestrationPlanningReservationByRun']>>;
    state: 'needs_review' | 'manual_review';
    reason: string;
    now?: string;
  }): { runId: string; repository: string; branchName: string; baseCommit: string; state: 'needs_review' | 'manual_review'; reason: string; revision: number; createdAt: string; updatedAt: string } {
    const reservation = input.reservation;
    if (!reservation) throw new Error('The interrupted planning reservation is unavailable.');
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    this.db.transaction(() => {
      const current = this.db.prepare(`SELECT request_key, request_fingerprint, owner_session_id
        FROM orchestration_planning_reservations
        WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
        .get(workspaceId, input.projectId, reservation.runId) as any;
      if (!current || current.request_key !== reservation.requestKey ||
          current.request_fingerprint !== reservation.requestFingerprint ||
          (current.owner_session_id ?? null) !== reservation.ownerSessionId) {
        throw new Error('The planning reservation changed before recovery could be recorded.');
      }
      this.db.prepare(`INSERT INTO orchestration_planning_recoveries
        (workspace_id, project_id, run_id, repository, repository_key, request_key, request_fingerprint,
         branch_name, base_commit, worktree_path, owner_session_id, state, reason, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(workspace_id, run_id) DO UPDATE SET
          state = CASE WHEN orchestration_planning_recoveries.state IN ('retained', 'cleaned') THEN orchestration_planning_recoveries.state ELSE excluded.state END,
          reason = CASE WHEN orchestration_planning_recoveries.state IN ('retained', 'cleaned') THEN orchestration_planning_recoveries.reason ELSE excluded.reason END,
          revision = CASE WHEN orchestration_planning_recoveries.state IN ('retained', 'cleaned') THEN orchestration_planning_recoveries.revision ELSE orchestration_planning_recoveries.revision + 1 END,
          updated_at = CASE WHEN orchestration_planning_recoveries.state IN ('retained', 'cleaned') THEN orchestration_planning_recoveries.updated_at ELSE excluded.updated_at END`)
        .run(workspaceId, input.projectId, reservation.runId, reservation.repository, reservation.repositoryKey,
          reservation.requestKey, reservation.requestFingerprint, reservation.branchName, reservation.baseCommit,
          reservation.worktreePath, reservation.ownerSessionId, input.state, input.reason.slice(0, 1_000), now, now);
    })();
    const row = this.db.prepare(`SELECT run_id, repository, branch_name, base_commit, state, reason, revision, created_at, updated_at
      FROM orchestration_planning_recoveries WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
      .get(workspaceId, input.projectId, reservation.runId) as any;
    if (!row) throw new Error('The planning recovery record could not be loaded.');
    return {
      runId: row.run_id, repository: row.repository, branchName: row.branch_name, baseCommit: row.base_commit,
      state: row.state, reason: row.reason, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  getOrchestrationPlanningRecovery(projectId: string, runId: string): {
    projectId: string; runId: string; repository: string; repositoryKey: string; requestKey: string;
    requestFingerprint: string; branchName: string; baseCommit: string; worktreePath: string;
    ownerSessionId: string | null; state: 'needs_review' | 'manual_review' | 'retained' | 'cleaned'; reason: string;
    revision: number; createdAt: string; updatedAt: string; resolvedAt?: string; resolvedBy?: string;
  } | undefined {
    const row = this.db.prepare(`SELECT project_id, run_id, repository, repository_key, request_key, request_fingerprint,
      branch_name, base_commit, worktree_path, owner_session_id, state, reason, revision, created_at, updated_at, resolved_at, resolved_by
      FROM orchestration_planning_recoveries WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
      .get(this.workspaceId(), projectId, runId) as any;
    return row ? {
      projectId: row.project_id, runId: row.run_id, repository: row.repository, repositoryKey: row.repository_key,
      requestKey: row.request_key, requestFingerprint: row.request_fingerprint, branchName: row.branch_name,
      baseCommit: row.base_commit, worktreePath: row.worktree_path, ownerSessionId: row.owner_session_id ?? null,
      state: row.state, reason: row.reason, revision: row.revision, createdAt: row.created_at,
      updatedAt: row.updated_at, resolvedAt: row.resolved_at ?? undefined, resolvedBy: row.resolved_by ?? undefined
    } : undefined;
  }

  listOrchestrationPlanningRecoveries(projectId: string, limit = 10): NonNullable<ReturnType<SQLiteService['getOrchestrationPlanningRecovery']>>[] {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT run_id FROM orchestration_planning_recoveries
      WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(this.workspaceId(), projectId, safeLimit) as Array<{ run_id: string }>;
    return rows.map(row => this.getOrchestrationPlanningRecovery(projectId, row.run_id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }

  retainOrchestrationPlanningRecovery(input: {
    projectId: string;
    runId: string;
    expectedRevision: number;
    actorId: string;
    now?: string;
  }): NonNullable<ReturnType<SQLiteService['getOrchestrationPlanningRecovery']>> {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    this.db.transaction(() => {
      const recovery = this.db.prepare(`SELECT request_key, request_fingerprint, owner_session_id, state, revision
        FROM orchestration_planning_recoveries WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
        .get(workspaceId, input.projectId, input.runId) as any;
      if (!recovery) throw new Error('The planning recovery record is unavailable.');
      if (recovery.state === 'retained') return;
      if (recovery.state !== 'needs_review') throw new Error('Alpha cannot safely unlock this planning workspace automatically.');
      if (recovery.revision !== input.expectedRevision) throw new Error('The saved workspace changed during review. Refresh it before continuing.');
      const released = this.db.prepare(`DELETE FROM orchestration_planning_reservations
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND request_key = ?
          AND request_fingerprint = ? AND owner_session_id IS ?`)
        .run(workspaceId, input.projectId, input.runId, recovery.request_key, recovery.request_fingerprint, recovery.owner_session_id ?? null);
      if (released.changes !== 1) throw new Error('The planning reservation changed before recovery was resolved. Refresh the project and inspect its active build.');
      const updated = this.db.prepare(`UPDATE orchestration_planning_recoveries
        SET state = 'retained', revision = revision + 1, updated_at = ?, resolved_at = ?, resolved_by = ?
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND state = 'needs_review' AND revision = ?`)
        .run(now, now, input.actorId, workspaceId, input.projectId, input.runId, input.expectedRevision);
      if (updated.changes !== 1) throw new Error('The planning recovery record changed before it could be resolved.');
    })();
    const result = this.getOrchestrationPlanningRecovery(input.projectId, input.runId);
    if (!result) throw new Error('The resolved planning recovery could not be loaded.');
    return result;
  }

  cleanOrchestrationPlanningReservation(input: {
    projectId: string;
    runId: string;
    reservation: NonNullable<ReturnType<SQLiteService['getOrchestrationPlanningReservationByRun']>>;
    actorId: string;
    now?: string;
  }): { recoveryState: 'cleaned'; revision: number } {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const current = this.db.prepare(`SELECT repository, repository_key, request_key, request_fingerprint,
        branch_name, base_commit, worktree_path, owner_session_id
        FROM orchestration_planning_reservations
        WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
        .get(workspaceId, input.projectId, input.runId) as any;
      if (!current || current.request_key !== input.reservation.requestKey ||
          current.request_fingerprint !== input.reservation.requestFingerprint ||
          (current.owner_session_id ?? null) !== input.reservation.ownerSessionId) {
        throw new Error('The planning reservation changed during recovery. Refresh the room and inspect the active build.');
      }
      const reservation = this.db.prepare(`DELETE FROM orchestration_planning_reservations
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND request_key = ?
          AND request_fingerprint = ? AND owner_session_id IS ?`)
        .run(workspaceId, input.projectId, input.runId, input.reservation.requestKey,
          input.reservation.requestFingerprint, input.reservation.ownerSessionId);
      if (reservation.changes !== 1) throw new Error('The planning reservation changed during recovery. Refresh the room and inspect the active build.');
      const prior = this.db.prepare(`SELECT state, revision FROM orchestration_planning_recoveries
        WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
        .get(workspaceId, input.projectId, input.runId) as { state: string; revision: number } | undefined;
      let revision = 0;
      if (prior) {
        if (!['needs_review', 'manual_review'].includes(prior.state)) {
          throw new Error('The planning recovery record is no longer in a cleanable state.');
        }
        revision = prior.revision + 1;
        this.db.prepare(`UPDATE orchestration_planning_recoveries
          SET state = 'cleaned', reason = ?, revision = ?, updated_at = ?, resolved_at = ?, resolved_by = ?
          WHERE workspace_id = ? AND project_id = ? AND run_id = ?`)
          .run('The saved planning workspace was verified clean and safely removed.', revision, now, now,
            input.actorId, workspaceId, input.projectId, input.runId);
      } else {
        this.db.prepare(`INSERT INTO orchestration_planning_recoveries
          (workspace_id, project_id, run_id, repository, repository_key, request_key, request_fingerprint,
           branch_name, base_commit, worktree_path, owner_session_id, state, reason, revision, created_at, updated_at, resolved_at, resolved_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cleaned', ?, 0, ?, ?, ?, ?)`)
          .run(workspaceId, input.projectId, input.runId, current.repository, current.repository_key,
            current.request_key, current.request_fingerprint, current.branch_name, current.base_commit,
            current.worktree_path, current.owner_session_id, 'The saved planning workspace was verified clean and safely removed.',
            now, now, now, input.actorId);
      }
      return { recoveryState: 'cleaned' as const, revision };
    })();
  }

  /** Active local workflow ownership for an attached project repository. */
  getActiveOrchestrationForProject(projectId: string, repository?: string): {
    runId: string;
    repository: string;
    status: OrchestrationRunRecord['status'];
    branchName?: string;
  } | undefined {
    const activeStatuses = ['planning', 'awaiting_plan_approval', 'executing', 'paused', 'validating', 'awaiting_approval', 'publishing', 'blocked', 'recovery_required', 'cancelling'];
    const placeholders = activeStatuses.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT id, repository, repository_workspaces_json, status, branch_name, created_at FROM orchestration_runs WHERE workspace_id = ? AND project_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`)
      .all(this.workspaceId(), projectId, ...activeStatuses) as any[];
    const normalize = canonicalOrchestrationRepository;
    const matching = repository ? rows.find(row => normalize(row.repository) === normalize(repository) ||
      parseJson<Array<{ repository?: string }>>(row.repository_workspaces_json, []).some(item => item.repository && normalize(item.repository) === normalize(repository))) : rows[0];
    const reservation = this.getOrchestrationPlanningReservation(projectId, repository);
    if (reservation && (!matching || Date.parse(reservation.createdAt) >= Date.parse(matching.created_at))) return {
      runId: reservation.runId, repository: reservation.repository, status: 'planning', branchName: reservation.branchName
    };
    return matching ? {
      runId: matching.id,
      repository: matching.repository,
      status: matching.status,
      branchName: matching.branch_name ?? undefined
    } : undefined;
  }

  transitionOrchestrationRun(input: {
    runId: string;
    expectedRevision: number;
    nextStatus: OrchestrationRunRecord['status'];
    actorId?: string;
    reason?: string;
    evidence?: Record<string, unknown>;
    clearPauseRequest?: boolean;
    clearStoppedReason?: boolean;
    clearCurrentTaskId?: boolean;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const change = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (['validating', 'awaiting_approval', 'publishing', 'completed'].includes(input.nextStatus)) {
        if (snapshot.run.currentTaskId || snapshot.tasks.some(task => ['running', 'submitted'].includes(task.status))) {
          throw new Error('The build still has a task awaiting execution or acceptance.');
        }
        if (!snapshot.tasks.filter(task => task.required).every(task => task.status === 'accepted')) {
          throw new Error('All required tasks must be accepted before final validation or approval.');
        }
      }
      if (input.nextStatus === 'awaiting_approval' && !input.evidence) {
        throw new Error('Final validation evidence is required before requesting human approval.');
      }
      if (input.nextStatus === 'awaiting_approval' && (snapshot.run.repositoryWorkspaces?.length ?? 0) > 1) {
        const repositoryEvidence = Array.isArray(input.evidence?.repositories)
          ? input.evidence!.repositories as Array<Record<string, unknown>> : [];
        const workspaces = snapshot.run.repositoryWorkspaces!;
        const seenRepositories = new Set<string>();
        for (const workspace of workspaces) {
          const repositoryKey = canonicalOrchestrationRepository(workspace.repository);
          const item = repositoryEvidence.find(candidate => typeof candidate.repository === 'string' &&
            canonicalOrchestrationRepository(candidate.repository) === repositoryKey);
          const checks = item?.checks && typeof item.checks === 'object' ? item.checks as Record<string, unknown> : undefined;
          if (!item || seenRepositories.has(repositoryKey) || item.baseCommit !== workspace.baseCommit ||
              item.branchName !== workspace.branchName || typeof item.resultCommit !== 'string' ||
              !/^[a-f0-9]{40,64}$/i.test(item.resultCommit) || !checks || checks.status !== 'passed' ||
              !Array.isArray(checks.missingScripts) || checks.missingScripts.length ||
              !Array.isArray(checks.observed) || !checks.observed.length ||
              checks.observed.some(command => !command || typeof command !== 'object' ||
                (command as Record<string, unknown>).exitCode !== 0 || (command as Record<string, unknown>).signal !== null)) {
            throw new Error(`Final validation evidence for ${workspace.repository} is incomplete or did not pass.`);
          }
          seenRepositories.add(repositoryKey);
        }
      }
      if (input.nextStatus === 'publishing' && snapshot.run.status === 'awaiting_approval' &&
          (!input.evidence || input.evidence.decision !== 'approved' ||
            typeof input.evidence.publicationBaseBranch !== 'string')) {
        throw new Error('A human approval and a resolved pull request target are required before publication.');
      }
      if (input.nextStatus === 'completed' && snapshot.run.status === 'publishing' &&
          (!input.evidence || input.evidence.decision !== 'approved' ||
            !input.evidence.publication || typeof input.evidence.publication !== 'object')) {
        throw new Error('A reconciled pull request is required before completing this task build.');
      }
      if (input.nextStatus === 'completed' && snapshot.run.status === 'publishing') {
        const publication = input.evidence!.publication as Record<string, unknown>;
        const validationEvent = this.db.prepare(`SELECT payload_json FROM orchestration_events
          WHERE workspace_id = ? AND run_id = ? AND event_type = 'run_awaiting_approval'
          ORDER BY run_sequence DESC LIMIT 1`).get(workspaceId, input.runId) as { payload_json: string } | undefined;
        const validationPayload = parseJson<{ evidence?: Record<string, unknown> }>(validationEvent?.payload_json, {});
        const validated = validationPayload.evidence ?? {};
        const expectedWorkspaces = snapshot.run.repositoryWorkspaces?.length ? snapshot.run.repositoryWorkspaces : [{
          repository: snapshot.run.repository, branchName: snapshot.run.branchName ?? ''
        }];
        const publicationRecords = Array.isArray(input.evidence!.publications)
          ? input.evidence!.publications as Array<Record<string, unknown>> : [publication];
        const validatedRepositories = Array.isArray(validated.repositories) ? validated.repositories as Array<Record<string, unknown>> : [];
        const mismatchReasons = publicationRecords.length !== expectedWorkspaces.length ? ['repositories'] : [];
        const seenPublicationRepositories = new Set<string>();
        for (const workspace of expectedWorkspaces) {
          const record = publicationRecords.find(item => typeof item.repository === 'string' &&
            canonicalOrchestrationRepository(item.repository).toLowerCase() === canonicalOrchestrationRepository(workspace.repository).toLowerCase()) ??
            (workspace.repository === snapshot.run.repository ? publication : undefined);
          const publicationRepository = record && typeof record.repository === 'string'
            ? canonicalOrchestrationRepository(record.repository) : canonicalOrchestrationRepository(workspace.repository);
          if (seenPublicationRepositories.has(publicationRepository)) mismatchReasons.push('duplicate repository');
          seenPublicationRepositories.add(publicationRepository);
          const repoValidation = validatedRepositories.find(item => typeof item.repository === 'string' &&
            canonicalOrchestrationRepository(item.repository).toLowerCase() === canonicalOrchestrationRepository(workspace.repository).toLowerCase());
          const resultCommit = typeof repoValidation?.resultCommit === 'string' ? repoValidation.resultCommit
            : workspace.repository === snapshot.run.repository ? validated.resultCommit : undefined;
          const branchName = typeof repoValidation?.branchName === 'string' ? repoValidation.branchName
            : workspace.repository === snapshot.run.repository ? validated.branchName : undefined;
          const pullUrl = typeof record?.pullRequestUrl === 'string' ? record.pullRequestUrl.toLowerCase() : '';
          const expectedPullPrefix = `https://github.com/${canonicalOrchestrationRepository(workspace.repository).toLowerCase()}/pull/`;
          const checks = [
            !record || !isSafeOrchestrationBranchName(record.branchName) || record.branchName !== workspace.branchName ? 'branch' : '',
            !record || !isSafeOrchestrationBranchName(record.baseBranch) || record.baseBranch === record.branchName ? 'base branch' : '',
            typeof record?.resultCommit !== 'string' || record.resultCommit !== resultCommit || branchName !== record.branchName ? 'commit' : '',
            !pullUrl.startsWith(expectedPullPrefix) || !/^\d+$/.test(pullUrl.slice(expectedPullPrefix.length)) ? 'pull request URL' : '',
            typeof record?.publishedAt !== 'string' || !Number.isFinite(Date.parse(record.publishedAt)) ? 'publication time' : ''
          ].filter(Boolean);
          mismatchReasons.push(...checks);
        }
        if (mismatchReasons.length) {
          throw new Error(`The published pull request does not match the validated ${mismatchReasons.join(', ')}. Reconcile final review before completing the build.`);
        }
      }
      if (input.nextStatus === 'awaiting_approval' && snapshot.findings.some(finding =>
        finding.status === 'open' && ['blocking', 'critical'].includes(finding.severity))) {
        throw new Error('Open blocking or critical findings must be resolved before requesting human approval.');
      }
      const updated = transitionRun(snapshot.run, input.nextStatus, input.expectedRevision, now);
      const nextStoppedReason = input.clearStoppedReason
        ? null
        : input.reason === undefined ? (snapshot.run.stoppedReason ?? null) : input.reason;
      const result = this.db.prepare('UPDATE orchestration_runs SET status = ?, revision = ?, stopped_reason = ?, current_task_id = CASE WHEN ? = 1 THEN NULL ELSE current_task_id END, pause_requested_at = CASE WHEN ? = 1 THEN NULL ELSE pause_requested_at END, pause_requested_by = CASE WHEN ? = 1 THEN NULL ELSE pause_requested_by END, updated_at = ? WHERE workspace_id = ? AND id = ? AND revision = ?')
        .run(updated.status, updated.revision, nextStoppedReason,
          input.clearCurrentTaskId ? 1 : 0, input.clearPauseRequest ? 1 : 0, input.clearPauseRequest ? 1 : 0, now,
          workspaceId, input.runId, input.expectedRevision);
      if (result.changes !== 1) throw new Error('Build changed while its transition was being committed.');
      this.appendOrchestrationEvent(input.runId, `run_${updated.status}`, {
        revision: updated.revision,
        reason: input.reason,
        evidence: input.evidence
      }, input.actorId, now);
    });
    change();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  requestOrchestrationPause(input: {
    runId: string;
    expectedRevision: number;
    actorId: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const request = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (snapshot.run.revision !== input.expectedRevision) throw new Error('Build changed before the pause request arrived. Refresh and try again.');
      if (snapshot.run.status !== 'executing') throw new Error('Only a running build can be paused.');
      if (snapshot.run.pauseRequestedAt) return;
      const reason = snapshot.run.currentTaskId
        ? 'Pause requested. The current specialist will finish this step; Alpha will pause before the next handoff.'
        : 'Build paused at the current checkpoint.';
      if (!snapshot.run.currentTaskId) {
        const updated = transitionRun(snapshot.run, 'paused', input.expectedRevision, now);
        const result = this.db.prepare(`UPDATE orchestration_runs SET status = ?, revision = ?, stopped_reason = ?,
          pause_requested_at = NULL, pause_requested_by = NULL, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?`).run(
          updated.status, updated.revision, reason, now, workspaceId, input.runId, input.expectedRevision
        );
        if (result.changes !== 1) throw new Error('Build changed while its pause was being committed.');
        this.appendOrchestrationEvent(input.runId, 'run_paused', {
          revision: updated.revision, reason, currentTaskId: undefined
        }, input.actorId, now);
        return;
      }
      const nextRevision = snapshot.run.revision + 1;
      const result = this.db.prepare(`UPDATE orchestration_runs SET pause_requested_at = ?, pause_requested_by = ?,
        revision = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'executing'`)
        .run(now, input.actorId, nextRevision, now, workspaceId, input.runId, input.expectedRevision);
      if (result.changes !== 1) throw new Error('Build changed while its pause request was being saved.');
      this.appendOrchestrationEvent(input.runId, 'run_pause_requested', {
        revision: nextRevision, currentTaskId: snapshot.run.currentTaskId, reason
      }, input.actorId, now);
    });
    request();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  cancelOrchestrationRun(input: {
    runId: string;
    actorId: string;
    reason?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const reason = input.reason ?? 'Build cancelled by an authorized project member.';
    const cancel = this.db.transaction(() => {
      let snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (snapshot.run.status === 'publishing') {
        throw new Error('An approved build cannot be cancelled while its pull request is being reconciled.');
      }
      if (['failed', 'cancelled'].includes(snapshot.run.status)) return;
      const currentTask = snapshot.run.currentTaskId
        ? snapshot.tasks.find(task => task.id === snapshot!.run.currentTaskId)
        : undefined;
      if (currentTask && !['accepted', 'failed', 'cancelled', 'superseded'].includes(currentTask.status)) {
        const activeAttempt = [...snapshot.attempts].reverse().find(attempt =>
          attempt.taskId === currentTask.id && ['starting', 'running', 'submitted'].includes(attempt.status));
        if (activeAttempt) {
          this.db.prepare("UPDATE orchestration_attempts SET status = 'cancelled', failure_reason = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND id = ? AND status IN ('starting', 'running', 'submitted')")
            .run(reason, now, workspaceId, input.runId, activeAttempt.id);
          this.db.prepare("UPDATE orchestration_artifacts SET status = 'cancelled' WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND attempt_id = ? AND status = 'submitted'")
            .run(workspaceId, input.runId, currentTask.id, activeAttempt.id);
        }
        snapshot = this.transitionOrchestrationTask({
          runId: input.runId, taskId: currentTask.id, expectedRevision: currentTask.revision,
          nextStatus: 'cancelled', actorId: input.actorId, reason, now
        });
      }
      for (const task of snapshot.tasks) {
        if (task.id === currentTask?.id || !['pending', 'ready', 'blocked'].includes(task.status)) continue;
        snapshot = this.transitionOrchestrationTask({
          runId: input.runId, taskId: task.id, expectedRevision: task.revision,
          nextStatus: 'cancelled', actorId: input.actorId, reason, now
        });
      }
      snapshot = this.getOrchestrationSnapshot(input.runId)!;
      this.transitionOrchestrationRun({
        runId: input.runId, expectedRevision: snapshot.run.revision,
        nextStatus: 'cancelled', actorId: input.actorId, reason, now
      });
    });
    cancel();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  markOrchestrationRecoveryRequired(input: {
    runId: string;
    actorId?: string;
    reason: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const recover = this.db.transaction(() => {
      let snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (['failed', 'cancelled', 'awaiting_approval', 'recovery_required'].includes(snapshot.run.status)) return;
      const task = snapshot.run.currentTaskId
        ? snapshot.tasks.find(item => item.id === snapshot!.run.currentTaskId)
        : undefined;
      if (task && ['running', 'submitted'].includes(task.status)) {
        const activeAttempt = [...snapshot.attempts].reverse().find(attempt =>
          attempt.taskId === task.id && ['starting', 'running', 'submitted'].includes(attempt.status));
        if (activeAttempt) {
          this.db.prepare("UPDATE orchestration_attempts SET status = 'recovery_required', failure_reason = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND id = ? AND status IN ('starting', 'running', 'submitted')")
            .run(input.reason, now, workspaceId, input.runId, activeAttempt.id);
        }
        snapshot = this.transitionOrchestrationTask({
          runId: input.runId, taskId: task.id, expectedRevision: task.revision,
          nextStatus: 'blocked', actorId: input.actorId ?? 'orchestrator', reason: input.reason, now
        });
      }
      const latest = this.getOrchestrationSnapshot(input.runId)!;
      const nextStatus = latest.run.status === 'planning' ? 'blocked' : 'recovery_required';
      this.transitionOrchestrationRun({
        runId: input.runId, expectedRevision: latest.run.revision,
        nextStatus, actorId: input.actorId ?? 'orchestrator', reason: input.reason,
        clearCurrentTaskId: Boolean(task), now
      });
    });
    recover();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  settleOrchestrationRecoveryAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    actorId?: string;
    reason: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const settle = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.status !== 'recovery_required') {
        throw new Error('This build no longer has an interrupted attempt to reconcile.');
      }
      const task = snapshot.tasks.find(item => item.id === input.taskId);
      if (!task || task.status !== 'blocked') throw new Error('The interrupted task is no longer waiting for recovery.');
      const attempt = snapshot.attempts.find(item => item.id === input.attemptId && item.taskId === task.id);
      if (!attempt || attempt.status !== 'recovery_required') throw new Error('The saved attempt has already been reconciled.');
      const updated = this.db.prepare("UPDATE orchestration_attempts SET status = 'failed', failure_reason = ?, completed_at = COALESCE(completed_at, ?) WHERE workspace_id = ? AND run_id = ? AND id = ? AND status = 'recovery_required'")
        .run(input.reason, now, workspaceId, input.runId, input.attemptId);
      if (updated.changes !== 1) throw new Error('The interrupted attempt changed before recovery was recorded.');
      this.appendOrchestrationEvent(input.runId, 'recovery_attempt_settled', {
        taskId: input.taskId,
        attemptId: input.attemptId,
        action: 'retry',
        reason: input.reason
      }, input.actorId ?? 'orchestrator', now);
    });
    settle();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  listOrchestrationEvents(runId: string, afterId = 0, limit = 100): OrchestrationEventRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare('SELECT * FROM orchestration_events WHERE workspace_id = ? AND run_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(this.workspaceId(), runId, Math.max(0, Math.trunc(afterId)), boundedLimit) as any[];
    return rows.map(orchestrationEventFromRow);
  }

  /** Events awaiting a post-commit realtime notification, across local workspaces. */
  listDueOrchestrationOutbox(now = new Date().toISOString(), limit = 100): OrchestrationOutboxDeliveryRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT outbox.workspace_id, outbox.run_id, outbox.event_id, outbox.attempts,
        events.run_sequence, events.event_type, events.created_at
      FROM orchestration_outbox AS outbox
      JOIN orchestration_events AS events
        ON events.workspace_id = outbox.workspace_id AND events.run_id = outbox.run_id AND events.event_id = outbox.event_id
      WHERE outbox.delivered_at IS NULL AND outbox.next_attempt_at <= ?
      ORDER BY outbox.id ASC LIMIT ?`)
      .all(now, boundedLimit) as any[];
    return rows.map(row => ({
      workspaceId: row.workspace_id,
      runId: row.run_id,
      eventId: row.event_id,
      sequence: row.run_sequence,
      type: row.event_type,
      createdAt: row.created_at,
      attempts: row.attempts
    }));
  }

  markOrchestrationOutboxDelivered(workspaceId: string, eventId: string, now = new Date().toISOString()): boolean {
    const result = this.db.prepare(`UPDATE orchestration_outbox
      SET delivered_at = ?, last_error = NULL
      WHERE workspace_id = ? AND event_id = ? AND delivered_at IS NULL`)
      .run(now, workspaceId, eventId);
    return result.changes === 1;
  }

  retryOrchestrationOutbox(input: {
    workspaceId: string;
    eventId: string;
    nextAttemptAt: string;
    errorCode: string;
  }): boolean {
    const result = this.db.prepare(`UPDATE orchestration_outbox
      SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
      WHERE workspace_id = ? AND event_id = ? AND delivered_at IS NULL`)
      .run(input.nextAttemptAt, input.errorCode.slice(0, 120), input.workspaceId, input.eventId);
    return result.changes === 1;
  }

  transitionOrchestrationTask(input: {
    runId: string;
    taskId: string;
    expectedRevision: number;
    nextStatus: OrchestrationTaskStatus;
    actorId?: string;
    reason?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const transition = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (['failed', 'cancelled', 'awaiting_approval'].includes(snapshot.run.status)) {
        throw new Error(`Cannot change a task while the build is ${snapshot.run.status}.`);
      }
      if (input.nextStatus === 'running') throw new Error('Use startOrchestrationAttempt to start a task.');
      const task = snapshot.tasks.find(item => item.id === input.taskId);
      if (!task) throw new Error('Orchestration task not found.');
      const acceptedDependencies = new Set(snapshot.tasks.filter(item => item.status === 'accepted').map(item => item.id));
      const updated = transitionTask(task, input.nextStatus, input.expectedRevision, acceptedDependencies, now);
      const result = this.db.prepare('UPDATE orchestration_tasks SET status = ?, revision = ?, attempt_count = ?, accepted_revision = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND revision = ?')
        .run(updated.status, updated.revision, updated.attemptCount, updated.acceptedRevision ?? null, now,
          workspaceId, input.runId, input.taskId, input.expectedRevision);
      if (result.changes !== 1) throw new Error('Task changed while the transition was being committed.');
      this.appendOrchestrationEvent(input.runId, `task_${updated.status}`, {
        taskId: input.taskId,
        taskRevision: updated.revision,
        reason: input.reason
      }, input.actorId, now);

      if (updated.status === 'accepted') {
        const accepted = new Set([...acceptedDependencies, updated.id]);
        for (const dependent of snapshot.tasks) {
          if (dependent.status !== 'pending' || !dependent.dependsOn.every(id => accepted.has(id))) continue;
          const ready = transitionTask(dependent, 'ready', dependent.revision, accepted, now);
          this.db.prepare('UPDATE orchestration_tasks SET status = ?, revision = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND revision = ?')
            .run('ready', ready.revision, now, workspaceId, input.runId, dependent.id, dependent.revision);
          this.appendOrchestrationEvent(input.runId, 'task_ready', {
            taskId: dependent.id,
            taskRevision: ready.revision,
            causeTaskId: updated.id
          }, input.actorId, now);
        }
      }

      if (['accepted', 'failed', 'blocked', 'cancelled'].includes(updated.status)) {
        this.db.prepare('UPDATE orchestration_runs SET current_task_id = NULL, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND current_task_id = ?')
          .run(now, workspaceId, input.runId, input.taskId);
      }
    });
    transition();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  startOrchestrationAttempt(input: {
    runId: string;
    taskId: string;
    expectedTaskRevision: number;
    attemptId: string;
    startingCommit?: string;
    personaHash?: string;
    modelProvider?: string;
    modelName?: string;
    contextManifest: Record<string, unknown>;
    actorId?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const start = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId) {
        throw new Error('The build is not ready to start another specialist task.');
      }
      const selected = selectNextReadyTask(snapshot.run.plan, snapshot.tasks);
      if (!selected || selected.id !== input.taskId) throw new Error('Only the next ready task can be dispatched.');
      const running = transitionTask(selected, 'running', input.expectedTaskRevision,
        new Set(snapshot.tasks.filter(task => task.status === 'accepted').map(task => task.id)), now);
      const update = this.db.prepare('UPDATE orchestration_tasks SET status = ?, revision = ?, attempt_count = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND status = ? AND revision = ?')
        .run('running', running.revision, running.attemptCount, now, workspaceId, input.runId,
          input.taskId, 'ready', input.expectedTaskRevision);
      if (update.changes !== 1) throw new Error('Task changed before its attempt could start.');
      this.db.prepare('INSERT INTO orchestration_attempts (id, workspace_id, run_id, task_id, attempt_number, agent_id, starting_commit, persona_hash, model_provider, model_name, context_manifest_json, status, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.attemptId, workspaceId, input.runId, input.taskId, running.attemptCount,
          selected.ownerAgentId, input.startingCommit ?? null, input.personaHash ?? null,
          input.modelProvider ?? null, input.modelName ?? null, JSON.stringify(input.contextManifest), 'starting', now, now);
      const runUpdate = this.db.prepare("UPDATE orchestration_runs SET current_task_id = ?, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND revision = ? AND current_task_id IS NULL AND status = 'executing'")
        .run(input.taskId, now, workspaceId, input.runId, snapshot.run.revision);
      if (runUpdate.changes !== 1) throw new Error('Build changed before its specialist attempt could start.');
      this.appendOrchestrationEvent(input.runId, 'attempt_starting', {
        taskId: input.taskId,
        attemptId: input.attemptId,
        attemptNumber: running.attemptCount,
        agentId: selected.ownerAgentId,
        startingCommit: input.startingCommit
      }, input.actorId, now);
    });
    start();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  bindOrchestrationAttempt(input: {
    runId: string;
    attemptId: string;
    prototypeRunId: string;
    actorId?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const bind = this.db.transaction(() => {
      const attempt = this.db.prepare('SELECT status, prototype_run_id FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? AND id = ?')
        .get(workspaceId, input.runId, input.attemptId) as any;
      if (attempt?.status === 'running' && attempt.prototype_run_id === input.prototypeRunId) return;
      const result = this.db.prepare("UPDATE orchestration_attempts SET prototype_run_id = ?, status = 'running' WHERE workspace_id = ? AND run_id = ? AND id = ? AND status = 'starting' AND prototype_run_id IS NULL")
        .run(input.prototypeRunId, workspaceId, input.runId, input.attemptId);
      if (result.changes !== 1) throw new Error('Attempt is no longer waiting for a runner process.');
      this.appendOrchestrationEvent(input.runId, 'attempt_running', {
        attemptId: input.attemptId,
        prototypeRunId: input.prototypeRunId
      }, input.actorId, now);
    });
    bind();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  failOrchestrationAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    reason: string;
    actorId?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const fail = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== input.taskId) {
        throw new Error('This task attempt is no longer eligible to change orchestration state.');
      }
      const attempt = this.db.prepare("SELECT status FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ?")
        .get(workspaceId, input.runId, input.taskId, input.attemptId) as any;
      if (!attempt || !['starting', 'running'].includes(attempt.status)) {
        throw new Error('Only a starting or running attempt can fail.');
      }
      const result = this.db.prepare("UPDATE orchestration_attempts SET status = 'failed', failure_reason = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ? AND status = ?")
        .run(input.reason, now, workspaceId, input.runId, input.taskId, input.attemptId, attempt.status);
      if (result.changes !== 1) throw new Error('Attempt changed before its failure was saved.');
      this.transitionOrchestrationTask({
        runId: input.runId,
        taskId: input.taskId,
        expectedRevision: input.expectedTaskRevision,
        nextStatus: 'failed',
        actorId: input.actorId,
        reason: input.reason,
        now
      });
      this.appendOrchestrationEvent(input.runId, 'attempt_failed', {
        taskId: input.taskId,
        attemptId: input.attemptId,
        reason: input.reason
      }, input.actorId, now);
    });
    fail();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  cancelOrchestrationAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    actorId?: string;
    reason?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const cancel = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== input.taskId) {
        throw new Error('This task attempt is no longer eligible to change orchestration state.');
      }
      const attempt = this.db.prepare("SELECT status FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ?")
        .get(workspaceId, input.runId, input.taskId, input.attemptId) as any;
      if (!attempt || !['starting', 'running'].includes(attempt.status)) {
        throw new Error('Only a starting or running attempt can be cancelled.');
      }
      const result = this.db.prepare("UPDATE orchestration_attempts SET status = 'cancelled', failure_reason = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ? AND status = ?")
        .run(input.reason ?? 'Specialist process was cancelled.', now,
          workspaceId, input.runId, input.taskId, input.attemptId, attempt.status);
      if (result.changes !== 1) throw new Error('Attempt changed before cancellation was saved.');
      this.transitionOrchestrationTask({
        runId: input.runId,
        taskId: input.taskId,
        expectedRevision: input.expectedTaskRevision,
        nextStatus: 'cancelled',
        actorId: input.actorId,
        reason: input.reason ?? 'Specialist process was cancelled.',
        now
      });
      const afterTask = this.getOrchestrationSnapshot(input.runId)!;
      this.transitionOrchestrationRun({
        runId: input.runId,
        expectedRevision: afterTask.run.revision,
        nextStatus: 'cancelled',
        actorId: input.actorId,
        reason: input.reason ?? 'Specialist process was cancelled.',
        now
      });
      this.appendOrchestrationEvent(input.runId, 'attempt_cancelled', {
        taskId: input.taskId,
        attemptId: input.attemptId,
        reason: input.reason
      }, input.actorId, now);
    });
    cancel();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  submitOrchestrationAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    result: Record<string, unknown>;
    resultCommit?: string;
    actorId?: string;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const submit = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== input.taskId) {
        throw new Error('This task attempt is no longer eligible to submit work.');
      }
      const attempt = this.db.prepare('SELECT status, attempt_number FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ?')
        .get(workspaceId, input.runId, input.taskId, input.attemptId) as any;
      if (!attempt || attempt.status !== 'running') throw new Error('Only a running attempt can submit a result.');
      const serializedResult = JSON.stringify(input.result);
      if (serializedResult.length > 64 * 1024) throw new Error('The task result exceeds the 64 KB submission limit.');
      const result = this.db.prepare("UPDATE orchestration_attempts SET status = 'submitted', result_json = ?, result_commit = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ? AND status = 'running'")
        .run(serializedResult, input.resultCommit ?? null, now,
          workspaceId, input.runId, input.taskId, input.attemptId);
      if (result.changes !== 1) throw new Error('Attempt changed before its submission was saved.');
      const artifactId = randomUUID();
      const contentHash = createHash('sha256').update(serializedResult).digest('hex');
      this.db.prepare('INSERT INTO orchestration_artifacts (id, workspace_id, run_id, task_id, attempt_id, artifact_type, version, content_hash, content, metadata_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(artifactId, workspaceId, input.runId, input.taskId, input.attemptId, 'task_result', attempt.attempt_number,
          contentHash, serializedResult, JSON.stringify({ resultCommit: input.resultCommit ?? null }), 'submitted', now);
      this.transitionOrchestrationTask({
        runId: input.runId,
        taskId: input.taskId,
        expectedRevision: input.expectedTaskRevision,
        nextStatus: 'submitted',
        actorId: input.actorId,
        reason: 'Specialist submitted a structured result.',
        now
      });
      this.appendOrchestrationEvent(input.runId, 'attempt_submitted', {
        taskId: input.taskId,
        attemptId: input.attemptId,
        artifactId,
        contentHash
      }, input.actorId, now);
    });
    submit();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  acceptOrchestrationAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    acceptedBy: string;
    evidence: Record<string, unknown>;
    canonicalReport?: Record<string, unknown>;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    const accept = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== input.taskId) {
        throw new Error('This task attempt is no longer eligible for acceptance.');
      }
      const attempt = this.db.prepare('SELECT status, result_json FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ?')
        .get(workspaceId, input.runId, input.taskId, input.attemptId) as any;
      if (!attempt || attempt.status !== 'submitted') throw new Error('Only a submitted attempt can be accepted.');
      const resultPayload = parseJson<Record<string, unknown>>(attempt.result_json, {});
      const acceptedResult = JSON.stringify({
        ...resultPayload,
        ...(input.canonicalReport ? { agentReport: input.canonicalReport } : {}),
        acceptanceEvidence: input.evidence
      });
      const updated = this.db.prepare("UPDATE orchestration_attempts SET status = 'accepted', result_json = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ? AND status = 'submitted'")
        .run(acceptedResult, now,
          workspaceId, input.runId, input.taskId, input.attemptId);
      if (updated.changes !== 1) throw new Error('Attempt changed before acceptance was saved.');
      this.db.prepare("UPDATE orchestration_artifacts SET status = 'accepted' WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND attempt_id = ? AND status = 'submitted'")
        .run(workspaceId, input.runId, input.taskId, input.attemptId);
      this.transitionOrchestrationTask({
        runId: input.runId,
        taskId: input.taskId,
        expectedRevision: input.expectedTaskRevision,
        nextStatus: 'accepted',
        actorId: input.acceptedBy,
        reason: 'Submission passed its acceptance gate.',
        now
      });
      const candidateFindings = this.db.prepare("SELECT id, evidence FROM orchestration_findings WHERE workspace_id = ? AND run_id = ? AND correction_task_id = ? AND status = 'open'")
        .all(workspaceId, input.runId, input.taskId) as Array<{ id: string; evidence: string }>;
      const deterministicFindingIds = candidateFindings
        .filter(finding => parseJson<Record<string, unknown>>(finding.evidence, {}).origin !== 'independent_review')
        .map(finding => finding.id);
      if (deterministicFindingIds.length) {
        const placeholders = deterministicFindingIds.map(() => '?').join(', ');
        this.db.prepare(`UPDATE orchestration_findings SET status = 'resolved', resolved_at = ? WHERE workspace_id = ? AND run_id = ? AND id IN (${placeholders})`)
          .run(now, workspaceId, input.runId, ...deterministicFindingIds);
      }
      this.appendOrchestrationEvent(input.runId, 'attempt_accepted', {
        taskId: input.taskId,
        attemptId: input.attemptId,
        acceptedBy: input.acceptedBy,
        evidence: input.evidence
      }, input.acceptedBy, now);
    });
    accept();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  /** Accepts a completed read-only review and atomically records any routed correction plan. */
  acceptOrchestrationReviewOutcome(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    expectedPlanVersion: number;
    acceptedBy: string;
    evidence: Record<string, unknown>;
    canonicalReport?: Record<string, unknown>;
    plan: OrchestrationPlan;
    addedTasks: readonly OrchestrationTaskRecord[];
    findings: readonly PersistedReviewFinding[];
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    if (input.findings.length > 20) throw new Error('A review can record at most 20 findings.');
    const accept = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      const existingAttempt = snapshot.attempts.find(attempt => attempt.id === input.attemptId);
      if (existingAttempt?.status === 'accepted') return;
      if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== input.taskId ||
          snapshot.run.planVersion !== input.expectedPlanVersion) {
        throw new Error('This review is no longer eligible to accept or amend the plan.');
      }
      const reviewTask = snapshot.tasks.find(task => task.id === input.taskId);
      if (!reviewTask || reviewTask.kind !== 'review' || reviewTask.revision !== input.expectedTaskRevision) {
        throw new Error('Only the current revision of a submitted review task can be accepted.');
      }
      const attempt = this.db.prepare('SELECT status, result_json FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ?')
        .get(workspaceId, input.runId, input.taskId, input.attemptId) as { status: string; result_json: string | null } | undefined;
      if (!attempt || attempt.status !== 'submitted') throw new Error('Only a submitted review attempt can be accepted.');

      const submitted = parseJson<Record<string, unknown>>(attempt.result_json, {});
      const agentReport = input.canonicalReport ?? (submitted.agentReport && typeof submitted.agentReport === 'object'
        ? submitted.agentReport as Record<string, unknown>
        : undefined);
      const reportedFindings = agentReport?.reviewFindings;
      if (!Array.isArray(reportedFindings) || reportedFindings.length !== input.findings.length) {
        throw new Error('The accepted review findings do not match the submitted reviewer report.');
      }
      const plan = parseOrchestrationPlan(input.plan);
      if (plan.tasks.length > MAX_PLAN_TASKS || plan.goal !== snapshot.run.plan.goal ||
          JSON.stringify(plan.exclusions) !== JSON.stringify(snapshot.run.plan.exclusions) ||
          JSON.stringify(plan.requirements) !== JSON.stringify(snapshot.run.plan.requirements)) {
        throw new Error('A review correction cannot change the authorized goal, exclusions, requirements, or task ceiling.');
      }
      const currentPlanTasks = new Map(snapshot.run.plan.tasks.map(task => [task.id, task]));
      const nextPlanTasks = new Map(plan.tasks.map(task => [task.id, task]));
      const addedPlanTasks = plan.tasks.filter(task => !currentPlanTasks.has(task.id));
      if (snapshot.run.plan.tasks.some(task => !nextPlanTasks.has(task.id)) || addedPlanTasks.length !== input.addedTasks.length) {
        throw new Error('A review correction must preserve all prior task identities and add only its explicit correction tasks.');
      }
      const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
      for (const [taskId, oldTask] of currentPlanTasks) {
        const nextTask = nextPlanTasks.get(taskId)!;
        if (oldTask.kind === 'validation') {
          const { required: _oldRequired, ...oldStable } = oldTask;
          const { required: nextRequired, ...nextStable } = nextTask;
          const requiredChangedSafely = oldTask.required !== nextRequired && !(oldTask.required && nextRequired === false);
          if (!same(oldStable, nextStable) || requiredChangedSafely) {
            throw new Error('A review correction may only retire a prior validation gate; it cannot rewrite its contract.');
          }
        } else if (oldTask.kind === 'delivery') {
          const { dependsOn: _oldDependencies, ...oldStable } = oldTask;
          const { dependsOn: _newDependencies, ...nextStable } = nextTask;
          if (!same(oldStable, nextStable)) throw new Error('A review correction cannot rewrite a delivery task.');
        } else if (!same(oldTask, nextTask)) {
          throw new Error(`A review correction cannot rewrite prior task ${taskId}.`);
        }
      }
      const newTaskRecords = new Map(input.addedTasks.map(task => [task.id, task]));
      if (newTaskRecords.size !== input.addedTasks.length || addedPlanTasks.some(definition => !newTaskRecords.has(definition.id))) {
        throw new Error('The correction-task records do not match the amended plan.');
      }
      for (const definition of addedPlanTasks) {
        const record = newTaskRecords.get(definition.id)!;
        const { status: _status, revision: _revision, attemptCount: _attemptCount, acceptedRevision: _acceptedRevision,
          updatedAt: _updatedAt, correctionOfTaskId: _correctionOfTaskId, correctionCycle: _correctionCycle, ...recordDefinition } = record;
        if (!same(recordDefinition, definition)) throw new Error(`Correction task ${definition.id} does not match its plan definition.`);
      }
      const planIssues = validateOrchestrationPlan(plan, this.getAgents().filter(agent => !agent.isArchived));
      if (planIssues.length) throw new Error(`The amended review plan is invalid: ${planIssues.map(issue => issue.detail).join(' ')}`);

      for (const finding of input.findings) {
        const target = snapshot.tasks.find(task => task.id === finding.taskId);
        if (!target || target.status !== 'accepted' || !['database', 'backend', 'frontend', 'mobile'].includes(target.kind) ||
            finding.sourceTaskId !== input.taskId ||
            (finding.correctionTaskId && !newTaskRecords.has(finding.correctionTaskId)) ||
            (['blocking', 'critical'].includes(finding.severity) && !finding.correctionTaskId)) {
          throw new Error('Every blocking review finding must route to an explicit correction task owned by its accepted code-task owner.');
        }
      }

      const hasAmendment = addedPlanTasks.length > 0;
      if (hasAmendment && plan.tasks.length <= snapshot.run.plan.tasks.length) {
        throw new Error('The amended plan does not contain its correction tasks.');
      }
      const nextPlanVersion = snapshot.run.planVersion + (hasAmendment ? 1 : 0);
      const acceptedResult = JSON.stringify({
        ...submitted,
        ...(input.canonicalReport ? { agentReport: input.canonicalReport } : {}),
        acceptanceEvidence: input.evidence
      });
      const attemptUpdate = this.db.prepare("UPDATE orchestration_attempts SET status = 'accepted', result_json = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ? AND status = 'submitted'")
        .run(acceptedResult, now, workspaceId, input.runId, input.taskId, input.attemptId);
      if (attemptUpdate.changes !== 1) throw new Error('Review attempt changed before acceptance was saved.');
      this.db.prepare("UPDATE orchestration_artifacts SET status = 'accepted' WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND attempt_id = ? AND status = 'submitted'")
        .run(workspaceId, input.runId, input.taskId, input.attemptId);
      const taskUpdate = this.db.prepare("UPDATE orchestration_tasks SET status = 'accepted', revision = revision + 1, accepted_revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND plan_version = ? AND task_id = ? AND status = 'submitted' AND revision = ?")
        .run(now, workspaceId, input.runId, input.expectedPlanVersion, input.taskId, input.expectedTaskRevision);
      if (taskUpdate.changes !== 1) throw new Error('Review task changed before acceptance was saved.');

      if (hasAmendment) {
        this.db.prepare('INSERT INTO orchestration_plans (workspace_id, run_id, version, schema_version, plan_json, source, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(workspaceId, input.runId, nextPlanVersion, plan.schemaVersion, JSON.stringify(plan), 'model', now, now);
        this.db.prepare('UPDATE orchestration_tasks SET plan_version = ? WHERE workspace_id = ? AND run_id = ? AND plan_version = ?')
          .run(nextPlanVersion, workspaceId, input.runId, input.expectedPlanVersion);
        const updateDefinition = this.db.prepare(`UPDATE orchestration_tasks SET title = ?, description = ?, kind = ?, owner_agent_id = ?, depends_on_json = ?, requirement_ids_json = ?, acceptance_json = ?, checks_json = ?, scope_json = ?, required = ?
          WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND plan_version = ?`);
        for (const definition of plan.tasks) {
          if (!currentPlanTasks.has(definition.id)) continue;
          const changed = updateDefinition.run(definition.title, definition.description, definition.kind, definition.ownerAgentId,
            JSON.stringify(definition.dependsOn), JSON.stringify(definition.requirementIds), JSON.stringify(definition.acceptanceCriteria),
            JSON.stringify(definition.requiredChecks), JSON.stringify(definition.scope), definition.required ? 1 : 0,
            workspaceId, input.runId, definition.id, nextPlanVersion);
          if (changed.changes !== 1) throw new Error(`Task ${definition.id} disappeared while the review plan was being amended.`);
        }
        const insertTask = this.db.prepare('INSERT INTO orchestration_tasks (workspace_id, run_id, plan_version, task_id, title, description, kind, owner_agent_id, depends_on_json, requirement_ids_json, acceptance_json, checks_json, scope_json, required, status, revision, attempt_count, accepted_revision, correction_of_task_id, correction_cycle, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const task of input.addedTasks) {
          insertTask.run(workspaceId, input.runId, nextPlanVersion, task.id, task.title, task.description, task.kind,
            task.ownerAgentId, JSON.stringify(task.dependsOn), JSON.stringify(task.requirementIds), JSON.stringify(task.acceptanceCriteria),
            JSON.stringify(task.requiredChecks), JSON.stringify(task.scope), task.required ? 1 : 0, task.status,
            0, 0, null, task.correctionOfTaskId ?? null, task.correctionCycle ?? null, now);
        }
      }

      const blockingFinding = input.findings.some(finding => ['blocking', 'critical'].includes(finding.severity));
      if (!blockingFinding) {
        const ancestorIds = new Set<string>();
        const visit = (taskId: string) => {
          for (const dependencyId of snapshot.tasks.find(task => task.id === taskId)?.dependsOn ?? []) {
            if (ancestorIds.has(dependencyId)) continue;
            ancestorIds.add(dependencyId);
            visit(dependencyId);
          }
        };
        visit(input.taskId);
        const correctionIds = snapshot.tasks
          .filter(task => ancestorIds.has(task.id) && task.correctionOfTaskId)
          .map(task => task.id);
        if (correctionIds.length) {
          const placeholders = correctionIds.map(() => '?').join(', ');
          this.db.prepare(`UPDATE orchestration_findings SET status = 'resolved', resolved_at = ? WHERE workspace_id = ? AND run_id = ? AND correction_task_id IN (${placeholders}) AND status = 'open'`)
            .run(now, workspaceId, input.runId, ...correctionIds);
        }
      }

      const findingRows = this.db.prepare('INSERT INTO orchestration_findings (id, workspace_id, run_id, task_id, source_task_id, severity, requirement_id, path, evidence, status, correction_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const findingIds: string[] = [];
      for (const finding of input.findings) {
        const id = randomUUID();
        findingIds.push(id);
        findingRows.run(id, workspaceId, input.runId, finding.taskId, finding.sourceTaskId, finding.severity,
          finding.requirementId ?? null, finding.path ?? null, JSON.stringify(finding.evidence), 'open', finding.correctionTaskId ?? null, now);
      }

      const nextDefinitions = new Map(plan.tasks.map(task => [task.id, task]));
      const acceptedTaskIds = new Set(snapshot.tasks.filter(task => task.status === 'accepted').map(task => task.id));
      acceptedTaskIds.add(input.taskId);
      for (const task of snapshot.tasks) {
        if (task.id === input.taskId || task.status !== 'pending') continue;
        const definition = nextDefinitions.get(task.id);
        if (!definition || !definition.dependsOn.every(dependencyId => acceptedTaskIds.has(dependencyId))) continue;
        const changed = this.db.prepare("UPDATE orchestration_tasks SET status = 'ready', revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND status = 'pending' AND revision = ?")
          .run(now, workspaceId, input.runId, task.id, task.revision);
        if (changed.changes === 1) this.appendOrchestrationEvent(input.runId, 'task_ready', {
          taskId: task.id, taskRevision: task.revision + 1, causeTaskId: input.taskId
        }, input.acceptedBy, now);
      }
      const runChanged = this.db.prepare('UPDATE orchestration_runs SET plan_version = ?, current_task_id = NULL, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = \'executing\' AND current_task_id = ? AND plan_version = ? AND revision = ?')
        .run(nextPlanVersion, now, workspaceId, input.runId, input.taskId, input.expectedPlanVersion, snapshot.run.revision);
      if (runChanged.changes !== 1) throw new Error('The build changed before the review result could be committed.');
      this.appendOrchestrationEvent(input.runId, 'task_accepted', {
        taskId: input.taskId, attemptId: input.attemptId, acceptedBy: input.acceptedBy, evidence: input.evidence
      }, input.acceptedBy, now);
      if (hasAmendment) this.appendOrchestrationEvent(input.runId, 'plan_amended', {
        planVersion: nextPlanVersion, reason: 'Independent review requested targeted corrections.',
        addedTaskIds: input.addedTasks.map(task => task.id),
        supersedesValidationTaskIds: [...currentPlanTasks.values()].filter(task => task.kind === 'validation' && task.required).map(task => task.id)
      }, input.acceptedBy, now);
      this.appendOrchestrationEvent(input.runId, 'review_outcome_recorded', {
        taskId: input.taskId, attemptId: input.attemptId, findingIds,
        correctionTaskIds: [...new Set(input.findings.flatMap(finding => finding.correctionTaskId ? [finding.correctionTaskId] : []))]
      }, input.acceptedBy, now);
    });
    accept();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  /** Append a versioned owner-correction chain after observed final checks fail. */
  appendOrchestrationFinalValidationAmendment(input: {
    runId: string;
    expectedRunRevision: number;
    expectedPlanVersion: number;
    actorId: string;
    evidence: Record<string, unknown>;
    plan: OrchestrationPlan;
    addedTasks: readonly OrchestrationTaskRecord[];
    findings: readonly PersistedReviewFinding[];
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    if (input.findings.length > 20) throw new Error('Final validation can route at most 20 code-owner findings.');
    const amend = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.status !== 'blocked' || snapshot.run.currentTaskId ||
          snapshot.run.revision !== input.expectedRunRevision || snapshot.run.planVersion !== input.expectedPlanVersion) {
        throw new Error('The build changed since final validation was reviewed. Refresh before creating correction tasks.');
      }
      if (!snapshot.tasks.filter(task => task.required).every(task => task.status === 'accepted')) {
        throw new Error('Final-validation corrections require all existing required tasks to remain accepted.');
      }
      const latestValidation = this.listOrchestrationEvents(input.runId, 0, 500).slice().reverse().find(event =>
        ['run_blocked', 'run_recovery_required'].includes(event.type) && event.payload.evidence &&
        typeof event.payload.evidence === 'object' &&
        (event.payload.evidence as Record<string, unknown>).validationVersion === 1);
      if (!latestValidation || !isDeepStrictEqual(latestValidation.payload.evidence, input.evidence)) {
        throw new Error('The saved final-check evidence changed. Refresh the recovery details before assigning corrections.');
      }
      const evidence = input.evidence;
      const checks = evidence.checks && typeof evidence.checks === 'object' ? evidence.checks as Record<string, unknown> : undefined;
      const observed = Array.isArray(checks?.observed) ? checks.observed as Array<Record<string, unknown>> : [];
      if (evidence.check !== undefined || checks?.status !== 'failed' || !observed.some(check => check.exitCode !== 0 || check.signal != null)) {
        throw new Error('This blocker is not a failed final repository check that can be routed safely. Review the workspace and saved evidence first.');
      }

      const plan = parseOrchestrationPlan(input.plan);
      if (plan.tasks.length > MAX_PLAN_TASKS || plan.goal !== snapshot.run.plan.goal ||
          JSON.stringify(plan.exclusions) !== JSON.stringify(snapshot.run.plan.exclusions) ||
          JSON.stringify(plan.requirements) !== JSON.stringify(snapshot.run.plan.requirements)) {
        throw new Error('A final-validation correction cannot change the approved goal, exclusions, requirements, or task ceiling.');
      }
      const currentPlanTasks = new Map(snapshot.run.plan.tasks.map(task => [task.id, task]));
      const nextPlanTasks = new Map(plan.tasks.map(task => [task.id, task]));
      const addedPlanTasks = plan.tasks.filter(task => !currentPlanTasks.has(task.id));
      if (snapshot.run.plan.tasks.some(task => !nextPlanTasks.has(task.id)) || addedPlanTasks.length !== input.addedTasks.length) {
        throw new Error('A final-validation correction must preserve every previous task and add only its owner, review, and validation tasks.');
      }
      const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
      for (const [taskId, oldTask] of currentPlanTasks) {
        const nextTask = nextPlanTasks.get(taskId)!;
        if (oldTask.kind === 'validation') {
          const { required: _oldRequired, ...oldStable } = oldTask;
          const { required: nextRequired, ...nextStable } = nextTask;
          if (!same(oldStable, nextStable) || (oldTask.required !== nextRequired && !(oldTask.required && nextRequired === false))) {
            throw new Error('A correction plan may retire an old validation gate but cannot rewrite its contract.');
          }
        } else if (oldTask.kind === 'delivery') {
          const { dependsOn: _oldDependencies, ...oldStable } = oldTask;
          const { dependsOn: _newDependencies, ...nextStable } = nextTask;
          if (!same(oldStable, nextStable)) throw new Error('A correction plan cannot rewrite a delivery task.');
        } else if (!same(oldTask, nextTask)) {
          throw new Error(`A final-validation correction cannot rewrite prior task ${taskId}.`);
        }
      }
      const newTaskRecords = new Map(input.addedTasks.map(task => [task.id, task]));
      if (newTaskRecords.size !== input.addedTasks.length || addedPlanTasks.some(definition => !newTaskRecords.has(definition.id))) {
        throw new Error('The correction-task records do not match the amended plan.');
      }
      for (const definition of addedPlanTasks) {
        const record = newTaskRecords.get(definition.id)!;
        const { status: _status, revision: _revision, attemptCount: _attemptCount, acceptedRevision: _acceptedRevision,
          updatedAt: _updatedAt, correctionOfTaskId: _correctionOfTaskId, correctionCycle: _correctionCycle, ...recordDefinition } = record;
        if (!same(recordDefinition, definition)) throw new Error(`Correction task ${definition.id} does not match its plan definition.`);
      }
      if (!addedPlanTasks.some(task => task.kind === 'review' && task.required) ||
          !addedPlanTasks.some(task => task.kind === 'validation' && task.required) ||
          !input.addedTasks.filter(task => ['database', 'backend', 'frontend', 'mobile'].includes(task.kind)).every(task => task.correctionOfTaskId && task.scope.includePaths.length)) {
        throw new Error('A final-validation amendment must include scoped owner corrections followed by independent review and validation gates.');
      }
      const issues = validateOrchestrationPlan(plan, this.getAgents().filter(agent => !agent.isArchived));
      if (issues.length) throw new Error(`The final-validation correction plan is invalid: ${issues.map(issue => issue.detail).join(' ')}`);

      const nextPlanVersion = snapshot.run.planVersion + 1;
      this.db.prepare('INSERT INTO orchestration_plans (workspace_id, run_id, version, schema_version, plan_json, source, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(workspaceId, input.runId, nextPlanVersion, plan.schemaVersion, JSON.stringify(plan), 'recovery', now, now);
      this.db.prepare('UPDATE orchestration_tasks SET plan_version = ? WHERE workspace_id = ? AND run_id = ? AND plan_version = ?')
        .run(nextPlanVersion, workspaceId, input.runId, input.expectedPlanVersion);
      const updateDefinition = this.db.prepare(`UPDATE orchestration_tasks SET title = ?, description = ?, kind = ?, owner_agent_id = ?, depends_on_json = ?, requirement_ids_json = ?, acceptance_json = ?, checks_json = ?, scope_json = ?, required = ?
        WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND plan_version = ?`);
      for (const definition of plan.tasks) {
        if (!currentPlanTasks.has(definition.id)) continue;
        const changed = updateDefinition.run(definition.title, definition.description, definition.kind, definition.ownerAgentId,
          JSON.stringify(definition.dependsOn), JSON.stringify(definition.requirementIds), JSON.stringify(definition.acceptanceCriteria),
          JSON.stringify(definition.requiredChecks), JSON.stringify(definition.scope), definition.required ? 1 : 0,
          workspaceId, input.runId, definition.id, nextPlanVersion);
        if (changed.changes !== 1) throw new Error(`Task ${definition.id} disappeared while the recovery plan was being amended.`);
      }
      const insertTask = this.db.prepare('INSERT INTO orchestration_tasks (workspace_id, run_id, plan_version, task_id, title, description, kind, owner_agent_id, depends_on_json, requirement_ids_json, acceptance_json, checks_json, scope_json, required, status, revision, attempt_count, accepted_revision, correction_of_task_id, correction_cycle, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const task of input.addedTasks) {
        insertTask.run(workspaceId, input.runId, nextPlanVersion, task.id, task.title, task.description, task.kind,
          task.ownerAgentId, JSON.stringify(task.dependsOn), JSON.stringify(task.requirementIds), JSON.stringify(task.acceptanceCriteria),
          JSON.stringify(task.requiredChecks), JSON.stringify(task.scope), task.required ? 1 : 0, task.status,
          0, 0, null, task.correctionOfTaskId ?? null, task.correctionCycle ?? null, now);
      }
      const findingRows = this.db.prepare('INSERT INTO orchestration_findings (id, workspace_id, run_id, task_id, source_task_id, severity, requirement_id, path, evidence, status, correction_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const finding of input.findings) {
        const target = snapshot.tasks.find(task => task.id === finding.taskId);
        const source = snapshot.tasks.find(task => task.id === finding.sourceTaskId);
        const finalValidationOrigin = finding.evidence?.origin === 'final_validation';
        if (!target || target.status !== 'accepted' || !['database', 'backend', 'frontend', 'mobile'].includes(target.kind) ||
            !source || source.status !== 'accepted' || (!finalValidationOrigin && source.kind !== 'review') ||
            (finalValidationOrigin && source.id !== target.id) ||
            !finding.correctionTaskId || !newTaskRecords.has(finding.correctionTaskId)) {
          throw new Error('Each final-check finding must identify an accepted code owner and its explicit correction task.');
        }
        findingRows.run(randomUUID(), workspaceId, input.runId, finding.taskId, finding.sourceTaskId, finding.severity,
          finding.requirementId ?? null, finding.path ?? null, JSON.stringify(finding.evidence), 'open', finding.correctionTaskId, now);
      }
      const runUpdate = this.db.prepare("UPDATE orchestration_runs SET plan_version = ?, status = 'executing', current_task_id = NULL, stopped_reason = NULL, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'blocked' AND revision = ? AND plan_version = ? AND current_task_id IS NULL")
        .run(nextPlanVersion, now, workspaceId, input.runId, input.expectedRunRevision, input.expectedPlanVersion);
      if (runUpdate.changes !== 1) throw new Error('The build changed before its final-validation correction plan could be saved.');
      this.appendOrchestrationEvent(input.runId, 'plan_amended', {
        planVersion: nextPlanVersion,
        reason: 'Final repository checks failed; scoped corrections were routed to their accepted code owners.',
        addedTaskIds: input.addedTasks.map(task => task.id),
        validationEvidence: { repository: evidence.repository, resultCommit: evidence.resultCommit, checks: evidence.checks },
        supersedesValidationTaskIds: [...currentPlanTasks.values()].filter(task => task.kind === 'validation' && task.required).map(task => task.id)
      }, input.actorId, now);
      this.appendOrchestrationEvent(input.runId, 'run_resumed', {
        reason: 'A versioned, scope-preserving correction plan was accepted after final validation failed.', planVersion: nextPlanVersion
      }, input.actorId, now);
    });
    amend();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  rejectOrchestrationAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    rejectedBy: string;
    reason: string;
    findings: Array<{
      severity: 'info' | 'warning' | 'blocking' | 'critical';
      requirementId?: string;
      path?: string;
      evidence: Record<string, unknown>;
    }>;
    now?: string;
  }): OrchestrationSnapshot {
    const workspaceId = this.workspaceId();
    const now = input.now ?? new Date().toISOString();
    if (input.findings.length > 20) throw new Error('A submission can create at most 20 findings.');
    if (!input.findings.length) throw new Error('A rejected submission must include at least one actionable finding.');
    const reject = this.db.transaction(() => {
      const snapshot = this.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== input.taskId) {
        throw new Error('This task attempt is no longer eligible for rejection.');
      }
      const attempt = this.db.prepare("SELECT status, result_json FROM orchestration_attempts WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ?")
        .get(workspaceId, input.runId, input.taskId, input.attemptId) as any;
      if (!attempt || attempt.status !== 'submitted') throw new Error('Only a submitted attempt can be rejected.');
      const priorResult = parseJson<Record<string, unknown>>(attempt.result_json, {});
      const updated = this.db.prepare("UPDATE orchestration_attempts SET status = 'rejected', result_json = ?, failure_reason = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND id = ? AND status = 'submitted'")
        .run(JSON.stringify({ ...priorResult, rejectionReason: input.reason }), input.reason, now,
          workspaceId, input.runId, input.taskId, input.attemptId);
      if (updated.changes !== 1) throw new Error('Attempt changed before rejection was saved.');
      this.db.prepare("UPDATE orchestration_artifacts SET status = 'rejected' WHERE workspace_id = ? AND run_id = ? AND task_id = ? AND attempt_id = ? AND status = 'submitted'")
        .run(workspaceId, input.runId, input.taskId, input.attemptId);
      this.transitionOrchestrationTask({
        runId: input.runId,
        taskId: input.taskId,
        expectedRevision: input.expectedTaskRevision,
        nextStatus: 'failed',
        actorId: input.rejectedBy,
        reason: input.reason,
        now
      });
      const findingRows = this.db.prepare('INSERT INTO orchestration_findings (id, workspace_id, run_id, task_id, source_task_id, severity, requirement_id, path, evidence, status, correction_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const findingIds: string[] = [];
      for (const finding of input.findings) {
        const id = randomUUID();
        findingIds.push(id);
        findingRows.run(id, workspaceId, input.runId, input.taskId, input.taskId, finding.severity,
          finding.requirementId ?? null, finding.path ?? null, JSON.stringify(finding.evidence), 'open', input.taskId, now);
      }
      const afterTask = this.getOrchestrationSnapshot(input.runId)!;
      const blocked = this.transitionOrchestrationRun({
        runId: input.runId,
        expectedRevision: afterTask.run.revision,
        nextStatus: 'blocked',
        actorId: input.rejectedBy,
        reason: input.reason,
        now
      });
      this.appendOrchestrationEvent(input.runId, 'attempt_rejected', {
        taskId: input.taskId,
        attemptId: input.attemptId,
        reason: input.reason,
        findingIds
      }, input.rejectedBy, now);
      return blocked;
    });
    reject();
    return this.getOrchestrationSnapshot(input.runId)!;
  }

  getSquadRun(id: string): SquadRun | undefined {
    const row = this.db.prepare('SELECT * FROM squad_runs WHERE id = ? AND workspace_id = ?').get(id, this.workspaceId()) as any;
    return row ? squadRunFromRow(row) : undefined;
  }

  saveSquadRun(run: SquadRun): SquadRun {
    this.db.prepare(`
      INSERT OR REPLACE INTO squad_runs
        (id, workspace_id, squad_id, issue_id, project_id, branch_name, member_agent_ids,
         current_member_index, status, mission, plan, member_assignments, stopped_reason, created_at, updated_at)
      VALUES
        (@id, @workspaceId, @squadId, @issueId, @projectId, @branchName, @memberAgentIds,
         @currentMemberIndex, @status, @mission, @plan, @memberAssignments, @stoppedReason, @createdAt, @updatedAt)
    `).run({
      ...run,
      workspaceId: this.workspaceId(),
      memberAgentIds: JSON.stringify(run.memberAgentIds || []),
      plan: JSON.stringify(run.plan || []),
      memberAssignments: JSON.stringify(run.memberAssignments || []),
      stoppedReason: run.stoppedReason ?? null
    });
    return run;
  }

  /** The member runs of a squad run, in execution order. */
  // --- Remote actions (audit) ---

  /**
   * Append one thing done to a remote.
   *
   * Never throws. An audit write failing must not take down the push it was
   * describing — the push already happened, and losing the record of it is the
   * lesser loss. Written from two processes: the daemon, and the MCP server
   * that runs as a grandchild of it. WAL and the busy timeout set in
   * initPragmas are what make that safe.
   */
  recordRemoteAction(action: Omit<RemoteAction, 'id' | 'createdAt'> & Partial<Pick<RemoteAction, 'id' | 'createdAt'>>): void {
    try {
      const createdAt = action.createdAt ?? new Date().toISOString();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO remote_actions
             (id, workspace_id, run_id, agent_id, issue_id, actor, action, target, detail, succeeded, created_at)
           VALUES (@id, @workspaceId, @runId, @agentId, @issueId, @actor, @action, @target, @detail, @succeeded, @createdAt)`
        )
        .run({
          id: action.id ?? `ra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          workspaceId: this.workspaceId(),
          runId: action.runId ?? null,
          agentId: action.agentId ?? null,
          issueId: action.issueId ?? null,
          actor: action.actor,
          action: action.action,
          target: action.target ?? null,
          detail: action.detail ?? null,
          succeeded: action.succeeded ? 1 : 0,
          createdAt
        });
    } catch (err) {
      console.error('[db] could not record remote action:', err);
    }
  }

  /** Oldest first, so a run's remote history reads as a sequence. */
  getRemoteActions(runId?: string): RemoteAction[] {
    const rows = runId
      ? (this.db
          .prepare('SELECT * FROM remote_actions WHERE run_id = ? AND workspace_id = ? ORDER BY created_at ASC')
          .all(runId, this.workspaceId()) as any[])
      : (this.db
          .prepare(`
            SELECT * FROM remote_actions
            WHERE workspace_id = ?
            ORDER BY created_at DESC LIMIT 200
          `)
          .all(this.workspaceId()) as any[]);

    return rows.map(r => ({
      id: r.id,
      runId: r.run_id ?? undefined,
      agentId: r.agent_id ?? undefined,
      issueId: r.issue_id ?? undefined,
      actor: r.actor,
      action: r.action,
      target: r.target ?? undefined,
      detail: r.detail ?? undefined,
      succeeded: r.succeeded === 1,
      createdAt: r.created_at
    }));
  }

  getRunsForSquadRun(squadRunId: string): PrototypeRun[] {
    return this.getPrototypeRuns()
      .filter(r => r.squadRunId === squadRunId)
      .sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0));
  }

  // --- Squads ---
  getSquads(): Squad[] {
    const rows = this.db.prepare('SELECT * FROM squads WHERE workspace_id = ?').all(this.workspaceId()) as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      // Empty string rather than null: the client's Squad type declares these
      // required, and a squad written before the columns existed has no value.
      description: r.description ?? '',
      avatar: r.avatar ?? '',
      color: r.color ?? '',
      topology: r.topology,
      leaderAgentId: r.leader_agent_id,
      memberAgentIds: JSON.parse(r.member_agent_ids || '[]'),
      mission: r.mission,
      activeRunsCount: r.active_runs_count,
      completedRunsCount: r.completed_runs_count
    }));
  }

  createSquad(squad: Squad): Squad {
    const stmt = this.db.prepare(`
      INSERT INTO squads
        (id, workspace_id, name, description, avatar, color, topology, leader_agent_id, member_agent_ids, mission, active_runs_count, completed_runs_count)
      VALUES
        (@id, @workspaceId, @name, @description, @avatar, @color, @topology, @leaderAgentId, @memberAgentIds, @mission, @activeRunsCount, @completedRunsCount)
    `);
    stmt.run({
      ...squad,
      workspaceId: this.workspaceId(),
      description: squad.description ?? '',
      avatar: squad.avatar ?? '',
      color: squad.color ?? '',
      // Every named parameter has to be bound, and a caller that leaves one
      // out -- a lean client, a squad pulled from the team's board -- would
      // otherwise fail the insert rather than take the obvious default.
      mission: squad.mission ?? '',
      leaderAgentId: squad.leaderAgentId ?? null,
      activeRunsCount: squad.activeRunsCount ?? 0,
      completedRunsCount: squad.completedRunsCount ?? 0,
      memberAgentIds: JSON.stringify(squad.memberAgentIds || [])
    });
    return squad;
  }

  /**
   * Edit a squad.
   *
   * Squads had create and run but no edit or delete, so a squad with the wrong
   * members or a typo in its name was permanent — while agents, which are the
   * same kind of object to the user, had full CRUD.
   *
   * Re-reads rather than returning the merged object, for the reason
   * `updateAgent` does: the caller reconciles its local copy against this
   * response, so it has to be what a subsequent GET would say.
   */
  updateSquad(id: string, updates: Partial<Squad>): Squad | null {
    const existing = this.getSquads().find(s => s.id === id);
    if (!existing) return null;

    const merged = { ...existing, ...updates };
    this.db.prepare(`
      UPDATE squads SET
        name = @name, description = @description, avatar = @avatar, color = @color,
        topology = @topology, leader_agent_id = @leaderAgentId,
        member_agent_ids = @memberAgentIds, mission = @mission
      WHERE id = @id AND workspace_id = @workspaceId
    `).run({
      ...merged,
      workspaceId: this.workspaceId(),
      memberAgentIds: JSON.stringify(merged.memberAgentIds || [])
    });

    return this.getSquads().find(s => s.id === id) ?? merged;
  }

  /**
   * Remove a squad.
   *
   * Its past runs are left alone: `squad_runs` is a record of what happened,
   * and deleting the squad does not un-happen it. The rows keep the id, which
   * reads as a deleted squad rather than as a missing one.
   */
  deleteSquad(id: string): boolean {
    return this.db.prepare('DELETE FROM squads WHERE id = ? AND workspace_id = ?').run(id, this.workspaceId()).changes > 0;
  }

  // --- Skills ---
  getSkills(): Skill[] {
    const rows = this.db.prepare('SELECT * FROM skills').all() as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      category: r.category,
      permissions: r.permissions,
      description: r.description,
      isEnabled: Boolean(r.is_enabled),
      commandExample: r.command_example,
      source: r.source || 'builtin',
      path: r.path || undefined,
      installed: Boolean(r.installed)
    }));
  }

  /**
   * Refresh the filesystem-backed skill catalog.
   *
   * Built-in Alpha capabilities remain in SQLite. Detected rows are upserted so
   * a user's enable/disable choice survives rescans, while rows whose files
   * disappeared are marked absent and left out of the API result on this scan.
   */
  scanSkills(): Skill[] {
    const discovered = discoverInstalledSkills();
    const resetDetected = this.db.prepare(
      "UPDATE skills SET installed = 0 WHERE COALESCE(source, 'builtin') <> 'builtin'"
    );
    const upsert = this.db.prepare(`
      INSERT INTO skills
        (id, name, category, permissions, description, is_enabled, command_example, source, path, installed)
      VALUES
        (@id, @name, @category, @permissions, @description, @isEnabled, @commandExample, @source, @path, 1)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        permissions = excluded.permissions,
        description = excluded.description,
        source = excluded.source,
        path = excluded.path,
        installed = 1
    `);

    const refresh = this.db.transaction(() => {
      resetDetected.run();
      for (const skill of discovered) {
        upsert.run({
          id: skill.id,
          name: skill.name,
          category: skill.category,
          permissions: skill.permissions,
          description: skill.description,
          // The scanner only discovers definitions; it does not grant a tool.
          // Keep them enabled in the catalog until the user explicitly changes it.
          isEnabled: 1,
          commandExample: skill.commandExample || null,
          source: skill.source,
          path: skill.path
        });
      }
    });
    refresh();

    return this.getSkills().filter(skill => skill.source === 'builtin' || skill.installed);
  }

  setSkillEnabled(id: string, isEnabled: boolean) {
    const stmt = this.db.prepare('UPDATE skills SET is_enabled = ? WHERE id = ?');
    stmt.run(isEnabled ? 1 : 0, id);
  }

  // --- Runtimes ---
  getRuntimes(): RuntimeEngine[] {
    const rows = this.db.prepare('SELECT * FROM runtimes').all() as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      status: r.status,
      // Fall back only for rows written before these columns existed; a fresh
      // scan always supplies both.
      type: r.type ?? 'cloud',
      latencyMs: r.latency_ms ?? 0,
      endpoint: r.endpoint || undefined,
      version: r.version,
      isDefault: Boolean(r.is_default),
      models: JSON.parse(r.models || '[]'),
      account: JSON.parse(r.account || '{}'),
      detectedAt: r.detected_at,
      catalogSource: r.catalog_source || 'none',
      catalogCheckedAt: r.catalog_checked_at || undefined,
      catalogFetchedAt: r.catalog_fetched_at || undefined,
      catalogStale: r.catalog_checked_at ? Boolean(r.catalog_stale) : undefined,
      catalogError: r.catalog_error || undefined,
      updateAvailable: r.update_checked_at ? Boolean(r.update_available) : undefined,
      latestVersion: r.latest_version || undefined,
      updateCheckedAt: r.update_checked_at || undefined,
      updateError: r.update_error || undefined,
      updateSource: r.update_source || undefined
    }));
  }

  removeUndetectedLocalRuntimes(ids: string[]) {
    const remove = this.db.prepare("DELETE FROM runtimes WHERE id = ? AND id IN ('ollama', 'lmstudio')");
    this.db.transaction(() => { for (const id of ids) remove.run(id); })();
  }

  saveRuntimes(runtimes: RuntimeEngine[]) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runtimes (
        id, name, provider, status, type, latency_ms, endpoint, version, is_default,
        models, account, detected_at, catalog_source, catalog_checked_at,
        catalog_fetched_at, catalog_stale, catalog_error, update_available,
        latest_version, update_checked_at, update_error, update_source
      )
      VALUES (
        @id, @name, @provider, @status, @type, @latencyMs, @endpoint, @version,
        @isDefault, @models, @account, @detectedAt, @catalogSource,
        @catalogCheckedAt, @catalogFetchedAt, @catalogStale, @catalogError,
        @updateAvailable, @latestVersion, @updateCheckedAt, @updateError, @updateSource
      )
    `);
    const tx = this.db.transaction((list: RuntimeEngine[]) => {
      for (const r of list) {
        stmt.run({
          id: r.id,
          name: r.name,
          provider: r.provider,
          status: r.status,
          type: r.type,
          latencyMs: r.latencyMs,
          endpoint: r.endpoint || null,
          version: r.version || null,
          isDefault: r.isDefault ? 1 : 0,
          models: JSON.stringify(r.models || []),
          account: JSON.stringify(r.account || {}),
          detectedAt: r.detectedAt || new Date().toISOString(),
          catalogSource: r.catalogSource || 'none',
          catalogCheckedAt: r.catalogCheckedAt || null,
          catalogFetchedAt: r.catalogFetchedAt || null,
          catalogStale: r.catalogStale ? 1 : 0,
          catalogError: r.catalogError || null,
          updateAvailable: r.updateAvailable ? 1 : 0,
          latestVersion: r.latestVersion || null,
          updateCheckedAt: r.updateCheckedAt || null,
          updateError: r.updateError || null,
          updateSource: r.updateSource || 'none'
        });
      }
    });
    tx(runtimes);
  }

  // --- Chat ---
  getChatThreads(ownerId?: string): ChatThread[] {
    /**
     * Owner-scoped when an owner is given, which the HTTP layer always does.
     *
     * Left optional for the internal callers that resolve a single thread they
     * have already authorised — `chatService` acting on a thread the
     * controller just checked. A caller that passes nothing gets the whole
     * workspace, so nothing on a request path may.
     *
     * `owner_id IS NULL` is deliberately NOT matched. Legacy rows are claimed
     * at startup instead; treating unowned as public here would reinstate
     * exactly the leak this column exists to close.
     */
    const rows = (ownerId
      ? this.db.prepare(
          'SELECT * FROM chat_threads WHERE workspace_id = ? AND owner_id = ? ORDER BY last_message_at DESC'
        ).all(this.workspaceId(), ownerId)
      : this.db.prepare(
          'SELECT * FROM chat_threads WHERE workspace_id = ? ORDER BY last_message_at DESC'
        ).all(this.workspaceId())) as any[];
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      lastMessageSnippet: r.last_message_snippet,
      lastMessageAt: r.last_message_at,
      agentIds: JSON.parse(r.agent_ids || '[]'),
      targetAgentId: r.target_agent_id ?? undefined,
      targetSquadId: r.target_squad_id ?? undefined,
      projectId: r.project_id ?? undefined,
      ownerId: r.owner_id ?? undefined,
      createdAt: r.created_at
    }));
  }

  getChatMessages(threadId: string): ChatMessage[] {
    const rows = this.db.prepare(`
      SELECT m.* FROM chat_messages m
      JOIN chat_threads t ON t.id = m.thread_id
      WHERE m.thread_id = ? AND t.workspace_id = ?
      ORDER BY m.timestamp ASC
    `).all(threadId, this.workspaceId()) as any[];
    return rows.map(r => ({
      id: r.id,
      threadId: r.thread_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      agentId: r.agent_id,
      content: r.content,
      // Private model reasoning is not returned by the agent-call path. Keep
      // this legacy field readable for old conversations, but new responses
      // deliberately omit it at the service boundary.
      thinkingProcess: r.thinking_process ?? undefined,
      toolsExecuted: parseJson(r.tools_executed, []),
      messageType: r.message_type ?? undefined,
      agentCallId: r.agent_call_id ?? undefined,
      orchestrationRunId: r.orchestration_run_id ?? undefined,
      squadId: r.squad_id ?? undefined,
      operationMode: r.operation_mode ?? undefined,
      agentCallStatus: r.agent_call_status ?? undefined,
      revisionTarget: parseJson<AgentCallTarget | undefined>(r.revision_target, undefined),
      routeProposal: parseJson<ChatMessage['routeProposal']>(r.route_proposal, undefined),
      attachments: parseJson<ChatMessage['attachments']>(r.attachments_json, []),
      timestamp: r.timestamp
    }));
  }

  /** Queue one owner-scoped chat publication with its workspace captured now. */
  enqueueChatSync(input: {
    ownerId: string;
    threadId: string;
    operation: ChatSyncOperation;
    payload?: Record<string, unknown>;
  }): number | null {
    if (!input.ownerId || !input.threadId) return null;
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO chat_sync_outbox (
        workspace_id, owner_id, thread_id, operation, payload, next_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.workspaceId(), input.ownerId, input.threadId, input.operation,
      input.payload ? JSON.stringify(input.payload) : null, now, now
    );
    return Number(result.lastInsertRowid);
  }

  /** The oldest due change per thread, preserving edits/deletes in order. */
  getDueChatSyncItems(limit = 20, now = new Date().toISOString(), ownerId?: string): ChatSyncOutboxItem[] {
    const rows = this.db.prepare(`
      SELECT queued.* FROM chat_sync_outbox queued
      WHERE queued.next_attempt_at <= ?
        AND (? IS NULL OR queued.owner_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM chat_sync_outbox earlier
          WHERE earlier.workspace_id = queued.workspace_id
            AND earlier.owner_id = queued.owner_id
            AND earlier.thread_id = queued.thread_id
            AND earlier.id < queued.id
        )
      ORDER BY queued.id ASC
      LIMIT ?
    `).all(now, ownerId ?? null, ownerId ?? null, Math.max(1, Math.min(limit, 100))) as any[];
    return rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      threadId: row.thread_id,
      operation: row.operation as ChatSyncOperation,
      payload: parseJson<Record<string, unknown> | undefined>(row.payload, undefined),
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at
    }));
  }

  markChatSyncDelivered(id: number): void {
    this.db.prepare('DELETE FROM chat_sync_outbox WHERE id = ?').run(id);
  }

  scheduleChatSyncRetry(id: number, nextAttemptAt: string, errorCategory = 'network_error'): void {
    this.db.prepare(`
      UPDATE chat_sync_outbox
      SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
      WHERE id = ?
    `).run(nextAttemptAt, errorCategory.slice(0, 80), id);
  }

  retryChatSyncForOwner(workspaceId: string, ownerId: string, threadId?: string): number {
    const now = new Date().toISOString();
    const result = threadId
      ? this.db.prepare(`
          UPDATE chat_sync_outbox SET next_attempt_at = ?, last_error = NULL, attempts = 0
          WHERE workspace_id = ? AND owner_id = ? AND thread_id = ?
        `).run(now, workspaceId, ownerId, threadId)
      : this.db.prepare(`
          UPDATE chat_sync_outbox SET next_attempt_at = ?, last_error = NULL, attempts = 0
          WHERE workspace_id = ? AND owner_id = ?
        `).run(now, workspaceId, ownerId);
    return result.changes;
  }

  getChatSyncStatus(workspaceId: string, ownerId: string, threadId?: string): {
    pending: number;
    failed: number;
  } {
    const row = threadId
      ? this.db.prepare(`
          SELECT COUNT(*) AS pending, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed
          FROM chat_sync_outbox WHERE workspace_id = ? AND owner_id = ? AND thread_id = ?
        `).get(workspaceId, ownerId, threadId) as any
      : this.db.prepare(`
          SELECT COUNT(*) AS pending, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed
          FROM chat_sync_outbox WHERE workspace_id = ? AND owner_id = ?
        `).get(workspaceId, ownerId) as any;
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0)
    };
  }

  saveChatMessage(msg: ChatMessage) {
    const stmt = this.db.prepare(`
      INSERT INTO chat_messages (
        id, thread_id, sender_type, sender_name, agent_id, content,
        thinking_process, tools_executed, message_type, agent_call_id,
        orchestration_run_id, squad_id, operation_mode, agent_call_status, revision_target, route_proposal, timestamp, attachments_json
      )
      VALUES (
        @id, @threadId, @senderType, @senderName, @agentId, @content,
        @thinkingProcess, @toolsExecuted, @messageType, @agentCallId,
        @orchestrationRunId, @squadId, @operationMode, @agentCallStatus, @revisionTarget, @routeProposal, @timestamp, @attachments
      )
    `);
    stmt.run({
      ...msg,
      agentId: msg.agentId || null,
      toolsExecuted: JSON.stringify(msg.toolsExecuted || []),
      thinkingProcess: msg.thinkingProcess || null,
      messageType: msg.messageType || (msg.senderType === 'user' ? 'user' : msg.senderType),
      agentCallId: msg.agentCallId || null,
      orchestrationRunId: msg.orchestrationRunId || null,
      squadId: msg.squadId || null,
      operationMode: msg.operationMode || null,
      agentCallStatus: msg.agentCallStatus || null,
      revisionTarget: msg.revisionTarget ? JSON.stringify(msg.revisionTarget) : null,
      routeProposal: msg.routeProposal ? JSON.stringify(msg.routeProposal) : null,
      attachments: JSON.stringify(msg.attachments ?? [])
    });

    const updateThread = this.db.prepare(`
      UPDATE chat_threads SET
        last_message_snippet = ?,
        last_message_at = ?
      WHERE id = ? AND workspace_id = ?
    `);
    updateThread.run(msg.content.slice(0, 100), msg.timestamp, msg.threadId, this.workspaceId());
  }

  deleteChatMessage(messageId: string): boolean {
    return this.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId).changes > 0;
  }

  /** Record the user's answer to a build Alpha proposed in chat. */
  updateChatMessageRouteProposal(threadId: string, messageId: string, proposal: NonNullable<ChatMessage['routeProposal']>): boolean {
    return this.db.prepare('UPDATE chat_messages SET route_proposal = ? WHERE id = ? AND thread_id = ?')
      .run(JSON.stringify(proposal), messageId, threadId).changes > 0;
  }

  saveChatAttachment(record: ChatAttachmentRecord): ChatAttachmentRecord {
    this.db.prepare(`INSERT INTO chat_attachments (
      id, thread_id, message_id, name, content_type, byte_length, inspection, storage_name, created_at
    ) VALUES (@id, @threadId, @messageId, @name, @contentType, @byteLength, @inspection, @storageName, @createdAt)`)
      .run({
        id: record.id, threadId: record.threadId, messageId: record.messageId ?? null,
        name: record.name, contentType: record.contentType, byteLength: record.byteLength,
        inspection: record.inspection, storageName: record.storageName, createdAt: record.createdAt
      });
    return record;
  }

  getChatAttachments(ids: readonly string[], threadId?: string): ChatAttachmentRecord[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM chat_attachments WHERE id IN (${placeholders})${threadId ? ' AND thread_id = ?' : ''}`)
      .all(...ids, ...(threadId ? [threadId] : [])) as any[];
    return rows.map(row => ({
      id: row.id, threadId: row.thread_id, messageId: row.message_id ?? undefined,
      name: row.name, contentType: row.content_type, byteLength: Number(row.byte_length),
      inspection: row.inspection, storageName: row.storage_name, createdAt: row.created_at
    }));
  }

  linkChatAttachments(threadId: string, messageId: string, ids: readonly string[]): void {
    if (!ids.length) return;
    const update = this.db.prepare('UPDATE chat_attachments SET message_id = ? WHERE thread_id = ? AND id = ? AND message_id IS NULL');
    this.db.transaction(() => { for (const id of ids) update.run(messageId, threadId, id); })();
  }

  deleteChatAttachment(id: string, threadId: string): ChatAttachmentRecord | null {
    const row = this.db.prepare('SELECT * FROM chat_attachments WHERE id = ? AND thread_id = ? AND message_id IS NULL').get(id, threadId) as any;
    const record: ChatAttachmentRecord | undefined = row ? {
      id: row.id, threadId: row.thread_id, messageId: undefined,
      name: row.name, contentType: row.content_type, byteLength: Number(row.byte_length),
      inspection: row.inspection, storageName: row.storage_name, createdAt: row.created_at
    } : undefined;
    if (!record) return null;
    this.db.prepare('DELETE FROM chat_attachments WHERE id = ? AND thread_id = ? AND message_id IS NULL').run(id, threadId);
    return record;
  }

  deleteChatAttachments(threadId: string): ChatAttachmentRecord[] {
    const rows = this.db.prepare('SELECT * FROM chat_attachments WHERE thread_id = ?').all(threadId) as any[];
    const records = rows.map(row => ({
      id: row.id, threadId: row.thread_id, messageId: row.message_id ?? undefined,
      name: row.name, contentType: row.content_type, byteLength: Number(row.byte_length),
      inspection: row.inspection, storageName: row.storage_name, createdAt: row.created_at
    } as ChatAttachmentRecord));
    this.db.prepare('DELETE FROM chat_attachments WHERE thread_id = ?').run(threadId);
    return records;
  }

  createChatThread(thread: Partial<ChatThread>): ChatThread {
    // Every field is defaulted. Requiring the client to supply an id made
    // better-sqlite3 throw `RangeError: Missing named parameter "id"`, which is
    // what broke the "New Conversation" button.
    const now = new Date().toISOString();
    const complete: ChatThread = {
      id: thread.id || `th-${Date.now()}`,
      title: thread.title || 'New Conversation',
      lastMessageSnippet: thread.lastMessageSnippet ?? '',
      lastMessageAt: thread.lastMessageAt || now,
      // Deliberately empty: a new conversation is addressed to nobody until the
      // user @-mentions an agent. See chatService.resolveAgent().
      agentIds: thread.agentIds ?? [],
      targetAgentId: thread.targetAgentId,
      targetSquadId: thread.targetSquadId,
      projectId: thread.projectId,
      ownerId: thread.ownerId,
      createdAt: thread.createdAt || now
    };

    this.db.prepare(`
      INSERT INTO chat_threads (
        id, workspace_id, owner_id, title, last_message_snippet, last_message_at, agent_ids,
        target_agent_id, target_squad_id, project_id, created_at
      )
      VALUES (
        @id, @workspaceId, @ownerId, @title, @lastMessageSnippet, @lastMessageAt, @agentIds,
        @targetAgentId, @targetSquadId, @projectId, @createdAt
      )
    `).run({
      ...complete,
      workspaceId: this.workspaceId(),
      agentIds: JSON.stringify(complete.agentIds),
      // Bound explicitly: the column is nullable and the field optional, but
      // better-sqlite3 requires every named parameter to be present.
      targetAgentId: complete.targetAgentId ?? null,
      targetSquadId: complete.targetSquadId ?? null,
      projectId: complete.projectId ?? null,
      ownerId: complete.ownerId ?? null
    });

    return complete;
  }

  /**
   * Give legacy threads an owner, once.
   *
   * `owner_id` had to land nullable — ADD COLUMN cannot be NOT NULL without a
   * default, and there is no sensible default for "who wrote this". That
   * leaves every thread created before this column with no owner, and the read
   * path deliberately does not treat unowned as public, so they would simply
   * vanish from the UI.
   *
   * On the desktop the right owner is unambiguous: one process, one person at
   * one keyboard, so every existing thread on this machine is theirs. A cloud
   * database has no legacy rows to claim, which is why this is called only in
   * desktop mode.
   *
   * Runs after identity resolves, not at construction, because the login is
   * not known until `gh` answers.
   */
  claimUnownedThreads(ownerId: string): number {
    if (!ownerId) return 0;
    return this.db
      .prepare('UPDATE chat_threads SET owner_id = ? WHERE owner_id IS NULL')
      .run(ownerId).changes;
  }

  /** Persist the agent roster on a thread once it is known. */
  setChatThreadAgents(threadId: string, agentIds: string[]) {
    this.db.prepare('UPDATE chat_threads SET agent_ids = ? WHERE id = ? AND workspace_id = ?')
      .run(JSON.stringify(agentIds), threadId, this.workspaceId());
  }

  /** Persist the one responder a conversation should use when no @mention is present. */
  setChatThreadTarget(
    threadId: string,
    targetAgentId: string | null,
    targetSquadId: string | null
  ): ChatThread | null {
    const exists = this.getChatThreads().some(t => t.id === threadId);
    if (!exists) return null;

    this.db.prepare(`
      UPDATE chat_threads SET
        target_agent_id = ?,
        target_squad_id = ?
      WHERE id = ? AND workspace_id = ?
    `).run(targetAgentId, targetSquadId, threadId, this.workspaceId());

    return this.getChatThreads().find(t => t.id === threadId) ?? null;
  }

  /**
   * Delete a conversation and everything belonging to it.
   *
   * `chat_messages` cascades on the foreign key, but `thread_sessions` has no
   * FK — its primary key is (thread, machine, agent), deliberately, so it can
   * hold one row per machine. Nothing would clean those up, leaving rows that
   * point at CLI transcripts for a conversation that no longer exists.
   *
   * The CLI's own transcript on disk is left alone. Alpha does not own
   * `~/.claude/projects/**.jsonl`; it only ever held an id pointing at one, and
   * deleting a conversation here is not a mandate to reach into another tool's
   * storage.
   */
  deleteChatThread(threadId: string): boolean {
    const removed = this.db.prepare('DELETE FROM chat_threads WHERE id = ? AND workspace_id = ?').run(threadId, this.workspaceId()).changes > 0;
    if (removed) {
      this.db.prepare('DELETE FROM thread_sessions WHERE thread_id = ?').run(threadId);
    }
    return removed;
  }

  /**
   * Empty a conversation but keep it.
   *
   * The session rows go too. A resumed CLI session still holds the transcript
   * that was just cleared, so keeping the pointer would have the agent answer
   * from history the user asked to be rid of — the clear would look done and
   * not be.
   */
  clearChatMessages(threadId: string): number {
    const exists = this.getChatThreads().some(t => t.id === threadId);
    if (!exists) return -1;

    const removed = this.db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(threadId).changes;
    this.db.prepare('DELETE FROM thread_sessions WHERE thread_id = ?').run(threadId);
    this.db.prepare("UPDATE chat_threads SET last_message_snippet = '' WHERE id = ? AND workspace_id = ?").run(threadId, this.workspaceId());
    return removed;
  }

  /**
   * Point a conversation at a project, or at nothing.
   *
   * Null is a real choice, not a missing argument: it returns the thread to the
   * managed workspace root, which is where a conversation that is not about
   * code belongs.
   */
  setChatThreadProject(threadId: string, projectId: string | null): ChatThread | null {
    const exists = this.getChatThreads().some(t => t.id === threadId);
    if (!exists) return null;

    this.db.prepare('UPDATE chat_threads SET project_id = ? WHERE id = ? AND workspace_id = ?')
      .run(projectId, threadId, this.workspaceId());

    return this.getChatThreads().find(t => t.id === threadId) ?? null;
  }

  // --- Project-scoped agent calls -----------------------------------------
  private agentCallFromRow(row: any): AgentCall {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      threadId: row.thread_id,
      messageId: row.message_id ?? undefined,
      squadId: row.squad_id,
      agentId: row.agent_id,
      requestedBy: row.requested_by,
      operationMode: row.operation_mode,
      origin: row.origin ?? 'agent_call',
      status: row.status,
      revisionTarget: agentCallTargetFromRow(row),
      instruction: row.instruction,
      workingCopyId: row.working_copy_id ?? undefined,
      workingBranch: row.working_branch ?? undefined,
      workingCommit: row.working_commit ?? undefined,
      resultMessageId: row.result_message_id ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      artifacts: this.getAgentCallArtifacts(row.id),
      activities: parseJson(row.activities, [])
    };
  }

  getAgentCalls(filters: { workspaceId?: string; projectId?: string; threadId?: string } = {}): AgentCall[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.workspaceId) { clauses.push('workspace_id = ?'); values.push(filters.workspaceId); }
    if (filters.projectId) { clauses.push('project_id = ?'); values.push(filters.projectId); }
    if (filters.threadId) { clauses.push('thread_id = ?'); values.push(filters.threadId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM agent_calls ${where} ORDER BY created_at DESC`).all(...values) as any[];
    return rows.map(row => this.agentCallFromRow(row));
  }

  getAgentCall(id: string): AgentCall | null {
    const row = this.db.prepare('SELECT * FROM agent_calls WHERE id = ?').get(id) as any;
    return row ? this.agentCallFromRow(row) : null;
  }

  private assertProjectCodeCallAdmission(
    workspaceId: string,
    projectId: string,
    repositoryKey: string,
    ownerCallId?: string
  ): void {
    if (!repositoryKey) return;
    const activeStatuses = ['planning', 'awaiting_plan_approval', 'executing', 'paused', 'validating', 'awaiting_approval', 'publishing', 'blocked', 'recovery_required', 'cancelling'];
    const placeholders = activeStatuses.map(() => '?').join(', ');
    const activeRuns = this.db.prepare(`SELECT id, repository, status FROM orchestration_runs
      WHERE workspace_id = ? AND project_id = ? AND status IN (${placeholders})`)
      .all(workspaceId, projectId, ...activeStatuses) as Array<{ id: string; repository: string; status: string }>;
    const activeRun = activeRuns.find(run => canonicalOrchestrationRepository(run.repository) === repositoryKey);
    if (activeRun) {
      throw new Error(`A task-based build is ${activeRun.status.replace(/_/g, ' ')} for this repository. Resolve it before starting or applying an independent code call.`);
    }

    const planningReservation = this.db.prepare(`SELECT run_id FROM orchestration_planning_reservations
      WHERE workspace_id = ? AND project_id = ? AND repository_key = ?`)
      .get(workspaceId, projectId, repositoryKey) as { run_id: string } | undefined;
    if (planningReservation) throw new Error('A task build is being planned for this repository. Wait for planning to finish before starting or applying an independent code call.');

    const existingLock = this.db.prepare(`SELECT owner_call_id FROM project_code_execution_locks
      WHERE workspace_id = ? AND project_id = ? AND repository_key = ?`)
      .get(workspaceId, projectId, repositoryKey) as { owner_call_id: string } | undefined;
    if (existingLock && existingLock.owner_call_id !== ownerCallId) {
      throw new Error('Another independent code call or patch is already using this repository. Let it finish before retrying.');
    }
  }

  private acquireProjectCodeCallLock(
    workspaceId: string,
    projectId: string,
    repository: string,
    ownerCallId: string,
    purpose: 'call' | 'patch',
    acquiredAt = new Date().toISOString()
  ): void {
    const repositoryKey = canonicalOrchestrationRepository(repository);
    if (!repositoryKey) return;
    this.assertProjectCodeCallAdmission(workspaceId, projectId, repositoryKey, ownerCallId);
    const existing = this.db.prepare(`SELECT owner_call_id, purpose FROM project_code_execution_locks
      WHERE workspace_id = ? AND project_id = ? AND repository_key = ?`)
      .get(workspaceId, projectId, repositoryKey) as { owner_call_id: string; purpose: string } | undefined;
    if (existing?.owner_call_id === ownerCallId) {
      if (purpose === 'patch' && existing.purpose === 'patch') {
        throw new Error('This proposed patch is already being applied. Wait for that operation to finish.');
      }
      if (purpose === 'patch' && existing.purpose !== 'patch') {
        this.db.prepare(`UPDATE project_code_execution_locks SET purpose = 'patch', acquired_at = ?
          WHERE workspace_id = ? AND project_id = ? AND repository_key = ? AND owner_call_id = ?`)
          .run(acquiredAt, workspaceId, projectId, repositoryKey, ownerCallId);
      }
      return;
    }
    this.db.prepare(`INSERT INTO project_code_execution_locks
      (workspace_id, project_id, repository_key, repository, owner_call_id, purpose, acquired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, projectId, repositoryKey, repository.trim(), ownerCallId, purpose, acquiredAt);
  }

  /** Save a queued code-capable call and acquire its repository lock atomically. */
  saveAgentCallWithProjectLock(call: AgentCall, repository?: string): AgentCall {
    const persist = this.db.transaction(() => {
      this.saveAgentCall(call);
      if (call.origin !== 'chat_turn' && call.operationMode !== 'ask' && call.status === 'queued' && repository) {
        this.acquireProjectCodeCallLock(call.workspaceId, call.projectId,
          repository, call.id, 'call', call.createdAt);
      }
    });
    persist();
    return this.getAgentCall(call.id)!;
  }

  /** Queue an approved or retried code call only if it can own its repository. */
  queueAgentCallWithProjectLock(
    id: string,
    repository: string | undefined,
    updates: Partial<AgentCall>
  ): AgentCall | null {
    const queue = this.db.transaction(() => {
      const current = this.getAgentCall(id);
      if (!current) return null;
      if (current.status !== 'awaiting_confirmation') {
        throw new Error('This implementation call is no longer waiting for confirmation.');
      }
      if (current.origin !== 'chat_turn' && current.operationMode !== 'ask' && updates.status === 'queued' && repository) {
        this.acquireProjectCodeCallLock(current.workspaceId, current.projectId, repository, current.id, 'call');
      }
      this.updateAgentCallRow(id, updates);
      return this.getAgentCall(id);
    });
    return queue();
  }

  /** Reset a failed call and its artifacts in the same transaction as admission. */
  retryAgentCallWithProjectLock(
    id: string,
    repository: string | undefined,
    updates: Partial<AgentCall>
  ): AgentCall | null {
    const retry = this.db.transaction(() => {
      const current = this.getAgentCall(id);
      if (!current) return null;
      if (!['failed', 'cancelled'].includes(current.status)) {
        throw new Error('Only failed or cancelled calls can be retried.');
      }
      if (current.origin !== 'chat_turn' && current.operationMode !== 'ask' && updates.status === 'queued' && repository) {
        this.acquireProjectCodeCallLock(current.workspaceId, current.projectId, repository, current.id, 'call');
      }
      this.db.prepare('DELETE FROM agent_call_artifacts WHERE agent_call_id = ?').run(id);
      this.updateAgentCallRow(id, updates);
      return this.getAgentCall(id);
    });
    return retry();
  }

  acquireAgentCallPatchLock(id: string, repository: string): boolean {
    const acquire = this.db.transaction(() => {
      const call = this.getAgentCall(id);
      if (!call || call.origin === 'chat_turn' || !['revise', 'implement'].includes(call.operationMode)) {
        throw new Error('Only a saved revise or implement proposal can acquire a patch lock.');
      }
      this.acquireProjectCodeCallLock(call.workspaceId, call.projectId, repository, id, 'patch');
      return true;
    });
    return acquire();
  }

  releaseAgentCallProjectLock(id: string): boolean {
    return this.db.prepare('DELETE FROM project_code_execution_locks WHERE owner_call_id = ?').run(id).changes > 0;
  }

  getActiveAgentCallProjectLock(projectId: string, repository: string): {
    agentCallId: string;
    repository: string;
    purpose: 'call' | 'patch';
    acquiredAt: string;
  } | undefined {
    const repositoryKey = canonicalOrchestrationRepository(repository);
    if (!repositoryKey) return undefined;
    const row = this.db.prepare(`SELECT owner_call_id, repository, purpose, acquired_at
      FROM project_code_execution_locks
      WHERE workspace_id = ? AND project_id = ? AND repository_key = ?`)
      .get(this.workspaceId(), projectId, repositoryKey) as any;
    return row ? {
      agentCallId: row.owner_call_id,
      repository: row.repository,
      purpose: row.purpose,
      acquiredAt: row.acquired_at
    } : undefined;
  }

  reconcileInterruptedAgentCalls(now = new Date().toISOString()): string[] {
    const interrupted = this.db.prepare(`SELECT id FROM agent_calls
      WHERE origin = 'agent_call' AND status IN ('queued', 'running') ORDER BY created_at`)
      .all() as Array<{ id: string }>;
    const reconcile = this.db.transaction(() => {
      for (const call of interrupted) {
        this.updateAgentCallRow(call.id, {
          status: 'failed',
          error: 'This independent call was interrupted when Alpha stopped. Review its saved activity and run it again if needed.',
          completedAt: now
        });
        this.db.prepare('DELETE FROM project_code_execution_locks WHERE owner_call_id = ?').run(call.id);
      }
      this.db.prepare(`DELETE FROM project_code_execution_locks
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_calls
          WHERE agent_calls.id = project_code_execution_locks.owner_call_id
            AND agent_calls.status IN ('queued', 'running')
            AND agent_calls.operation_mode <> 'ask'
        )`).run();
    });
    reconcile();
    return interrupted.map(call => call.id);
  }

  saveAgentCall(call: AgentCall): AgentCall {
    const target = call.revisionTarget;
    this.db.prepare(`
      INSERT INTO agent_calls (
        id, workspace_id, project_id, thread_id, message_id, squad_id, agent_id,
        requested_by, operation_mode, origin, status, revision_target_type,
        revision_target_id, revision_target_label, instruction, working_copy_id,
        working_branch, working_commit, result_message_id, error, created_at, started_at, completed_at, activities
      ) VALUES (
        @id, @workspaceId, @projectId, @threadId, @messageId, @squadId, @agentId,
        @requestedBy, @operationMode, @origin, @status, @revisionTargetType,
        @revisionTargetId, @revisionTargetLabel, @instruction, @workingCopyId,
        @workingBranch, @workingCommit, @resultMessageId, @error, @createdAt, @startedAt, @completedAt, @activities
      )
    `).run({
      id: call.id,
      workspaceId: call.workspaceId,
      projectId: call.projectId,
      threadId: call.threadId,
      messageId: call.messageId ?? null,
      squadId: call.squadId,
      agentId: call.agentId,
      requestedBy: call.requestedBy,
      operationMode: call.operationMode,
      origin: call.origin ?? 'agent_call',
      status: call.status,
      revisionTargetType: target?.type ?? null,
      revisionTargetId: target?.id ?? null,
      revisionTargetLabel: target?.label ?? null,
      instruction: call.instruction,
      workingCopyId: call.workingCopyId ?? null,
      workingBranch: call.workingBranch ?? null,
      workingCommit: call.workingCommit ?? null,
      resultMessageId: call.resultMessageId ?? null,
      error: call.error ?? null,
      createdAt: call.createdAt,
      startedAt: call.startedAt ?? null,
      completedAt: call.completedAt ?? null,
      activities: JSON.stringify(call.activities ?? [])
    });
    return this.getAgentCall(call.id)!;
  }

  updateAgentCall(id: string, updates: Partial<AgentCall>): AgentCall | null {
    const update = this.db.transaction(() => {
      const call = this.updateAgentCallRow(id, updates);
      if (call && ['completed', 'failed', 'cancelled'].includes(call.status)) {
        this.db.prepare('DELETE FROM project_code_execution_locks WHERE owner_call_id = ?').run(id);
      }
      return call;
    });
    return update();
  }

  private updateAgentCallRow(id: string, updates: Partial<AgentCall>): AgentCall | null {
    const current = this.getAgentCall(id);
    if (!current) return null;
    const merged = { ...current, ...updates };
    const target = merged.revisionTarget;
    this.db.prepare(`
      UPDATE agent_calls SET
        message_id = @messageId, squad_id = @squadId, agent_id = @agentId,
        requested_by = @requestedBy, operation_mode = @operationMode,
        origin = @origin,
        status = @status, revision_target_type = @revisionTargetType,
        revision_target_id = @revisionTargetId, revision_target_label = @revisionTargetLabel,
        instruction = @instruction, working_copy_id = @workingCopyId,
        working_branch = @workingBranch, working_commit = @workingCommit,
        result_message_id = @resultMessageId, error = @error,
        started_at = @startedAt, completed_at = @completedAt,
        activities = @activities
      WHERE id = @id
    `).run({
      id,
      messageId: merged.messageId ?? null,
      squadId: merged.squadId,
      agentId: merged.agentId,
      requestedBy: merged.requestedBy,
      operationMode: merged.operationMode,
      origin: merged.origin ?? 'agent_call',
      status: merged.status,
      revisionTargetType: target?.type ?? null,
      revisionTargetId: target?.id ?? null,
      revisionTargetLabel: target?.label ?? null,
      instruction: merged.instruction,
      workingCopyId: merged.workingCopyId ?? null,
      workingBranch: merged.workingBranch ?? null,
      workingCommit: merged.workingCommit ?? null,
      resultMessageId: merged.resultMessageId ?? null,
      error: merged.error ?? null,
      startedAt: merged.startedAt ?? null,
      completedAt: merged.completedAt ?? null,
      activities: JSON.stringify(merged.activities ?? [])
    });
    return this.getAgentCall(id);
  }

  getAgentCallArtifacts(agentCallId: string): AgentCallArtifact[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_call_artifacts WHERE agent_call_id = ? ORDER BY created_at ASC'
    ).all(agentCallId) as any[];
    return rows.map(row => ({
      id: row.id,
      agentCallId: row.agent_call_id,
      artifactType: row.artifact_type,
      path: row.path ?? undefined,
      contentReference: row.content_reference ?? undefined,
      content: row.content ?? undefined,
      createdAt: row.created_at
    }));
  }

  saveAgentCallArtifact(artifact: AgentCallArtifact): AgentCallArtifact {
    this.db.prepare(`
      INSERT INTO agent_call_artifacts
        (id, agent_call_id, artifact_type, path, content_reference, content, created_at)
      VALUES (@id, @agentCallId, @artifactType, @path, @contentReference, @content, @createdAt)
    `).run({
      id: artifact.id,
      agentCallId: artifact.agentCallId,
      artifactType: artifact.artifactType,
      path: artifact.path ?? null,
      contentReference: artifact.contentReference ?? null,
      content: artifact.content ?? null,
      createdAt: artifact.createdAt
    });
    return artifact;
  }

  deleteAgentCallArtifacts(agentCallId: string): number {
    return this.db.prepare('DELETE FROM agent_call_artifacts WHERE agent_call_id = ?').run(agentCallId).changes;
  }

  // --- CLI session continuity -----------------------------------------------

  /**
   * Stable id for this machine, minted once.
   *
   * Scopes session ids so a transcript on this disk is never resumed from
   * another machine. Constant today; meaningful the moment threads are shared.
   */
  getMachineId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'machine_id'").get() as
      | { value: string }
      | undefined;
    if (row?.value) return row.value;

    const id = randomUUID();
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('machine_id', ?)").run(id);
    return id;
  }

  /** The CLI session for this thread + agent ON THIS MACHINE, if any. */
  /**
   * The CLI session for this thread, with the persona that was in force when it
   * started.
   *
   * `personaHash` is null for sessions created before the column existed, which
   * callers must read as "unknown", not as "changed" — re-announcing a persona
   * to every pre-existing conversation on first upgrade would be noise.
   */
  getThreadSession(
    threadId: string,
    agentId: string
  ): { cliSessionId: string; personaHash: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT cli_session_id, persona_hash FROM thread_sessions
         WHERE thread_id = ? AND machine_id = ? AND agent_id = ?`
      )
      .get(threadId, this.getMachineId(), agentId) as
      | { cli_session_id: string; persona_hash: string | null }
      | undefined;

    if (!row) return null;
    return { cliSessionId: row.cli_session_id, personaHash: row.persona_hash ?? null };
  }

  setThreadSession(
    threadId: string,
    agentId: string,
    cliSessionId: string,
    personaHash: string | null = null
  ) {
    this.db
      .prepare(
        `INSERT INTO thread_sessions (thread_id, machine_id, agent_id, cli_session_id, persona_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, machine_id, agent_id)
         DO UPDATE SET cli_session_id = excluded.cli_session_id,
                       persona_hash   = excluded.persona_hash,
                       updated_at     = excluded.updated_at`
      )
      .run(
        threadId,
        this.getMachineId(),
        agentId,
        cliSessionId,
        personaHash,
        new Date().toISOString()
      );
  }
}

/** Raised when cloud code reaches the desktop's store. */
export class DesktopStoreInCloudError extends Error {
  constructor() {
    super(
      'The cloud keeps no SQLite file: everything it serves is in Postgres. ' +
        'This path reached the desktop store, and on Render anything written there is gone at the next deploy.'
    );
    this.name = 'DesktopStoreInCloudError';
  }
}

let instance: SQLiteService | null = null;

function open(): SQLiteService {
  if (IS_CLOUD) throw new DesktopStoreInCloudError();
  return (instance ??= new SQLiteService());
}

/**
 * Open the desktop store now, if it is not already.
 *
 * For `workspaceRegistry`, whose handle shares this file: this service owns
 * the file's schema and must create its tables before anything else does, or
 * the registry's narrower `CREATE TABLE IF NOT EXISTS` wins and this one's
 * later inserts name columns the table does not have. Opening at import used
 * to guarantee the order without anyone saying so.
 */
export function openDesktopStore(): void {
  open();
}

/**
 * The desktop's store, opened on first use and never in the cloud.
 *
 * It used to open at import, so the cloud created `alpha.db` on Render's disk
 * the moment any route file loaded it -- and every path that had not moved to
 * Postgres read and wrote that file without complaint, losing it all at the
 * next deploy. Refusing makes a missed path fail where it is, loudly, instead
 * of silently keeping data nobody will see again.
 *
 * A proxy so the hundreds of `sqliteService.x()` call sites stay as they are.
 */
export const sqliteService: SQLiteService = new Proxy({} as SQLiteService, {
  get(_target, prop) {
    // Closing a store that was never opened closes nothing, in either mode.
    if (prop === 'close' && !instance) return () => {};
    const service = open();
    const value = Reflect.get(service, prop, service);
    return typeof value === 'function' ? value.bind(service) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(open(), prop, value);
  },
  has(_target, prop) {
    return Reflect.has(open(), prop);
  }
});
