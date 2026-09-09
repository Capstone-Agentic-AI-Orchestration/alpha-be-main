export type AgentRole = 'Architect' | 'Coder' | 'Reviewer' | 'QA Tester' | 'DevOps' | 'Triager' | 'Researcher';

export type AutonomyLevel = 'Supervised' | 'Semi-Autonomous (Requires Approval)' | 'Full Autonomy';

export type ModelProvider =
  | 'Anthropic'
  | 'OpenAI'
  /** Google Antigravity (`agy`) — fronts Gemini 3.x, Claude and GPT-OSS. */
  | 'Antigravity'
  | 'Google Gemini'
  | 'Ollama'
  | 'LM Studio';

/** Mirrors the client's AgentAccessLevel; the two apps share no package. */
export type AgentAccessLevel = 'everyone' | 'team' | 'admins' | 'private';

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  avatar: string;
  color: string;
  description: string;
  owner: string;
  isMine: boolean;
  modelProvider: ModelProvider;
  modelName: string;
  systemPrompt: string;
  autonomyLevel: AutonomyLevel;
  temperature?: number;
  skills: string[];
  mcpServers: string[];
  customCliArgs?: string;
  envVars?: { key: string; value: string; isSecret?: boolean }[];
  concurrencyLimit?: number;
  isArchived?: boolean;
  /** Who may use this agent. Absent on rows written before the column existed. */
  allowedUsers?: AgentAccessLevel;
  createdAt: string;
}

export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'agent_running' | 'review' | 'done';
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export interface IssueSubtask {
  id: string;
  title: string;
  completed: boolean;
}

export interface IssueComment {
  /**
   * The GitHub comment id, once this has been published there.
   *
   * Absent means local-only and still to be pushed — which is how the sync
   * knows what to send without a separate queue.
   */
  githubId?: number;
  id: string;
  issueId: string;
  authorType: 'user' | 'agent' | 'system';
  authorName: string;
  authorAvatar?: string;
  agentId?: string;
  content: string;
  createdAt: string;
  isThinking?: boolean;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  /**
   * Who created this issue — a GitHub login, or an OS username when GitHub is
   * not signed in. Absent on issues written before Alpha recorded it.
   */
  createdBy?: string;
  /** `owner/repo` of the GitHub issue this is, when the board is shared. */
  githubRepo?: string;
  /** Issue number within that repository. Unique only alongside `githubRepo`. */
  githubNumber?: number;
  githubUrl?: string;
  projectId: string;
  assignedAgentId?: string;
  /**
   * The squad assigned to this issue, when a whole squad owns it rather than
   * one agent. Absent is the ordinary case.
   */
  assignedSquadId?: string;
  assignedHuman?: string;
  labels: string[];
  subtasks: IssueSubtask[];
  comments: IssueComment[];
  branchName?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectResource {
  id: string;
  type: 'github_repo' | 'local_path' | 'local_dir' | 'documentation' | 'api_endpoint';
  name: string;
  pathOrUrl: string;
  branchOrMachine?: string;
  /** Stack the scaffold was generated from. Absent on attached repositories. */
  stack?: string;
  /** Repository shape the scaffold used. Absent on attached repositories. */
  shape?: string;
  /**
   * Managed working copy on this machine, when Alpha created or cloned it.
   * Absent means there is no local checkout yet.
   */
  localPath?: string;
}

export interface Project {
  id: string;
  name: string;
  key: string;
  description: string;
  color: string;
  icon: string;
  status: 'planned' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  startDate: string;
  targetDate?: string;
  leadType: 'member' | 'agent';
  leadName: string;
  leadAgentId?: string;
  resources: ProjectResource[];
  /**
   * GitHub organization every repository for this project is created under.
   * Alpha creates no personal repositories, so without this the project cannot
   * create one at all.
   */
  githubOrg?: string;
  createdAt: string;

  /**
   * Environment values for work on this project.
   *
   * Resolves `${VAR}` in MCP server definitions, so one global catalog entry
   * can point at a different Supabase project (or database, or workspace) per
   * Alpha project. Overrides the daemon's own environment; an agent's own
   * envVars override these in turn.
   */
  envVars?: { key: string; value: string; isSecret?: boolean }[];
}

export type StageId = 'workspace' | 'analysis' | 'implementation' | 'tests' | 'review';
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface PrototypeRunStage {
  id: StageId;
  label: string;
  description: string;
  status: StageStatus;
  durationMs?: number;
  logs: string[];
  startedAt?: string;
  completedAt?: string;
}

/**
 * Token and cost figures a CLI reported for a run.
 *
 * Every field is optional and every one means something different when absent:
 * the CLI did not report it. `codex` says nothing about cache reads, Claude
 * does not break thinking tokens out of its output count, and Antigravity
 * reports no cost at all. A missing figure must stay missing rather than
 * becoming a zero on a billing screen.
 *
 * See services/runUsage.ts for how these are accumulated.
 */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  thinkingTokens?: number;
  /** What the CLI says the equivalent API call would have cost. */
  costUsd?: number;
  numTurns?: number;
}

/**
 * One squad working one issue.
 *
 * The squad feature existed as CRUD and a button: `triggerSquadRun` incremented
 * a counter, posted a notification and set a 4.5s timer that marked the run
 * complete. No process was spawned and no agent was told anything.
 *
 * A squad run owns an ordered list of PrototypeRuns — one per member — sharing
 * a single git branch, executed one after another.
 */
