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
  projectId: string;
  assignedAgentId?: string;
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
  createdAt: string;
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

export interface PrototypeRun {
  id: string;
  issueId: string;
  projectId: string;
  agentId: string;
  status: 'running' | 'awaiting_approval' | 'validating' | 'failed' | 'completed' | 'cancelled';
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
  createdAt: string;
  updatedAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  agentIds: string[];
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
}

export interface Squad {
  id: string;
  name: string;
  topology: 'Sequential' | 'Hierarchical' | 'Consensus';
  leaderAgentId?: string;
  memberAgentIds: string[];
  mission: string;
  activeRunsCount: number;
  completedRunsCount: number;
}
