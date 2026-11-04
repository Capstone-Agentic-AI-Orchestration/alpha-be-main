export type AgentRole =
  | 'Architect'
  | 'Coder'
  | 'Reviewer'
  | 'QA Tester'
  | 'DevOps'
  | 'DevOps Engineer'
  | 'Triager'
  | 'Researcher'
  | 'Research Agent'
  | 'Architecture Agent'
  | 'Manager Agent'
  | 'Orchestrator Agent'
  | 'Database Agent'
  | 'Backend Agent'
  | 'Frontend Agent'
  | 'Mobile Agent'
  | 'Security / Code Quality Agent'
  | 'Validation / Checking Agent'
  | 'GitHub Finalization Agent';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  organization?: string;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

export type AgentPhase = 'Planning' | 'Development' | 'Validation' | 'Finalization';

export type AutonomyLevel = 'Supervised' | 'Semi-Autonomous (Requires Approval)' | 'Full Autonomy';

export type ModelProvider =
  | 'Anthropic'
  | 'OpenAI'
  /** Google Antigravity (`agy`) — fronts Gemini 3.x, Claude and GPT-OSS. */
  | 'Antigravity'
  | 'Google Gemini'
  | 'Ollama'
  | 'LM Studio'
  | 'OpenCode';

/**
 * Reasoning controls exposed by the supported CLI families.
 *
 * The empty/undefined value means "Auto" and lets the selected runtime choose
 * its model default. The values are intentionally a superset because Codex,
 * Claude Code, and Antigravity expose different subsets of this same concept.
 */
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

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
  /** Optional; absent means the runtime/model default (shown as Auto). */
  reasoningEffort?: ReasoningEffort | null;
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
  /** Stable key for an official, locally seeded template. */
  templateKey?: string;
  /** Template revision used when this local instance was created. */
  templateVersion?: number;
  /** Delivery phase for a paper-aligned official role. */
  phase?: AgentPhase;
  /** True only for Alpha's built-in, idempotently seeded role instances. */
  isSeeded?: boolean;
  /** Links workspace-local copies whose profile is synchronized across workspaces. */
  sharedKey?: string;
  createdAt: string;
}