export interface SquadRun {
  id: string;
  squadId: string;
  issueId: string;
  projectId: string;
  /** The branch every member commits to. Created once, by the first member. */
  branchName: string;
  /** Member agent ids in execution order. Leader first when the squad has one. */
  memberAgentIds: string[];
  /** Index into memberAgentIds of the member currently running. */
  currentMemberIndex: number;
  status: 'running' | 'awaiting_approval' | 'failed' | 'cancelled';
  mission: string;
  plan: string[];
  /** Why the squad stopped early, when it did. */
  stoppedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrototypeRun {
  id: string;
  issueId: string;
  projectId: string;
  agentId: string;
  /**
   * `queued` means accepted but not started: another run holds this project's
   * working directory. Reporting it as `running` would be the same untruth as
   * a run claiming tests it never executed — nothing is executing yet.
   */
  status: 'queued' | 'running' | 'awaiting_approval' | 'validating' | 'failed' | 'completed' | 'cancelled';
  scenario?: 'success' | 'test_failure' | 'review_required';
  plan: string[];
  currentStageIndex: number;
  stages: PrototypeRunStage[];
  branchName?: string;
  prUrl?: string;
  changedFiles?: number;
  insertions?: number;
  deletions?: number;
  testSummary?: string;
  /** Undefined when the CLI reported nothing — see RunUsage. */
  usage?: RunUsage;
  /** Set when this run is one member's turn inside a SquadRun. */
  squadRunId?: string;
  /** This member's position in the squad's order, 0-based. */
  squadOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  agentIds: string[];
  /**
   * Which project this conversation is about, when it is about one.
   *
   * Decides the directory an agent inspects for this thread. Undefined keeps
   * the managed workspace root, which is right for a conversation about
   * nothing in particular.
   */
  projectId?: string;
  createdAt: string;
}

export interface ToolExecutionRecord {
  id: string;
  toolName: string;
  parameters: Record<string, any>;
  output?: string;
  status: 'executing' | 'success' | 'failed';
  executedAt: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  senderType: 'user' | 'agent' | 'system';
  senderName: string;
  agentId?: string;
  content: string;
  thinkingProcess?: string;
  toolsExecuted?: ToolExecutionRecord[];
  timestamp: string;
}

export type RuntimeStatus = 'online' | 'degraded' | 'offline' | 'scanning';

export interface RuntimeEngine {
  id: string;
  name: string;
  provider: ModelProvider;
  status: RuntimeStatus;
  /**
   * Where inference happens — NOT where the process runs.
   * The `claude` / `codex` / `gemini` CLIs run locally but call a hosted model,
   * so they are 'cloud'. Ollama and LM Studio are 'local'.
   * Omitting this made the frontend fall back to labelling every row
   * "Cloud Gateway", including the local engines.
   */
  type: 'local' | 'cloud' | 'remote';
  /** Measured probe round-trip. Was previously absent, so the UI showed a fixed 25ms. */
  latencyMs: number;
  version?: string;
  isDefault?: boolean;
  models: string[];
  account?: {
    email?: string;
    org?: string;
    billing?: 'subscription' | 'api';
    plan?: string;
  };
  detectedAt?: string;
}

export interface Skill {
  id: string;
  name: string;
  category: 'File Operations' | 'Terminal' | 'MCP Servers' | 'Git' | 'Browser' | 'Code Execution';
  permissions: 'read_only' | 'write' | 'full_execution';
  description: string;
  isEnabled: boolean;
  commandExample?: string;
  /**
   * CLI tools this skill grants a chat turn, from SKILL_TOOLS.
   *
   * Attached by the API rather than stored: the mapping is policy, not data, and
   * a copy in the database would be one more thing to drift out of step with the
   * runner. Empty means the skill grants no CLI tool — which is not the same as
   * granting nothing, `sk-git` being the case that matters.
   */
  grantedTools?: readonly string[];
}

export interface Squad {
  id: string;
  name: string;
  /**
   * Identity the create form collects and the squad list renders.
   *
   * Optional because rows written before these columns existed have none, and
   * the read path substitutes an empty string rather than null.
   */
  description?: string;
  avatar?: string;
  color?: string;
  /**
   * Stored as sent, not normalised.
   *
   * The client's own union is lowercase and includes a `swarm` the daemon has
   * no behaviour for, so this deliberately does not claim to be exhaustive —
   * `isSupportedTopology` is what decides whether a squad can actually run, and
   * it compares case-insensitively for exactly this reason.
   */
  topology: string;
  leaderAgentId?: string;
  memberAgentIds: string[];
  mission: string;
  activeRunsCount: number;
  completedRunsCount: number;
}

/**
 * One thing Alpha or an agent did to a remote repository.
 *
 * `actor` distinguishes them because the answer to "who pushed this" was
 * previously unavailable: Alpha's pipeline and the agent it was running both
 * reached GitHub, and neither left a record the UI could show.
 */
export interface RemoteAction {
  id: string;
  runId?: string;
  agentId?: string;
  issueId?: string;
  /** `alpha` is the pipeline acting on its own; `user` is a person in the UI. */
  actor: 'agent' | 'alpha' | 'user';
  /** What was attempted, e.g. `push`, `open_pull_request`, `merge_pull_request`. */
  action: string;
  /** What it acted on — a branch name or a pull request URL. */
  target?: string;
  /** One sentence of outcome, or the failure reason. */
  detail?: string;
  succeeded: boolean;
  createdAt: string;
}
