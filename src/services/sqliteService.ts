import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DB_PATH, ALPHA_DIR, WORKSPACES_DIR } from '../config/env.js';
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
  SquadRun
} from '../models/index.js';
import { syncAgentFile, deleteAgentFile, readAgentFile } from './agentFileService.js';
import { ensureMemoryScaffold } from './memoryService.js';

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

export class SQLiteService {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initPragmas();
    this.initTables();
    this.migrate();
    this.seedDefaultsIfEmpty();
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
      CREATE TABLE IF NOT EXISTS allowed_paths (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        added_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
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

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        avatar TEXT,
        color TEXT,
        description TEXT,
        owner TEXT DEFAULT 'You',
        is_mine INTEGER DEFAULT 1,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS prototype_runs (
        id TEXT PRIMARY KEY,
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS squads (
        id TEXT PRIMARY KEY,
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
        command_example TEXT
      );

      CREATE TABLE IF NOT EXISTS runtimes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        type TEXT DEFAULT 'cloud',
        latency_ms INTEGER DEFAULT 0,
        version TEXT,
        is_default INTEGER DEFAULT 0,
        models TEXT DEFAULT '[]',
        account TEXT DEFAULT '{}',
        detected_at TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        last_message_snippet TEXT,
        last_message_at TEXT NOT NULL,
        agent_ids TEXT DEFAULT '[]',
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
        timestamp TEXT NOT NULL
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
      ['runtimes', "type TEXT DEFAULT 'cloud'"],
      ['runtimes', 'latency_ms INTEGER DEFAULT 0'],
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
      ['chat_threads', 'project_id TEXT']
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
    `);
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
    const defaultSkills: Skill[] = [
      { id: 'sk-fs', name: 'Filesystem Operations', category: 'File Operations', permissions: 'write', description: 'Read, write, create, delete, and grep files within project directory.', isEnabled: true, commandExample: 'fs.read_file("src/index.ts")' },
      { id: 'sk-bash', name: 'Terminal & Shell', category: 'Terminal', permissions: 'full_execution', description: 'Execute terminal commands (e.g. npm test, vitest, tsc, cargo build).', isEnabled: true, commandExample: 'bash.exec("npm test")' },
      { id: 'sk-git', name: 'Git & GitHub', category: 'Git', permissions: 'write', description: 'Create branches, stage files, commit changes, create PRs, and inspect diffs.', isEnabled: true, commandExample: 'git.diff()' },
      { id: 'sk-browser', name: 'Web & Headless Browser', category: 'Browser', permissions: 'read_only', description: 'Fetch documentation, query web endpoints, and parse markdown.', isEnabled: true, commandExample: 'browser.fetch("https://docs.anthropic.com")' },
      { id: 'sk-code-exec', name: 'Code Execution Sandbox', category: 'Code Execution', permissions: 'full_execution', description: 'Run isolated scripts to verify algorithms or test patches.', isEnabled: true, commandExample: 'code.eval("Math.max(1, 2)")' }
    ];

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
        modelName: 'claude-sonnet-5',
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
        modelName: 'claude-sonnet-5',
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
        modelName: 'codex',
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
        modelName: 'claude-sonnet-5',
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
        modelName: 'claude-sonnet-5',
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

    defaultAgents.forEach(a => this.createAgent(a));

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
      leaderAgentId: 'agent-architect',
      memberAgentIds: ['agent-architect', 'agent-developer', 'agent-reviewer', 'agent-tester'],
      mission: 'Autonomous triage, implementation, and static code review of incoming Capstone issues.',
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
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({
      ...r,
      startDate: r.start_date,
      targetDate: r.target_date,
      leadType: r.lead_type,
      leadName: r.lead_name,
      leadAgentId: r.lead_agent_id,
      resources: JSON.parse(r.resources || '[]'),
      githubOrg: r.github_org || undefined,
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
      INSERT INTO projects (id, name, key, description, color, icon, status, priority, start_date, target_date, lead_type, lead_name, lead_agent_id, resources, github_org, created_at)
      VALUES (@id, @name, @key, @description, @color, @icon, @status, @priority, @startDate, @targetDate, @leadType, @leadName, @leadAgentId, @resources, @githubOrg, @createdAt)
    `);
    stmt.run({
      ...complete,
      startDate: complete.startDate || now,
      targetDate: complete.targetDate || null,
      leadType: complete.leadType || 'agent',
      leadName: complete.leadName || '',
      leadAgentId: complete.leadAgentId || null,
      resources: JSON.stringify(complete.resources || []),
      githubOrg: complete.githubOrg || null,
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
        github_org = @githubOrg
      WHERE id = @id
    `);
    stmt.run({
      ...merged,
      resources: JSON.stringify(merged.resources || []),
      githubOrg: merged.githubOrg || null
    });
    return merged;
  }

  deleteProject(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM projects WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
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
      GROUP BY agent_id
    `).all() as any[];

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
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as any[];
    const stats = this.agentStats();
    return rows.map(r => ({
      ...r,
      isMine: Boolean(r.is_mine),
      isArchived: Boolean(r.is_archived),
      modelProvider: r.model_provider,
      modelName: r.model_name,
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
      INSERT INTO agents (id, name, role, avatar, color, description, owner, is_mine, model_provider, model_name, system_prompt, autonomy_level, temperature, skills, mcp_servers, custom_cli_args, env_vars, concurrency_limit, is_archived, allowed_users, created_at)
      VALUES (@id, @name, @role, @avatar, @color, @description, @owner, @isMine, @modelProvider, @modelName, @systemPrompt, @autonomyLevel, @temperature, @skills, @mcpServers, @customCliArgs, @envVars, @concurrencyLimit, @isArchived, @allowedUsers, @createdAt)
    `);
    stmt.run({
      ...a,
      isMine: a.isMine ? 1 : 0,
      isArchived: a.isArchived ? 1 : 0,
      temperature: a.temperature ?? 0.7,
      skills: JSON.stringify(a.skills || []),
      mcpServers: JSON.stringify(a.mcpServers || []),
      envVars: JSON.stringify(a.envVars || []),
      customCliArgs: a.customCliArgs || '',
      concurrencyLimit: a.concurrencyLimit ?? 2,
      // The column is nullable and the field optional, but better-sqlite3 needs
      // every named parameter bound, so the absence has to be explicit.
      allowedUsers: a.allowedUsers ?? null,
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
        model_provider = @modelProvider, model_name = @modelName, system_prompt = @systemPrompt,
        autonomy_level = @autonomyLevel, temperature = @temperature, skills = @skills,
        mcp_servers = @mcpServers, custom_cli_args = @customCliArgs, env_vars = @envVars,
        concurrency_limit = @concurrencyLimit, is_archived = @isArchived,
        allowed_users = @allowedUsers
      WHERE id = @id
    `);
    stmt.run({
      ...merged,
      isArchived: merged.isArchived ? 1 : 0,
      allowedUsers: merged.allowedUsers ?? null,
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
    const stmt = this.db.prepare('DELETE FROM agents WHERE id = ?');
    const res = stmt.run(id);

    // Only when a row really went away, so a delete of an unknown id does not
    // remove a file that some other agent might still be using.
    if (res.changes > 0) deleteAgentFile(id);

    return res.changes > 0;
  }

  // --- Issues ---
  getIssues(): Issue[] {
    const rows = this.db.prepare('SELECT * FROM issues ORDER BY created_at DESC').all() as any[];
    const comments = this.db.prepare('SELECT * FROM issue_comments ORDER BY created_at ASC').all() as any[];

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
      assignedAgentId: r.assigned_agent_id,
      assignedHuman: r.assigned_human,
      labels: JSON.parse(r.labels || '[]'),
      subtasks: JSON.parse(r.subtasks || '[]'),
      branchName: r.branch_name,
      prUrl: r.pr_url,
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
      .prepare('SELECT identifier FROM issues WHERE project_id = ?')
      .all(projectId) as { identifier: string }[];

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
    const projectId = issue.projectId || this.getProjects()[0]?.id || '';

    const complete: Issue = {
      ...issue,
      id: issue.id || `issue-${Date.now()}`,
      identifier: issue.identifier || this.nextIssueIdentifier(projectId),
      title: issue.title || 'Untitled Issue',
      description: issue.description ?? '',
      status: issue.status || 'todo',
      priority: issue.priority || 'medium',
      projectId,
      labels: issue.labels || [],
      subtasks: issue.subtasks || [],
      comments: issue.comments || [],
      createdAt: issue.createdAt || now,
      updatedAt: issue.updatedAt || now
    } as Issue;

    const stmt = this.db.prepare(`
      INSERT INTO issues (id, identifier, title, description, status, priority, project_id, assigned_agent_id, assigned_human, labels, subtasks, branch_name, pr_url, created_at, updated_at)
      VALUES (@id, @identifier, @title, @description, @status, @priority, @projectId, @assignedAgentId, @assignedHuman, @labels, @subtasks, @branchName, @prUrl, @createdAt, @updatedAt)
    `);
    stmt.run({
      ...complete,
      labels: JSON.stringify(complete.labels),
      subtasks: JSON.stringify(complete.subtasks),
      assignedAgentId: complete.assignedAgentId || null,
      assignedHuman: complete.assignedHuman || null,
      branchName: complete.branchName || null,
      prUrl: complete.prUrl || null
    });

    for (const c of complete.comments) this.addIssueComment(c);

    return complete;
  }

  updateIssue(id: string, updates: Partial<Issue>): Issue | null {
    const existing = this.getIssues().find(i => i.id === id);
    if (!existing) return null;
    const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    const stmt = this.db.prepare(`
      UPDATE issues SET
        title = @title, description = @description, status = @status, priority = @priority,
        project_id = @projectId, assigned_agent_id = @assignedAgentId, assigned_human = @assignedHuman,
        labels = @labels, subtasks = @subtasks, branch_name = @branchName, pr_url = @prUrl, updated_at = @updatedAt
      WHERE id = @id
    `);
    stmt.run({
      ...merged,
      labels: JSON.stringify(merged.labels || []),
      subtasks: JSON.stringify(merged.subtasks || [])
    });
    return merged;
  }

  deleteIssue(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM issues WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
  }

  addIssueComment(c: IssueComment): IssueComment {
    const stmt = this.db.prepare(`
      INSERT INTO issue_comments (id, issue_id, author_type, author_name, author_avatar, agent_id, content, is_thinking, created_at)
      VALUES (@id, @issueId, @authorType, @authorName, @authorAvatar, @agentId, @content, @isThinking, @createdAt)
    `);
    stmt.run({
      ...c,
      authorAvatar: c.authorAvatar || null,
      agentId: c.agentId || null,
      isThinking: c.isThinking ? 1 : 0,
      createdAt: c.createdAt || new Date().toISOString()
    });
    return c;
  }

  // --- Prototype Runs ---
  getPrototypeRuns(): PrototypeRun[] {
    const rows = this.db.prepare('SELECT * FROM prototype_runs ORDER BY created_at DESC').all() as any[];
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

  savePrototypeRun(run: PrototypeRun): PrototypeRun {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO prototype_runs (id, issue_id, project_id, agent_id, status, scenario, plan, current_stage_index, stages, branch_name, pr_url, changed_files, insertions, deletions, test_summary, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, cost_usd, num_turns, squad_run_id, squad_order, created_at, updated_at)
      VALUES (@id, @issueId, @projectId, @agentId, @status, @scenario, @plan, @currentStageIndex, @stages, @branchName, @prUrl, @changedFiles, @insertions, @deletions, @testSummary, @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreationTokens, @thinkingTokens, @costUsd, @numTurns, @squadRunId, @squadOrder, @createdAt, @updatedAt)
    `);
    stmt.run({
      id: run.id,
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
    const rows = this.db.prepare('SELECT * FROM squad_runs ORDER BY created_at DESC').all() as any[];
    return rows.map(squadRunFromRow);
  }

  getSquadRun(id: string): SquadRun | undefined {
    const row = this.db.prepare('SELECT * FROM squad_runs WHERE id = ?').get(id) as any;
    return row ? squadRunFromRow(row) : undefined;
  }

  saveSquadRun(run: SquadRun): SquadRun {
    this.db.prepare(`
      INSERT OR REPLACE INTO squad_runs
        (id, squad_id, issue_id, project_id, branch_name, member_agent_ids,
         current_member_index, status, mission, plan, stopped_reason, created_at, updated_at)
      VALUES
        (@id, @squadId, @issueId, @projectId, @branchName, @memberAgentIds,
         @currentMemberIndex, @status, @mission, @plan, @stoppedReason, @createdAt, @updatedAt)
    `).run({
      ...run,
      memberAgentIds: JSON.stringify(run.memberAgentIds || []),
      plan: JSON.stringify(run.plan || []),
      stoppedReason: run.stoppedReason ?? null
    });
    return run;
  }

  /** The member runs of a squad run, in execution order. */
  getRunsForSquadRun(squadRunId: string): PrototypeRun[] {
    return this.getPrototypeRuns()
      .filter(r => r.squadRunId === squadRunId)
      .sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0));
  }

  // --- Squads ---
  getSquads(): Squad[] {
    const rows = this.db.prepare('SELECT * FROM squads').all() as any[];
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
        (id, name, description, avatar, color, topology, leader_agent_id, member_agent_ids, mission, active_runs_count, completed_runs_count)
      VALUES
        (@id, @name, @description, @avatar, @color, @topology, @leaderAgentId, @memberAgentIds, @mission, @activeRunsCount, @completedRunsCount)
    `);
    stmt.run({
      ...squad,
      description: squad.description ?? '',
      avatar: squad.avatar ?? '',
      color: squad.color ?? '',
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
      WHERE id = @id
    `).run({
      ...merged,
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
    return this.db.prepare('DELETE FROM squads WHERE id = ?').run(id).changes > 0;
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
      commandExample: r.command_example
    }));
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
      version: r.version,
      isDefault: Boolean(r.is_default),
      models: JSON.parse(r.models || '[]'),
      account: JSON.parse(r.account || '{}'),
      detectedAt: r.detected_at
    }));
  }

  saveRuntimes(runtimes: RuntimeEngine[]) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO runtimes (id, name, provider, status, type, latency_ms, version, is_default, models, account, detected_at)
      VALUES (@id, @name, @provider, @status, @type, @latencyMs, @version, @isDefault, @models, @account, @detectedAt)
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
          version: r.version || null,
          isDefault: r.isDefault ? 1 : 0,
          models: JSON.stringify(r.models || []),
          account: JSON.stringify(r.account || {}),
          detectedAt: r.detectedAt || new Date().toISOString()
        });
      }
    });
    tx(runtimes);
  }

  // --- Chat ---
  getChatThreads(): ChatThread[] {
    const rows = this.db.prepare('SELECT * FROM chat_threads ORDER BY last_message_at DESC').all() as any[];
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      lastMessageSnippet: r.last_message_snippet,
      lastMessageAt: r.last_message_at,
      agentIds: JSON.parse(r.agent_ids || '[]'),
      projectId: r.project_id ?? undefined,
      createdAt: r.created_at
    }));
  }

  getChatMessages(threadId: string): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY timestamp ASC').all(threadId) as any[];
    return rows.map(r => ({
      id: r.id,
      threadId: r.thread_id,
      senderType: r.sender_type,
      senderName: r.sender_name,
      agentId: r.agent_id,
      content: r.content,
      thinkingProcess: r.thinking_process,
      toolsExecuted: JSON.parse(r.tools_executed || '[]'),
      timestamp: r.timestamp
    }));
  }

  saveChatMessage(msg: ChatMessage) {
    const stmt = this.db.prepare(`
      INSERT INTO chat_messages (id, thread_id, sender_type, sender_name, agent_id, content, thinking_process, tools_executed, timestamp)
      VALUES (@id, @threadId, @senderType, @senderName, @agentId, @content, @thinkingProcess, @toolsExecuted, @timestamp)
    `);
    stmt.run({
      ...msg,
      agentId: msg.agentId || null,
      toolsExecuted: JSON.stringify(msg.toolsExecuted || []),
      thinkingProcess: msg.thinkingProcess || null
    });

    const updateThread = this.db.prepare(`
      UPDATE chat_threads SET
        last_message_snippet = ?,
        last_message_at = ?
      WHERE id = ?
    `);
    updateThread.run(msg.content.slice(0, 100), msg.timestamp, msg.threadId);
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
      projectId: thread.projectId,
      createdAt: thread.createdAt || now
    };

    this.db.prepare(`
      INSERT INTO chat_threads (id, title, last_message_snippet, last_message_at, agent_ids, project_id, created_at)
      VALUES (@id, @title, @lastMessageSnippet, @lastMessageAt, @agentIds, @projectId, @createdAt)
    `).run({
      ...complete,
      agentIds: JSON.stringify(complete.agentIds),
      // Bound explicitly: the column is nullable and the field optional, but
      // better-sqlite3 requires every named parameter to be present.
      projectId: complete.projectId ?? null
    });

    return complete;
  }

  /** Persist the agent roster on a thread once it is known. */
  setChatThreadAgents(threadId: string, agentIds: string[]) {
    this.db.prepare('UPDATE chat_threads SET agent_ids = ? WHERE id = ?')
      .run(JSON.stringify(agentIds), threadId);
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
    const removed = this.db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId).changes > 0;
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
    this.db.prepare("UPDATE chat_threads SET last_message_snippet = '' WHERE id = ?").run(threadId);
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

    this.db.prepare('UPDATE chat_threads SET project_id = ? WHERE id = ?')
      .run(projectId, threadId);

    return this.getChatThreads().find(t => t.id === threadId) ?? null;
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

export const sqliteService = new SQLiteService();
