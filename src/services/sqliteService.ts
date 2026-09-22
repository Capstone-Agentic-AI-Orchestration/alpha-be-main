import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  BuildStepPhase,
  AgentCall,
  AgentCallTarget,
  AgentCallArtifact
} from '../models/index.js';
import { syncAgentFile, deleteAgentFile, readAgentFile } from './agentFileService.js';
import { ensureMemoryScaffold } from './memoryService.js';
import {
  agentFromOfficialTemplate,
  LEGACY_TEMPLATE_MAPPINGS,
  OFFICIAL_AGENT_TEMPLATES
} from './officialAgentTemplates.js';
import { discoverInstalledSkills } from './skillDiscoveryService.js';
import { currentWorkspaceId, DEFAULT_WORKSPACE_ID, runWithWorkspace } from './workspaceContext.js';
import { analyticsFrom } from './runAnalytics.js';
import { BUILTIN_SKILLS } from './builtinSkills.js';
import { normalizeBuildSteps } from '../store/buildSteps.js';

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
    stoppedReason: r.stopped_reason ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
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

export class SQLiteService {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initPragmas();
    this.initTables();
    this.migrate();
    this.ensureDefaultWorkspace();
    this.seedDefaultsIfEmpty();
    this.ensureOfficialAgents();
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
        pr_url TEXT,
        changed_files INTEGER DEFAULT 0,
        insertions INTEGER DEFAULT 0,
        deletions INTEGER DEFAULT 0,
        test_summary TEXT,
        activities TEXT NOT NULL DEFAULT '[]',
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
        squad_id TEXT,
        operation_mode TEXT,
        agent_call_status TEXT,
        revision_target TEXT,
        timestamp TEXT NOT NULL
      );

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
        status TEXT NOT NULL,
        revision_target_type TEXT,
        revision_target_id TEXT,
        revision_target_label TEXT,
        instruction TEXT NOT NULL,
        working_copy_id TEXT,
        result_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
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
      ,['chat_messages', 'squad_id TEXT']
      ,['chat_messages', 'operation_mode TEXT']
      ,['chat_messages', 'agent_call_status TEXT']
      ,['chat_messages', 'revision_target TEXT']
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
   * Give a workspace the agents and squad it starts life with.
   *
   * Separate from `createWorkspace` because the workspace row itself is no
   * longer written here: membership decides who may open one, so the row is
   * the directory's (Postgres in the cloud, SQLite on a desktop) while the
   * agents and squads it seeds are still this store's.
   *
   * Projects and issues stay intentionally empty: those are the owner's work,
   * not product seed data.
   */
  seedWorkspace(workspaceId: string, name: string): void {
    runWithWorkspace(workspaceId, () => {
      this.ensureOfficialAgents(workspaceId);
      const agents = this.getAgents();
      this.createSquad({
        id: `squad-${workspaceId}`,
        name: `${name} Core Squad`,
        description: 'Official Alpha roles working in sequence.',
        avatar: '◈',
        color: '#6366f1',
        topology: 'Sequential',
        leaderAgentId: agents.find(agent => agent.role === 'Manager Agent')?.id || agents[0]?.id,
        memberAgentIds: agents.map(agent => agent.id),
        mission: 'Research, plan, build, review, and validate approved project work.',
        activeRunsCount: 0,
        completedRunsCount: 0
      });
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
            is_seeded = 1
        WHERE id = @id AND workspace_id = @workspaceId AND template_key IS NULL
      `);

      for (const [id, key] of Object.entries(LEGACY_TEMPLATE_MAPPINGS)) {
        const template = OFFICIAL_AGENT_TEMPLATES.find(item => item.key === key);
        if (!template) continue;
        stmt.run({
          id,
          templateKey: template.key,
          templateVersion: template.version,
          phase: template.phase,
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
      if (existing.has(template.key)) continue;

      // An installation may already have a manually created agent whose id
      // happens to match a new official role. That record is its owner's work,
      // not evidence that it is the template. Preserve it and give the seeded
      // record a deterministic alternate id instead of failing startup.
      const seeded = agentFromOfficialTemplate(template, now);
      if (existingIds.has(seeded.id)) {
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
      existing.add(template.key);
      existingIds.add(seeded.id);
    }
  }

  private seedDefaultsIfEmpty() {
    if (this.hasSeeded()) return;

    const now = new Date().toISOString();

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

    // Default Agents
    /**
     * Named for what they do, not for who they are.
     *
     * These shipped as invented people — Ada Lovelace, Kaelen Vance, Vesper Lin,
     * Orion Cross — which read as a cast rather than a toolkit. On someone
     * else's install it is worse than decorative: a new collaborator opens the
     * roster and has to learn five names before knowing which one reviews code.
     *
     * A single word also makes the mention usable. `resolveMentions` matches the
     * first word of a name, so "Ada Lovelace" answered to `@ada` — a token that
     * says nothing about what it does. `@reviewer` and `@tester` need no
     * explaining, and read the same way in a chat as on a kanban card.
     */
    const defaultAgents: Agent[] = [
      {
        id: 'agent-architect',
        name: 'Architect',
        role: 'Architect',
        avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=128&fit=crop&q=80',
        color: '#6366f1',
        description: 'Designs system structure: interfaces, module boundaries, and state machines.',
        owner: 'You',
        isMine: true,
        modelProvider: 'Anthropic',
        modelName: '',
        systemPrompt: 'You are the Architect. Focus on clean interfaces, modular decomposition, and strict type definitions. Propose structure before code.',
        autonomyLevel: 'Semi-Autonomous (Requires Approval)',
        skills: ['sk-fs', 'sk-git', 'sk-browser'],
        mcpServers: ['alpha-github'],
        createdAt: now
      },
      {
        id: 'agent-developer',
        name: 'Developer',
        role: 'Coder',
        avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=128&fit=crop&q=80',
        color: '#10b981',
        description: 'Implements features across the stack in TypeScript, React, and Node.',
        owner: 'You',
        isMine: true,
        modelProvider: 'Anthropic',
        modelName: '',
        systemPrompt: 'You are the Developer. Write robust, concise TypeScript. Match the surrounding code and add no extraneous comments.',
        autonomyLevel: 'Semi-Autonomous (Requires Approval)',
        skills: ['sk-fs', 'sk-bash', 'sk-git'],
        mcpServers: ['alpha-github'],
        createdAt: now
      },
      {
        id: 'agent-reviewer',
        name: 'Reviewer',
        role: 'Reviewer',
        avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=128&fit=crop&q=80',
        color: '#f59e0b',
        description: 'Audits diffs for correctness, security, and edge cases before they merge.',
        owner: 'You',
        isMine: true,
        modelProvider: 'OpenAI',
        modelName: '',
        systemPrompt: 'You are the Reviewer. Inspect diffs for correctness, performance, and security anti-patterns. Report findings; do not rewrite the change yourself.',
        autonomyLevel: 'Supervised',
        skills: ['sk-fs', 'sk-git'],
        mcpServers: ['alpha-github'],
        createdAt: now
      },
      {
        id: 'agent-tester',
        name: 'Tester',
        role: 'QA Tester',
        avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=128&fit=crop&q=80',
        color: '#ec4899',
        description: 'Writes unit, regression, and end-to-end tests, and reports coverage gaps.',
        owner: 'You',
        isMine: true,
        modelProvider: 'Anthropic',
        modelName: '',
        systemPrompt: 'You are the Tester. Write thorough unit and regression tests with high assertion density. Name the cases you did not cover.',
        autonomyLevel: 'Semi-Autonomous (Requires Approval)',
        skills: ['sk-fs', 'sk-bash'],
        mcpServers: ['alpha-github'],
        createdAt: now
      },
      {
        id: 'agent-operator',
        name: 'Operator',
        role: 'DevOps',
        avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=128&fit=crop&q=80',
        color: '#8b5cf6',
        description: 'Runs CI/CD: diagnoses failing workflows and patches broken builds.',
        owner: 'You',
        isMine: true,
        modelProvider: 'Anthropic',
        modelName: '',
        systemPrompt: 'You are the Operator. Inspect CI workflows, diagnose failed run logs, and patch builds. Explain the failure before fixing it.',
        autonomyLevel: 'Semi-Autonomous (Requires Approval)',
        skills: ['sk-fs', 'sk-bash', 'sk-git'],
        // Was ['filesystem', 'github'] — neither exists in the catalog, so this
        // agent was granted nothing and the runner logged two unknown servers
        // on every run.
        mcpServers: ['alpha-github'],
        createdAt: now
      }
    ];

    // The pre-template seed stays here only as migration reference for old
    // databases. New installs receive OFFICIAL_AGENT_TEMPLATES below.
    void defaultAgents;

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
     * Agents, skills and the squad stay because they are scaffolding anyone
     * would want — Architect, Developer, Reviewer, Tester and Operator are
     * roles, not opinions about what you are working on. A project and its
     * issues are the work itself, and only its owner can say what that is.
     */

    // Default Squad
    const defaultSquad: Squad = {
      id: 'squad-core',
      name: 'Alpha Core Execution Squad',
      topology: 'Sequential',
      leaderAgentId: 'agent-manager',
      memberAgentIds: ['agent-research', 'agent-architect', 'agent-manager', 'agent-backend', 'agent-frontend', 'agent-reviewer', 'agent-tester'],
      mission: 'Research, plan, build, review, and validate approved project work.',
      activeRunsCount: 0,
      completedRunsCount: 12
    };

    this.createSquad(defaultSquad);

    // Last, so a seed that throws part-way is retried rather than recorded as
    // done. Everything above is idempotent, so the retry is safe.
    this.markSeeded();
  }

  // --- Allowed Paths ---
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
  getProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at DESC').all(this.workspaceId()) as any[];
    return rows.map(r => ({
      ...r,
      startDate: r.start_date,
      targetDate: r.target_date,
      leadType: r.lead_type,
      leadName: r.lead_name,
      leadAgentId: r.lead_agent_id,
      resources: JSON.parse(r.resources || '[]'),
      githubOrg: r.github_org || undefined,
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
      INSERT INTO projects (id, workspace_id, name, key, description, color, icon, status, priority, start_date, target_date, lead_type, lead_name, lead_agent_id, resources, github_org, env_vars, created_at)
      VALUES (@id, @workspaceId, @name, @key, @description, @color, @icon, @status, @priority, @startDate, @targetDate, @leadType, @leadName, @leadAgentId, @resources, @githubOrg, @envVars, @createdAt)
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
      envVars: JSON.stringify(complete.envVars || []),
      createdAt: complete.createdAt || now
    });

    // The completed row, not the caller's partial — it now carries the id and
    // defaults the caller did not send, which is what the client needs back.
    return complete;
  }

  updateProject(id: string, updates: Partial<Project>): Project | null {
    const existing = this.getProjects().find(p => p.id === id);
    if (!existing) return null;
    const merged = { ...existing, ...updates };
    const stmt = this.db.prepare(`
      UPDATE projects SET
        name = @name, key = @key, description = @description, color = @color, icon = @icon,
        status = @status, priority = @priority, start_date = @startDate, target_date = @targetDate,
        lead_type = @leadType, lead_name = @leadName, lead_agent_id = @leadAgentId, resources = @resources,
        github_org = @githubOrg, env_vars = @envVars
      WHERE id = @id AND workspace_id = @workspaceId
    `);
    stmt.run({
      ...merged,
      workspaceId: this.workspaceId(),
      resources: JSON.stringify(merged.resources || []),
      githubOrg: merged.githubOrg || null,
      envVars: JSON.stringify(merged.envVars || [])
    });
    return merged;
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
    const squadIds = new Set(
      (this.db.prepare('SELECT id FROM squads WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string }>)
        .map(row => row.id)
    );

    const normalized = normalizeBuildSteps(projectId, input, agentIds, squadIds);

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
       * These three were hardcoded, so an archived agent came back reporting
       * 'online' and 'idle' like any other. The client set 'offline' locally on
       * archive and a reload silently undid it — which also meant the roster
       * could not be trusted about what was actually retired.
       *
       * Still synthesised rather than stored: liveness is a property of the
       * machine and the run queue, not a column. Only the archived case is
       * knowable from the row.
       */
      machineStatus: r.is_archived ? 'offline' : 'online',
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
      owner: a.owner ?? 'You',
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
      prUrl: r.pr_url,
      changedFiles: r.changed_files,
      insertions: r.insertions,
      deletions: r.deletions,
      testSummary: r.test_summary,
      usage: usageFromRow(r),
      squadRunId: r.squad_run_id ?? undefined,
      squadOrder: r.squad_order ?? undefined,
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
      INSERT OR REPLACE INTO prototype_runs (id, workspace_id, issue_id, project_id, agent_id, status, scenario, plan, current_stage_index, stages, branch_name, pr_url, changed_files, insertions, deletions, test_summary, activities, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, cost_usd, num_turns, squad_run_id, squad_order, created_at, updated_at)
      VALUES (@id, @workspaceId, @issueId, @projectId, @agentId, @status, @scenario, @plan, @currentStageIndex, @stages, @branchName, @prUrl, @changedFiles, @insertions, @deletions, @testSummary, @activities, @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreationTokens, @thinkingTokens, @costUsd, @numTurns, @squadRunId, @squadOrder, @createdAt, @updatedAt)
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
      prUrl: run.prUrl || null,
      changedFiles: run.changedFiles || 0,
      insertions: run.insertions || 0,
      deletions: run.deletions || 0,
      testSummary: run.testSummary || null,
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

  getSquadRun(id: string): SquadRun | undefined {
    const row = this.db.prepare('SELECT * FROM squad_runs WHERE id = ? AND workspace_id = ?').get(id, this.workspaceId()) as any;
    return row ? squadRunFromRow(row) : undefined;
  }

  saveSquadRun(run: SquadRun): SquadRun {
    this.db.prepare(`
      INSERT OR REPLACE INTO squad_runs
        (id, workspace_id, squad_id, issue_id, project_id, branch_name, member_agent_ids,
         current_member_index, status, mission, plan, stopped_reason, created_at, updated_at)
      VALUES
        (@id, @workspaceId, @squadId, @issueId, @projectId, @branchName, @memberAgentIds,
         @currentMemberIndex, @status, @mission, @plan, @stoppedReason, @createdAt, @updatedAt)
    `).run({
      ...run,
      workspaceId: this.workspaceId(),
      memberAgentIds: JSON.stringify(run.memberAgentIds || []),
      plan: JSON.stringify(run.plan || []),
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
      squadId: r.squad_id ?? undefined,
      operationMode: r.operation_mode ?? undefined,
      agentCallStatus: r.agent_call_status ?? undefined,
      revisionTarget: parseJson<AgentCallTarget | undefined>(r.revision_target, undefined),
      timestamp: r.timestamp
    }));
  }

  saveChatMessage(msg: ChatMessage) {
    const stmt = this.db.prepare(`
      INSERT INTO chat_messages (
        id, thread_id, sender_type, sender_name, agent_id, content,
        thinking_process, tools_executed, message_type, agent_call_id,
        squad_id, operation_mode, agent_call_status, revision_target, timestamp
      )
      VALUES (
        @id, @threadId, @senderType, @senderName, @agentId, @content,
        @thinkingProcess, @toolsExecuted, @messageType, @agentCallId,
        @squadId, @operationMode, @agentCallStatus, @revisionTarget, @timestamp
      )
    `);
    stmt.run({
      ...msg,
      agentId: msg.agentId || null,
      toolsExecuted: JSON.stringify(msg.toolsExecuted || []),
      thinkingProcess: msg.thinkingProcess || null,
      messageType: msg.messageType || (msg.senderType === 'user' ? 'user' : msg.senderType),
      agentCallId: msg.agentCallId || null,
      squadId: msg.squadId || null,
      operationMode: msg.operationMode || null,
      agentCallStatus: msg.agentCallStatus || null,
      revisionTarget: msg.revisionTarget ? JSON.stringify(msg.revisionTarget) : null
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
      status: row.status,
      revisionTarget: agentCallTargetFromRow(row),
      instruction: row.instruction,
      workingCopyId: row.working_copy_id ?? undefined,
      resultMessageId: row.result_message_id ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      artifacts: this.getAgentCallArtifacts(row.id)
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

  saveAgentCall(call: AgentCall): AgentCall {
    const target = call.revisionTarget;
    this.db.prepare(`
      INSERT INTO agent_calls (
        id, workspace_id, project_id, thread_id, message_id, squad_id, agent_id,
        requested_by, operation_mode, status, revision_target_type,
        revision_target_id, revision_target_label, instruction, working_copy_id,
        result_message_id, error, created_at, started_at, completed_at
      ) VALUES (
        @id, @workspaceId, @projectId, @threadId, @messageId, @squadId, @agentId,
        @requestedBy, @operationMode, @status, @revisionTargetType,
        @revisionTargetId, @revisionTargetLabel, @instruction, @workingCopyId,
        @resultMessageId, @error, @createdAt, @startedAt, @completedAt
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
      status: call.status,
      revisionTargetType: target?.type ?? null,
      revisionTargetId: target?.id ?? null,
      revisionTargetLabel: target?.label ?? null,
      instruction: call.instruction,
      workingCopyId: call.workingCopyId ?? null,
      resultMessageId: call.resultMessageId ?? null,
      error: call.error ?? null,
      createdAt: call.createdAt,
      startedAt: call.startedAt ?? null,
      completedAt: call.completedAt ?? null
    });
    return this.getAgentCall(call.id)!;
  }

  updateAgentCall(id: string, updates: Partial<AgentCall>): AgentCall | null {
    const current = this.getAgentCall(id);
    if (!current) return null;
    const merged = { ...current, ...updates };
    const target = merged.revisionTarget;
    this.db.prepare(`
      UPDATE agent_calls SET
        message_id = @messageId, squad_id = @squadId, agent_id = @agentId,
        requested_by = @requestedBy, operation_mode = @operationMode,
        status = @status, revision_target_type = @revisionTargetType,
        revision_target_id = @revisionTargetId, revision_target_label = @revisionTargetLabel,
        instruction = @instruction, working_copy_id = @workingCopyId,
        result_message_id = @resultMessageId, error = @error,
        started_at = @startedAt, completed_at = @completedAt
      WHERE id = @id
    `).run({
      id,
      messageId: merged.messageId ?? null,
      squadId: merged.squadId,
      agentId: merged.agentId,
      requestedBy: merged.requestedBy,
      operationMode: merged.operationMode,
      status: merged.status,
      revisionTargetType: target?.type ?? null,
      revisionTargetId: target?.id ?? null,
      revisionTargetLabel: target?.label ?? null,
      instruction: merged.instruction,
      workingCopyId: merged.workingCopyId ?? null,
      resultMessageId: merged.resultMessageId ?? null,
      error: merged.error ?? null,
      startedAt: merged.startedAt ?? null,
      completedAt: merged.completedAt ?? null
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