export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'agent_running' | 'review' | 'done';
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export interface IssueSubtask {
  id: string;
  title: string;
  completed: boolean;
  /** 'spec' for an item written from an approved feature spec; absent for items a person added. */
  source?: 'spec';
  /** The approved requirement this item checks, when it came from a feature spec. */
  requirementId?: string;
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

/**
 * Where a project's code is on one machine.
 *
 * Machine-local by nature, so it is never part of the project row the team
 * shares: a path from one developer's disk means nothing on another's. Each
 * desktop answers this for itself, keyed by the project's shared id.
 */
export interface LocalProjectBinding {
  projectId: string;
  localDir: string;
  /** True when Alpha cloned it; false when the developer pointed at a folder. */
  isManaged: boolean;
  activeBranch?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where one of a project's repositories is on THIS machine.
 *
 * A project can have several repositories -- a paired `-be` and `-fe` -- and
 * each is a checkout of its own, anywhere on disk, so each has its own row.
 * `repo` is `owner/name`, lower-cased.
 */
export interface LocalRepoBinding extends LocalProjectBinding {
  repo: string;
}

/**
 * One Render service or Vercel project, as `hostingService` created or last
 * confirmed it -- enough to look it up by id instead of by name next time.
 *
 * This is a cache, not the source of truth: Render and Vercel's own APIs are.
 * A resource with no `hosting` field (never set up, or set up before this
 * field existed) is rediscovered from them by the naming convention alone
 * (`<repo>` / `<repo>-uat` for Render, `<repo>` for Vercel) -- which is also
 * how the repo-keyed hosting routes work, since they run with no `Project` to
 * read a cache from at all. See `services/hosting/hostingService.ts`.
 */
export interface RenderServiceHosting {
  id: string;
  url: string | null;
  dashboardUrl: string | null;
  /** `checksPass` when the service deploys only after CI passes; `commit` when on every push. */
  autoDeployTrigger?: string | null;
}

export interface ProjectResourceHosting {
  platform: 'render' | 'vercel';
  /** Backend only: the two Render services, keyed by which branch each deploys. */
  render?: {
    main: RenderServiceHosting | null;
    uat: RenderServiceHosting | null;
  };
  /** Frontend only: the one Vercel project every environment lives under. */
  vercel?: {
    projectId: string;
  };
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
  /** Render/Vercel hosting Alpha set up for this repository. Absent means never set up, or not yet discovered. */
  hosting?: ProjectResourceHosting;
}

export interface Project {
  id: string;
  /**
   * GitHub login of the project manager who created it. A project with no
   * active PM behind it is not in the workspace's catalogue; see
   * `workspaceRegistry.isPmOwnedProject`.
   */
  createdBy?: string;
  name: string;
  key: string;
  description: string;
  color: string;
  icon: string;
  status: 'planned' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  startDate: string;
  targetDate?: string;
  completedAt?: string;
  milestones?: ProjectMilestone[];
  leadType: 'member' | 'agent';
  leadName: string;
  leadAgentId?: string;
  /** Derived from the active owned squad-project relationship. */
  leadSquadId?: string;
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

export interface ProjectMilestone {
  id: string;
  title: string;
  targetDate: string;
  completed: boolean;
  completedAt?: string;
}

export type BuildStepPhase =
  | 'requirements'
  | 'architecture'
  | 'implementation'
  | 'database'
  | 'validation'
  | 'review'
  | 'delivery';

/** An ordered, project-owned step displayed by the project build review. */
export interface ProjectBuildStep {
  id: string;
  projectId: string;
  label: string;
  phase: BuildStepPhase;
  agentId?: string;
  squadId?: string;
  position: number;
  enabled: boolean;
  required: boolean;
  approvalGate?: boolean;
  dependsOn?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export type StageId = 'workspace' | 'analysis' | 'implementation' | 'tests' | 'review';
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';

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
 * One user-safe event in a run's chronological activity feed.
 *
 * This is deliberately not a transcript of private model reasoning. It is the
 * useful operational trail: narration, tools, command/file work, status
 * changes, errors, and the final summary.
 */
export type RunActivityKind =
  | 'assistant'
  | 'tool'
  | 'tool_result'
  | 'status'
  | 'error'
  | 'summary';

export interface RunActivity {
  id: string;
  sequence: number;
  kind: RunActivityKind;
  message: string;
  toolName?: string;
  createdAt: string;
  stageId?: StageId;
  /** Provider stream identifier used to update one assistant entry in place. */
  streamKey?: string;
  /** True while a provider is still sending fragments for this entry. */
  isStreaming?: boolean;
  /** True when this entry received at least one incremental provider fragment. */
  streamed?: boolean;
  /** Optional compact command/tool detail; never private chain-of-thought. */
  detail?: string;
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

/** Check results observed by Alpha for one run; prose claims stay separate. */
export interface RunVerificationEvidence {
  status: 'passed' | 'failed' | 'skipped' | 'cancelled';
  missingScripts: string[];
  preparation?: {
    display: string;
    exitCode: number | null;
    signal: string | null;
  };
  commands: Array<{
    script: string;
    display: string;
    exitCode: number | null;
    signal: string | null;
  }>;
}

/** Aggregated run telemetry returned to the Analytics surface. */
export interface AnalyticsData {
  totalTokens24h: number;
  totalCost24h: number;
  avgLatencyMs: number;
  totalAgentRuns: number;
  successRate: number;
  tokenTimeline: Array<{
    hour: string;
    promptTokens: number;
    completionTokens: number;
    cost: number;
  }>;
  agentBreakdown: Array<{
    agentId: string;
    agentName: string;
    tokens: number;
    cost: number;
    runs: number;
    efficiency: number;
  }>;
  modelBreakdown: Array<{
    modelName: string;
    percentage: number;
    cost: number;
    totalCalls: number;
  }>;
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
export interface SquadMemberAssignment {
  agentId: string;
  stageLabel: string;
  phase?: BuildStepPhase;
  /** A concrete task boundary; the project request remains shared context. */
  instructions: string;
}

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
  /** Frozen per-member work boundaries for this run; absent on older runs. */
  memberAssignments?: SquadMemberAssignment[];
  /** Why the squad stopped early, when it did. */
  stoppedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrototypeRun {
  id: string;
  /** Workspace identity attached to process events for safe orchestration recovery. */
  workspaceId?: string;
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
  activities?: RunActivity[];
  branchName?: string;
  /** Local checkpoint observed after the runner's commit step. */
  checkpointCommit?: string;
  prUrl?: string;
  changedFiles?: number;
  insertions?: number;
  deletions?: number;
  testSummary?: string;
  verificationEvidence?: RunVerificationEvidence;
  /** Undefined when the CLI reported nothing — see RunUsage. */
  usage?: RunUsage;
  /** Set when this run is one member's turn inside a SquadRun. */
  squadRunId?: string;
  /** This member's position in the squad's order, 0-based. */
  squadOrder?: number;
  /** Local task-driven build identity; absent for legacy/direct runs. */
  orchestrationRunId?: string;
  orchestrationTaskId?: string;
  orchestrationAttemptId?: string;
  /**
   * Set on list summaries, which omit stage logs and the activity feed. Open
   * the run (GET /runs/:id) for the full record.
   */
  logsOmitted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  agentIds: string[];
  /** The responder selected for this conversation, when it is not automatic Alpha. */
  targetAgentId?: string;
  /** The squad selected for this conversation, when several agents should answer. */
  targetSquadId?: string;
  /**
   * Which project this conversation is about, when it is about one.
   *
   * Decides the directory an agent inspects for this thread. Undefined keeps
   * the managed workspace root, which is right for a conversation about
   * nothing in particular.
   */
  projectId?: string;
  /**
   * The GitHub login of whoever started this conversation.
   *
   * A developer's prompts are their working notes, not managed output, so a
   * thread is visible to its owner and to nobody else — not even a project
   * manager, who sees the work (runs, stages, patches) without the thinking
   * behind it.
   *
   * Optional only because rows created before the column exists have none.
   * Those are claimed at startup; nothing new is written without an owner.
   */
  ownerId?: string;
  createdAt: string;
}

/** User-curated notes that belong to one private conversation. */
export interface ChatThreadMemory {
  threadId: string;
  content: string;
  revision: number;
  updatedAt?: string;
}

export type AgentCallMode = 'ask' | 'review' | 'revise' | 'implement';
export type AgentCallStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'awaiting_confirmation';

export type AgentCallTargetType =
  | 'message'
  | 'agent_response'
  | 'issue'
  | 'specification'
  | 'file'
  | 'code'
  | 'branch'
  | 'commit'
  | 'pull_request'
  | 'diff';

export interface AgentCallTarget {
  type: AgentCallTargetType;
  id: string;
  label?: string;
}

export interface AgentCallArtifact {
  id: string;
  agentCallId: string;
  artifactType: 'summary' | 'finding' | 'diff' | 'patch' | 'test_result' | 'file_reference' | 'log';
  path?: string;
  contentReference?: string;
  content?: string;
  createdAt: string;
}

export type AgentCallActivityKind =
  | 'status'
  | 'stage'
  | 'tool'
  | 'tool_result'
  | 'file_change'
  | 'attachment'
  | 'steering'
  | 'handoff'
  | 'error'
  | 'summary';

export type AgentCallOrigin = 'agent_call' | 'chat_turn';

/** A safe operational event for project chat build review. */
export interface AgentCallActivity {
  id: string;
  sequence: number;
  kind: AgentCallActivityKind;
  message: string;
  toolName?: string;
  detail?: string;
  paths?: string[];
  createdAt: string;
}

export interface AgentCall {
  id: string;
  workspaceId: string;
  projectId: string;
  threadId: string;
  messageId?: string;
  squadId: string;
  agentId: string;
  requestedBy: string;
  operationMode: AgentCallMode;
  origin?: AgentCallOrigin;
  status: AgentCallStatus;
  revisionTarget?: AgentCallTarget;
  instruction: string;
  workingCopyId?: string;
  workingBranch?: string;
  /** Git HEAD observed when the independent call generated its proposal. */
  workingCommit?: string;
  resultMessageId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  artifacts: AgentCallArtifact[];
  activities: AgentCallActivity[];
}

export interface ProjectChatAgent {
  id: string;
  name: string;
  role: string;
  description?: string;
  avatar?: string;
  color?: string;
  squadId: string;
  squadName: string;
  availability: 'ready';
  supportedModes: AgentCallMode[];
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
  messageType?: 'user' | 'assistant' | 'agent' | 'system' | 'agent_call' | 'build' | 'build_milestone' | 'build_proposal' | 'project_needed';
  agentCallId?: string;
  /** The task workflow shown beneath an Orchestrator build message. */
  orchestrationRunId?: string;
  /** A build Alpha proposed instead of starting, awaiting the user's answer. */
  routeProposal?: ChatRouteProposal;
  squadId?: string;
  operationMode?: AgentCallMode;
  agentCallStatus?: AgentCallStatus;
  revisionTarget?: AgentCallTarget;
  /** Local-only file references. File bytes never leave the desktop attachment store. */
  attachments?: ChatAttachmentReference[];
  timestamp: string;
}

/** A build Alpha proposed in chat, kept so the user's answer can start it later. */
export interface ChatRouteProposal {
  /** The user message the proposal answers. */
  sourceMessageId: string;
  goal: string;
  repositories: string[];
  status: 'open' | 'accepted' | 'dismissed';
}

export type OrchestrationRecoveryCategory =
  | 'project_code'
  | 'report'
  | 'review_input'
  | 'provider'
  | 'configuration'
  | 'workspace'
  | 'final_validation'
  | 'budget'
  | 'alpha'
  | 'unknown';

export type OrchestrationRecoveryPhase =
  | 'repairing'
  | 'waiting_for_user'
  | 'ready_to_continue'
  | 'resolved'
  | 'cancelled';

export type OrchestrationRecoveryActionName =
  | 'explain_failure'
  | 'retry_report_format'
  | 'repair_and_continue'
  | 'provide_guidance'
  | 'recheck_prerequisite'
  | 'plan_final_validation_corrections'
  | 'resume_checkpoint'
  | 'review_saved_changes'
  | 'keep_paused'
  | 'cancel_build';

export interface OrchestrationRecoveryEpisode {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  issueId: string;
  taskId?: string;
  attemptId?: string;
  source: string;
  category: OrchestrationRecoveryCategory;
  code: string;
  summary: string;
  fingerprint: string;
  phase: OrchestrationRecoveryPhase;
  episodeNumber: number;
  repairBudget: number;
  attemptsUsed: number;
  guidance?: string;
  evidence: Record<string, unknown>;
  threadId?: string;
  buildMessageId?: string;
  initiatedBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface OrchestrationRecoveryProjection {
  id: string;
  runId: string;
  phase: OrchestrationRecoveryPhase;
  category: OrchestrationRecoveryCategory;
  code: string;
  summary: string;
  taskId?: string;
  taskTitle?: string;
  taskRevision?: number;
  attemptsUsed: number;
  repairBudget: number;
  reportCorrectionsUsed?: number;
  reportCorrectionLimit?: number;
  episodeNumber: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  availableActions: OrchestrationRecoveryActionName[];
  actionReasons: Partial<Record<OrchestrationRecoveryActionName, string>>;
}

export interface OrchestrationRecoveryActionRecord {
  id: string;
  workspaceId: string;
  runId: string;
  recoveryId: string;
  actorId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedRecoveryRevision: number;
  expectedTaskRevision?: number;
  action: OrchestrationRecoveryActionName;
  guidance?: string;
  status: 'pending' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  errorCode?: string;
  createdAt: string;
  completedAt?: string;
}

export interface OrchestrationRecoveryMilestone {
  id: string;
  workspaceId: string;
  runId: string;
  recoveryId: string;
  milestoneKey: string;
  threadId: string;
  messageId: string;
  content: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface ChatAttachmentReference {
  id: string;
  name: string;
  contentType: string;
  byteLength: number;
  inspection: 'included_text' | 'available_to_runtime' | 'stored_only';
}

export interface ChatAttachmentRecord extends ChatAttachmentReference {
  threadId: string;
  messageId?: string;
  storageName: string;
  createdAt: string;
}

export type RuntimeStatus = 'online' | 'degraded' | 'offline' | 'scanning';

/** How Alpha obtained a runtime's model catalog. */
export type RuntimeCatalogSource = 'cli' | 'local_api' | 'remote_api' | 'cache' | 'none';
export type RuntimeUpdateSource = 'provider_cli' | 'npm' | 'remote_api' | 'none';

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
  /** Optional local gateway endpoint, e.g. OpenCodex's OpenAI-compatible API. */
  endpoint?: string;
  version?: string;
  isDefault?: boolean;
  models: string[];
  account?: {
    email?: string;
    org?: string;
    /** How the runtime authenticates to its provider. */
    authMethod?: string;
    /** Account-backed access does not always reveal a paid tier. */
    billing?: 'subscription' | 'api' | 'account' | 'unknown';
    plan?: string;
    note?: string;
  };
  detectedAt?: string;
  /** Model-catalog freshness and provenance. */
  catalogSource?: RuntimeCatalogSource;
  catalogCheckedAt?: string;
  catalogFetchedAt?: string;
  catalogStale?: boolean;
  catalogError?: string;
  /** Runtime-version update information, kept separate from model discovery. */
  updateAvailable?: boolean;
  latestVersion?: string;
  updateCheckedAt?: string;
  updateError?: string;
  updateSource?: RuntimeUpdateSource;
}

export interface Skill {
  id: string;
  name: string;
  category: 'File Operations' | 'Terminal' | 'MCP Servers' | 'Git' | 'Browser' | 'Code Execution' | 'Agent Skills';
  permissions: 'read_only' | 'write' | 'full_execution';
  description: string;
  isEnabled: boolean;
  commandExample?: string;
  /** Where Alpha found the skill definition. Built-in rows omit this on older databases. */
  source?: 'builtin' | 'system_detected' | 'mcp_server' | 'user' | 'project' | 'plugin';
  /** Absolute path to the installed SKILL.md when this is filesystem-detected. */
  path?: string;
  /** True when the backing SKILL.md was present during the last scan. */
  installed?: boolean;
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
