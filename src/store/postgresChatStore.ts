import type { ChatMessage, ChatThread, ToolExecutionRecord, AgentCallMode, AgentCallStatus, AgentCallTarget } from '../models/index.js';
import type { Sql } from './database.js';
import type { ChatStore } from './chatStore.js';

/**
 * Conversations in the cloud.
 *
 * Read-only, because the cloud never holds one: an agent answers on the
 * machine that runs it, and the desktop publishes what was said. What this
 * serves is a person reading their own history on the web -- their own, and
 * scoped by `owner_id` in the statement rather than filtered afterwards.
 */
export class PostgresChatStore implements ChatStore {
  constructor(private readonly sql: Sql) {}

  async listThreads(workspaceId: string, ownerId: string): Promise<ChatThread[]> {
    const { rows } = await this.sql.query<ThreadRow>(
      'select * from chat_threads where workspace_id = $1 and owner_id = $2 order by last_message_at desc',
      [workspaceId, ownerId]
    );
    return rows.map(toThread);
  }

  async messages(workspaceId: string, threadId: string, ownerId: string): Promise<ChatMessage[] | null> {
    const { rows: threads } = await this.sql.query(
      'select id from chat_threads where workspace_id = $1 and id = $2 and owner_id = $3',
      [workspaceId, threadId, ownerId]
    );
    if (!threads.length) return null;

    const { rows } = await this.sql.query<MessageRow>(
      'select * from chat_messages where thread_id = $1 order by timestamp asc',
      [threadId]
    );
    return rows.map(toMessage);
  }
}

type Timestamp = Date | string;

export interface ThreadRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  last_message_snippet: string | null;
  last_message_at: Timestamp;
  agent_ids: string[] | null;
  target_agent_id: string | null;
  target_squad_id: string | null;
  created_at: Timestamp;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  sender_type: string;
  sender_name: string;
  agent_id: string | null;
  content: string;
  thinking_process: string | null;
  tools_executed: ToolExecutionRecord[] | null;
  message_type: string | null;
  agent_call_id: string | null;
  squad_id: string | null;
  operation_mode: string | null;
  agent_call_status: string | null;
  revision_target: AgentCallTarget | string | null;
  skill_ids: string[] | null;
  timestamp: Timestamp;
}

const iso = (value: Timestamp): string => new Date(value).toISOString();

export function toThread(row: ThreadRow): ChatThread {
  return {
    id: row.id,
    title: row.title,
    lastMessageSnippet: row.last_message_snippet ?? '',
    lastMessageAt: iso(row.last_message_at),
    agentIds: row.agent_ids ?? [],
    targetAgentId: row.target_agent_id ?? undefined,
    targetSquadId: row.target_squad_id ?? undefined,
    projectId: row.project_id ?? undefined,
    ownerId: row.owner_id,
    createdAt: iso(row.created_at)
  } as ChatThread;
}

export function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderType: row.sender_type as ChatMessage['senderType'],
    senderName: row.sender_name,
    agentId: row.agent_id ?? undefined,
    content: row.content,
    thinkingProcess: row.thinking_process ?? undefined,
    toolsExecuted: row.tools_executed ?? [],
    messageType: (row.message_type ?? undefined) as ChatMessage['messageType'],
    agentCallId: row.agent_call_id ?? undefined,
    squadId: row.squad_id ?? undefined,
    operationMode: (row.operation_mode ?? undefined) as AgentCallMode | undefined,
    agentCallStatus: (row.agent_call_status ?? undefined) as AgentCallStatus | undefined,
    revisionTarget:
      typeof row.revision_target === 'string'
        ? (JSON.parse(row.revision_target) as AgentCallTarget)
        : (row.revision_target ?? undefined),
    skillIds: row.skill_ids ?? [],
    timestamp: iso(row.timestamp)
  };
}

/**
 * A thread as a row of `chat_threads`, for the desktop publishing its own.
 *
 * Beside `toThread` so the two directions are read together; the test inserts
 * one into the real migration, which is what a mistyped column fails.
 */
export function threadRow(workspaceId: string, ownerId: string, thread: ChatThread): Record<string, unknown> {
  return {
    id: thread.id,
    workspace_id: workspaceId,
    owner_id: (thread as { ownerId?: string }).ownerId || ownerId,
    project_id: thread.projectId ?? null,
    title: thread.title,
    last_message_snippet: thread.lastMessageSnippet ?? '',
    last_message_at: thread.lastMessageAt || new Date().toISOString(),
    agent_ids: thread.agentIds ?? [],
    target_agent_id: thread.targetAgentId ?? null,
    target_squad_id: thread.targetSquadId ?? null,
    created_at: (thread as { createdAt?: string }).createdAt || new Date().toISOString()
  };
}

/** A message as a row of `chat_messages`; see `threadRow`. */
export function messageRow(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    thread_id: message.threadId,
    sender_type: message.senderType,
    sender_name: message.senderName,
    agent_id: message.agentId ?? null,
    content: message.content,
    thinking_process: message.thinkingProcess ?? null,
    tools_executed: message.toolsExecuted ?? [],
    message_type: message.messageType ?? 'assistant',
    agent_call_id: message.agentCallId ?? null,
    squad_id: message.squadId ?? null,
    operation_mode: message.operationMode ?? null,
    agent_call_status: message.agentCallStatus ?? null,
    revision_target: message.revisionTarget ?? null,
    skill_ids: message.skillIds ?? [],
    timestamp: message.timestamp || new Date().toISOString()
  };
}
