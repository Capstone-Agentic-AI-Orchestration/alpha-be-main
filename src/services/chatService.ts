import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { sqliteService } from './sqliteService.js';
import { ChatMessage, ChatThread } from '../models/index.js';
import { providerResumesSessions, runCliTurn } from './cliRunner.js';
import {
  ensureWorkspacesRoot,
  resolveProjectWorkspace,
  allowAttachedWorkspace
} from './workspaceService.js';
import { resolveAgent, resolveAgentLogged } from './personaService.js';
import { buildEnv, reportIgnoredProjectEnv } from './customCliArgs.js';
import {
  DEFAULT_ASSISTANT,
  DEFAULT_ASSISTANT_PROMPT,
  clearUsageLimit,
  defaultAssistantCandidates,
  markUsageLimited,
  usageLimitFor,
  type DefaultAssistantRuntime,
  type PreferredAssistantModel
} from './defaultAssistant.js';
import { describeChatToolPolicy, describeAlphaWorkspace, skillsForChatApproval, type ChatApprovalMode } from './toolPolicy.js';
import { agentReadiness } from './agentReadiness.js';
import { logInfo } from '../utils/logger.js';
import { workspaceRegistry, WorkspaceRole } from './workspaceRegistry.js';
import { RUNS_DIR } from '../config/env.js';
import { saveChatMessageAndShare, createThreadAndShare } from './chatWriteThrough.js';
import { agentCallService } from './agentCallService.js';
import { randomUUID } from 'node:crypto';
import type { WorkspaceContext } from './workspaceRegistry.js';
import { startProjectBuildBatch, type ProjectBuildStartResult } from './projectBuildOrchestrator.js';
import { processManager } from './processManager.js';
import { chatAttachmentService } from './chatAttachmentService.js';
import {
  chooseBuildRepositories,
  isBareContinueRequest,
  orchestratorRoutingPrompt,
  parseAlphaRoute,
  parseChatOverride,
  referencesAlphaRecords
} from './chatRouter.js';
import { isProjectBuildRequest } from './projectBuildIntent.js';
import { reposForProject } from './githubIssueMapping.js';
import { ensureProjectFolder, projectReadRoots } from './projectFolders.js';
import type { ProjectRoot } from './projectFiles.js';
import { createHash } from 'node:crypto';

/**
 * How Alpha may route an unaddressed message.
 *
 * Present for internal workspace members. Alpha answers as the Orchestrator and
 * may start a build, but only through the checks in `applyAlphaRoute`.
 */
export interface ChatRoutingContext {
  context: WorkspaceContext;
  /** Codebases selected in the composer. Alpha may narrow them, never widen. */
  repositories?: string[];
  /** Whether this user's role may start builds. */
  canBuild: boolean;
  /** The user asked for an answer only (`/ask`). */
  answerOnly?: boolean;
}

/** A refusal the route endpoint reports with a specific HTTP status. */
export class ChatRouteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
import { runWithWorkspace } from './workspaceContext.js';
import { describeProjectBuild } from './chatBuildContext.js';

export interface SendMessageParams {
  threadId: string;
  content: string;
  approvalMode?: ChatApprovalMode;
  senderName?: string;
  /** Explicit target from the chat picker. Null clears a persisted target. */
  targetAgentId?: string | null;
  /** Project attached to a thread being created by its first message. */
  projectId?: string;
  /** Stable client id, reused when a transport retry repeats the same send. */
  clientMessageId?: string;
  /** Local attachment identifiers uploaded for this message. */
  attachmentIds?: string[];
  /**
   * Workspace the message belongs to. Optional: requests that go through
   * runWithWorkspace already carry it ambiently via currentWorkspaceId().
   * When supplied, the thread is bound to that workspace.
   */
  workspaceId?: string;
  /** Authenticated owner, supplied by the chat route for room activity links. */
  userId?: string;
  /** Caller's role in that workspace, for role-gated chat behaviour. */
  workspaceRole?: WorkspaceRole;
  /** A clear project implementation request, routed through the real runner. */
  buildRequest?: { context: WorkspaceContext; repository?: string; repositories?: string[]; issueId?: string };
  /** Let Alpha decide, as the Orchestrator, whether this message is a build. */
  routing?: ChatRoutingContext;
}

/**
 * Match every `@mention` in a message to an agent.
 *
 * An agent matches on first name (`@Ada`), full name with no space
 * (`@AdaLovelace`), id (`@agent-ada`) or role (`@Reviewer`) — all things a
 * person plausibly types.
 *
 * Returns agents in mention order, de-duplicated, so naming the same agent
 * twice does not make it answer twice.
 */
export function resolveMentions(content: string, agents: any[]): any[] {
  const tokens = [...content.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(m => m[1].toLowerCase());
  const picked: any[] = [];
  for (const token of tokens) {
    const agent = agents.find(a => {
      const name = String(a.name ?? '').toLowerCase();
      return (
        a.id?.toLowerCase() === token ||
        name.replace(/\s+/g, '') === token ||
        name.split(/\s+/)[0] === token ||
        String(a.role ?? '').toLowerCase().replace(/\s+/g, '') === token
      );
    });
    if (agent && !picked.some(p => p.id === agent.id)) picked.push(agent);
  }
  return picked;
}

/**
 * Resolve the agent chosen in the Chats tab when the message has no explicit
 * @mention. A typed mention wins, otherwise the per-thread picker wins,
 * otherwise Alpha answers as the automatic responder.
 */
export function resolveChatTarget(targetAgentId: string | undefined, agents: any[]): any[] {
  if (!targetAgentId) return [];
  const agent = agents.find(a => a.id === targetAgentId);
  return agent ? [agent] : [];
}

export interface SendMessageResult {
  userMessage: ChatMessage;
  /**
   * The first reply. Kept so existing callers that expect exactly one still
   * work — a lone agent, or Alpha answering an unaddressed message, produces
   * one element and this is it.
   */
  agentMessage: ChatMessage;
  /**
   * Every reply, in the order they were produced. Longer than one when several agents
   * was mentioned: each member answers in turn, having seen what the members
   * before it said.
   */
  agentMessages: ChatMessage[];
  build?: ProjectBuildStartResult;
  builds?: ProjectBuildStartResult[];
}

interface ActiveChatTurn {
  threadId: string;
  messageId: string;
  stopRequested: boolean;
  currentRunId?: string;
  currentCallId?: string;
  currentAgentName?: string;
  steering: string[];
}

/**
 * The directory an agent inspects for this thread.
 *
 * A thread that names a project gets that working copy — the same directory a
 * run would edit, resolved by the same function. Every other thread gets the
 * managed workspace root, which is what all of them used to get.
 *
 * That was the bug: a run resolved the repository, a chat did not, so an agent
 * asked to review the code it had just changed read an empty managed root and
 * correctly refused to guess. Measured before this: "Antigravity run ended with
 * status CANCELED" for any question about a path outside the root.
 *
 * Falls back rather than throwing when the project has no checkout or the path
 * has gone. A run must refuse there because it is about to write; a chat only
 * reads, and declining to talk because a folder is missing is worse than
 * answering from the root and saying what is actually visible.
 */
/** The project a thread is pinned to, if any. */
function threadProject(threadId: string) {
  const thread = sqliteService.getChatThreads().find(t => t.id === threadId);
  if (!thread?.projectId) return undefined;
  return sqliteService.getProjects().find(p => p.id === thread.projectId);
}

function chatWorkspace(threadId: string): string {
  const root = ensureWorkspacesRoot();

  const thread = sqliteService.getChatThreads().find(t => t.id === threadId);
  if (!thread?.projectId) return root;

  const project = sqliteService.getProjects().find(p => p.id === thread.projectId);
  if (!project) return root;

  const workspace = resolveProjectWorkspace(project);
  if (!workspace || !fs.existsSync(workspace.dir)) {
    // A project-scoped chat must never fall back to the shared workspaces
    // root: that would let a question about one project read another project's
    // checkout. Use an empty, allowlisted scratch directory instead. The
    // explicit Agent Call path reports the missing working copy for code
    // review/revision; this legacy Alpha reply can still answer general text.
    logInfo(`Thread project "${project.name}" has no working copy on disk — using an empty isolated context`);
    return chatScratchFolder(threadId, project.name);
  }

  // The same consent record a run makes: a hand-attached folder is registered,
  // a managed checkout is already covered by the root allowlist entry.
  allowAttachedWorkspace(workspace, project.name);
  return workspace.dir;
}

/**
 * One empty folder per conversation, for turns that must not stand in any
 * project's code: a chat that reads through alpha-project-files, or a project
 * with nothing on this computer. The same folder every turn -- the old
 * fallback made a new chat-empty-* folder on each one.
 */
function chatScratchFolder(threadId: string, label: string): string {
  const dir = path.join(RUNS_DIR, 'chat-' + createHash('sha256').update(threadId).digest('hex').slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  if (!sqliteService.isPathAllowed(dir)) sqliteService.addAllowedPath(dir, `Empty chat context for ${label}`);
  return dir;
}

/**
 * What the Orchestrator is told about the project's code on this computer:
 * which repositories it can read, where, and which are not here.
 */
export function describeLocalProjectFiles(projectName: string | null, roots: ProjectRoot[], missing: string[]): string {
  if (!projectName) {
    return [
      '## Code on this computer',
      '',
      'No project is selected, so this conversation reads no files on this computer. Read code from GitHub with the alpha-github tools, or ask the user to pick a project.'
    ].join('\n');
  }
  const lines = ['## ' + projectName + ' on this computer', ''];
  if (roots.length) {
    lines.push('You can read these repositories with the alpha-project-files tools:');
    for (const root of roots) lines.push('- ' + root.name + ' (' + root.repo + '): ' + root.dir);
  } else {
    lines.push('None of this project\'s repositories is on this computer yet, so you cannot read local files here.');
  }
  if (missing.length) {
    lines.push('', 'Not on this computer: ' + missing.join(', ') + '. Read those from GitHub with the alpha-github tools, and tell the user they can clone them from the project\'s Code tab.');
  }
  lines.push('', 'Never read or describe another project\'s files from this conversation.');
  return lines.join('\n');
}

/**
 * What the Orchestrator may do with GitHub in this conversation: read only.
 *
 * Alpha's chat turn is the Orchestrator talking. It gets the built-in
 * alpha-github tools in read mode, so it can look at the project's repositories,
 * branches, pull requests and workflow runs even when this machine has no
 * checkout. Pushing, opening pull requests and posting reviews are refused by the
 * server itself; changes are made by specialist agents in a build.
 */
export function describeOrchestratorGitHubAccess(repos: string[]): string {
  return [
    '## GitHub access (read only)',
    '',
    repos.length
      ? 'This conversation’s project lives on GitHub in: ' + repos.join(', ') + '.'
      : 'No project is selected, so no repository is assigned; you can still read any repository the signed-in account can see.',
    'Read GitHub with the alpha-github tools: github_repo_tree and github_read_file for code, github_list_branches and github_compare_branches for branches, github_list_pull_requests for pull requests, and github_workflow_runs and github_failed_run_logs for CI.',
    'Your GitHub access is read only. Do not push, open pull requests, post reviews or change anything on GitHub; those tools are refused for you.',
    'When the user wants code changed, plan it as an Orchestrator build so the specialist agents make the change.'
  ].join('\n');
}

/**
 * The agents Alpha can speak about.
 *
 * An agent reply already gets a roster — see `resolveAgentLogged` — and Alpha,
 * the one you would naturally ask "which agents do I have", got nothing. Asked
 * about them it reached for its CLI's own tooling, ran `ListAgents`, and
 * reported on Claude Code sessions instead.
 */
function describeWorkspaceForAlpha(workspaceId?: string): string {
  const agents = (workspaceId ? workspaceRegistry.scope('agents', sqliteService.getAgents(), workspaceId) : sqliteService.getAgents())
    .filter(a => !a.isArchived)
    .map(a => ({ id: a.id, name: a.name, role: a.role }));
  return describeAlphaWorkspace(agents);
}

/**
 * The last few messages before the current one, for a runtime without session
 * resume. Bounded so a long thread cannot crowd out the instructions.
 */
function describeRecentConversation(threadId: string, limit = 8): string | undefined {
  const messages = sqliteService.getChatMessages(threadId);
  const lastUser = messages.map(message => message.senderType).lastIndexOf('user');
  const earlier = (lastUser >= 0 ? messages.slice(0, lastUser) : messages).slice(-limit);
  if (!earlier.length) return undefined;
  const lines = earlier.map(message => {
    const text = message.content.replace(/\s+/g, ' ').trim();
    return `- ${message.senderName}: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`;
  });
  return ['## Recent conversation (context only; follow the current message)', ...lines].join('\n');
}

export class ChatService extends EventEmitter {
  private readonly activeTurns = new Map<string, ActiveChatTurn>();
  /** Alpha replies that report a runtime failure rather than an answer. */
  private readonly failedDefaultReplies = new WeakSet<ChatMessage>();

  private turnKey(threadId: string, messageId: string): string {
    return `${threadId}\u0000${messageId}`;
  }

  finishTurn(threadId: string, messageId: string): void {
    this.activeTurns.delete(this.turnKey(threadId, messageId));
  }

  async stopTurn(threadId: string, messageId: string): Promise<{ status: 'stopping' | 'stopped' }> {
    const turn = this.activeTurns.get(this.turnKey(threadId, messageId));
    if (!turn) throw new Error('This chat turn is no longer running.');
    turn.stopRequested = true;
    if (turn.currentRunId) await processManager.terminateProcessAndWait(turn.currentRunId, 'cancelled');
    if (turn.currentCallId) agentCallService.cancelChatTurn(turn.currentCallId);
    this.emit('chat_turn.stopped', { threadId, messageId, agentCallId: turn.currentCallId });
    return { status: 'stopped' };
  }

  steerTurn(threadId: string, messageId: string, instruction: string): { status: 'queued'; position: number } {
    const turn = this.activeTurns.get(this.turnKey(threadId, messageId));
    const clean = instruction.trim();
    if (!turn || turn.stopRequested) throw new Error('This chat turn is no longer accepting directions.');
    if (!clean || clean.length > 4_000) throw new Error('Enter a direction up to 4,000 characters.');
    if (turn.steering.length >= 10) throw new Error('There are already 10 directions waiting for this turn.');
    turn.steering.push(clean);
    if (turn.currentCallId) agentCallService.recordChatTurnSteering(turn.currentCallId, clean, 'queued');
    this.emit('chat_turn.steering', { threadId, messageId, position: turn.steering.length });
    return { status: 'queued', position: turn.steering.length };
  }

  private async runWithSteering<T>(turn: ActiveChatTurn, initialPrompt: string, run: (prompt: string) => Promise<T>): Promise<T | null> {
    if (turn.stopRequested) return null;
    const initiallyQueued = turn.steering.splice(0);
    for (const direction of initiallyQueued) {
      if (turn.currentCallId) agentCallService.recordChatTurnSteering(turn.currentCallId, direction, 'applied');
    }
    let prompt = initiallyQueued.length
      ? `${initialPrompt}\n\nAdditional direction from the user before the response began:\n${initiallyQueued.map(item => `- ${item}`).join('\n')}`
      : initialPrompt;
    let result = await run(prompt);
    while (!turn.stopRequested && turn.steering.length) {
      const directions = turn.steering.splice(0);
      for (const direction of directions) {
        if (turn.currentCallId) agentCallService.recordChatTurnSteering(turn.currentCallId, direction, 'applied');
      }
      prompt = `Additional direction from the user while you were working:\n${directions.map(item => `- ${item}`).join('\n')}\n\nContinue the same conversation and apply these directions before you finish.`;
      result = await run(prompt);
    }
    return turn.stopRequested ? null : result;
  }

  private async startProjectChatActivity(input: {
    params: SendMessageParams;
    project?: import('../models/index.js').Project;
    threadId: string;
    messageId: string;
    agent: any;
    instruction: string;
    turn: ActiveChatTurn;
  }): Promise<string | undefined> {
    const { params, project, threadId, messageId, agent, instruction, turn } = input;
    if (!project || !params.workspaceId || !params.userId) return undefined;
    try {
      const call = await agentCallService.startChatTurn({
        workspaceId: params.workspaceId, project, threadId, messageId,
        agent, requestedBy: params.userId, instruction
      });
      turn.currentCallId = call.id;
      turn.currentRunId = call.id;
      turn.currentAgentName = agent.name;
      for (const attachment of params.attachmentIds?.length ? chatAttachmentService.references(threadId, params.attachmentIds, messageId) : []) {
        agentCallService.recordChatTurnAttachment(call.id, attachment.name, attachment.contentType);
      }
      return call.id;
    } catch (error) {
      logInfo(`Chat activity session could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const { threadId, content, senderName = 'You', workspaceId, workspaceRole } = params;
    const now = new Date().toISOString();

    let thread = sqliteService.getChatThreads().find(t => t.id === threadId);
    if (!thread) {
      thread = createThreadAndShare({
        id: threadId,
        ownerId: params.userId,
        title: content.slice(0, 40) || 'New Conversation',
        lastMessageSnippet: content.slice(0, 100),
        lastMessageAt: now,
        // No agent is assigned up front — the thread belongs to whoever the
        // user @-mentions. Defaulting to agent-ada meant every conversation
        // silently had a participant nobody chose.
        agentIds: [],
        targetAgentId: params.targetAgentId ?? undefined,
        projectId: params.projectId,
        createdAt: now
      });
      if (workspaceId) workspaceRegistry.bind('chat_threads', threadId, workspaceId);
    }

    // 1. Save user message
    const messageId = params.clientMessageId?.trim() || `msg-${Date.now()}-${randomUUID()}-user`;
    const existingUserMessage = sqliteService.getChatMessages(threadId).find(message => message.id === messageId);
    if (existingUserMessage && (existingUserMessage.senderType !== 'user' || existingUserMessage.content !== content)) {
      throw new Error('This message id already belongs to a different conversation message.');
    }
    const attachmentIds = params.attachmentIds ?? existingUserMessage?.attachments?.map(item => item.id) ?? [];
    const attachmentContext = chatAttachmentService.promptContext(threadId, attachmentIds, messageId);
    const userMessage: ChatMessage = existingUserMessage ?? {
      id: messageId,
      threadId,
      senderType: 'user',
      senderName,
      content,
      attachments: attachmentContext.references.map(reference => params.buildRequest
        ? { ...reference, inspection: 'stored_only' as const }
        : reference),
      timestamp: now
    };
    if (existingUserMessage && attachmentIds.length &&
        JSON.stringify(existingUserMessage.attachments?.map(item => item.id) ?? []) !== JSON.stringify(attachmentIds)) {
      throw new Error('This message id already belongs to a different attachment set.');
    }
    if (!existingUserMessage) {
      chatAttachmentService.linkToMessage(threadId, messageId, attachmentIds);
      saveChatMessageAndShare(userMessage);
    }

    if (params.buildRequest) {
      return this.startChatBuild({
        threadId, thread, userMessage,
        context: params.buildRequest.context,
        request: parseChatOverride(content).content || content,
        repositories: params.buildRequest.repositories ?? (params.buildRequest.repository ? [params.buildRequest.repository] : []),
        attachmentIds,
        issueId: params.buildRequest.issueId
      });
    }

    // A transport retry of a message Alpha already turned into a build returns that build.
    if (existingUserMessage) {
      const existingBuildReply = sqliteService.getChatMessages(threadId).find(message => message.id === `${messageId}-build`);
      if (existingBuildReply) return { userMessage, agentMessage: existingBuildReply, agentMessages: [existingBuildReply] };
    }

    const turn: ActiveChatTurn = {
      threadId,
      messageId: userMessage.id,
      stopRequested: false,
      steering: []
    };
    this.activeTurns.set(this.turnKey(threadId, userMessage.id), turn);
    const requestContent = `${content}${attachmentContext.text}`;

    /**
     * 2. Resolve who is being addressed — and only from THIS message.
     *
     * An `@mention` used to join that agent to the thread permanently, so every
     * later message reached them without being addressed. Typing "hello" got a
     * reply from Ada Lovelace, in character, and when her CLI was unavailable
     * the user got Ada's error for a message that was never hers.
     *
     * Agents speak when spoken to. Anything else Alpha answers itself.
     */
    const agents = sqliteService.getAgents().filter(a => !a.isArchived);
    const mentioned = resolveMentions(content, agents);
    const targetAgentId = params.targetAgentId !== undefined
      ? params.targetAgentId ?? undefined
      : thread.targetAgentId;
    const addressed = mentioned.length
      ? mentioned
      : resolveChatTarget(targetAgentId, agents);

    if (!addressed.length) {
      const projectForChat = thread.projectId
        ? sqliteService.getProjects().find(item => item.id === thread!.projectId)
        : undefined;
      const activityCallId = await this.startProjectChatActivity({
        params, project: projectForChat, threadId, messageId: userMessage.id,
        agent: DEFAULT_ASSISTANT, instruction: requestContent, turn
      });
      const runId = activityCallId ?? `chat-${randomUUID()}`;
      turn.currentCallId = activityCallId;
      turn.currentRunId = runId;
      turn.currentAgentName = DEFAULT_ASSISTANT.name;
      const routingPrompt = params.routing ? this.routingPromptFor(params.routing, thread) : undefined;
      const reply = await this.runWithSteering(turn, requestContent, prompt =>
        this.generateDefaultReply(prompt, threadId, workspaceId, runId, activityCallId, routingPrompt, params.approvalMode)
      );
      if (!reply || turn.stopRequested) {
        if (activityCallId) agentCallService.cancelChatTurn(activityCallId);
        const stopped = this.stoppedMessage(threadId);
        saveChatMessageAndShare(stopped);
        return { userMessage, agentMessage: stopped, agentMessages: [stopped] };
      }
      if (params.routing) {
        const routed = await this.applyAlphaRoute({
          routing: params.routing,
          thread,
          userMessage,
          reply,
          request: parseChatOverride(content).content || content,
          attachmentIds
        });
        if (routed) {
          if (activityCallId) agentCallService.completeChatTurn(activityCallId, routed.agentMessage.id);
          return routed;
        }
      }
      saveChatMessageAndShare(reply);
      this.emit('chat_message', reply);
      if (activityCallId) {
        if (reply.senderType === 'system') agentCallService.failChatTurn(activityCallId, 'The selected runtime could not complete this chat turn.');
        else agentCallService.completeChatTurn(activityCallId, reply.id);
      }
      return { userMessage, agentMessage: reply, agentMessages: [reply] };
    }

    /**
     * The thread still records who has taken part, for the roster the UI shows
     * and for per-agent CLI sessions. It is no longer used to decide who
     * answers — that is what made a mention permanent.
     */
    const roster = [...new Set([...(thread.agentIds ?? []), ...addressed.map(a => a.id)])];
    sqliteService.setChatThreadAgents(threadId, roster);

    /**
     * 3. Everyone addressed answers, in the order they were named.
     *
     * One `@agent` is one reply, which is the ordinary case. When several
     * agents are named, each speaks after seeing what the ones before it said.
     *
     * Sequential rather than parallel on purpose: PROVIDER_CONCURRENCY caps
     * Anthropic at 2 concurrent, and four agents answering at once would
     * spend the whole allowance on a single chat message.
     */
    if (addressed.length > 1) {
      logInfo(`Chat: ${addressed.length} agents addressed — answering in sequence`);
    }

    const agentMessages: ChatMessage[] = [];
    const project = thread.projectId
      ? sqliteService.getProjects().find(item => item.id === thread!.projectId)
      : undefined;
    for (const [index, agent] of addressed.entries()) {
      const priorTurn = agentMessages.length ? describePriorReplies(agentMessages) : undefined;
      let activityCallId: string | undefined;
      if (project && workspaceId && params.userId) {
        activityCallId = await this.startProjectChatActivity({
          params, project, threadId, messageId: userMessage.id, agent,
          instruction: requestContent, turn
        });
        if (index > 0 && agentMessages[index - 1]) {
          try {
            if (activityCallId) agentCallService.recordChatTurnHandoff(activityCallId, agentMessages[index - 1].senderName);
          } catch {
            // A missing room event never blocks the next agent's chat turn.
          }
        }
      }
      let reply: Awaited<ReturnType<ChatService['generateAgentReply']>>;
      try {
        const runId = activityCallId ?? `chat-${randomUUID()}`;
        turn.currentCallId = activityCallId;
        turn.currentRunId = runId;
        turn.currentAgentName = agent.name;
        const steeredReply = await this.runWithSteering(turn, requestContent, prompt =>
          this.generateAgentReply(agent, prompt, threadId, priorTurn, activityCallId, runId, params.approvalMode)
        );
        if (!steeredReply || turn.stopRequested) {
          if (activityCallId) agentCallService.cancelChatTurn(activityCallId);
          const stopped = this.stoppedMessage(threadId);
          saveChatMessageAndShare(stopped);
          agentMessages.push(stopped);
          break;
        }
        reply = steeredReply;
      } catch (error) {
        try {
          if (activityCallId) agentCallService.failChatTurn(activityCallId, error instanceof Error ? error.message : String(error));
        } catch {
          // Preserve the original chat failure if activity persistence also failed.
        }
        throw error;
      }

      const message: ChatMessage = {
        id: `msg-${Date.now()}-${index}-${agent.id}`,
        threadId,
        senderType: 'agent',
        senderName: agent.name,
        agentId: agent.id,
        content: reply.content,
        thinkingProcess: reply.thinking,
        toolsExecuted: reply.tools,
        timestamp: new Date().toISOString()
      };

      saveChatMessageAndShare(message);
      this.emit('chat_message', message);
      agentMessages.push(message);
      if (activityCallId) {
        try {
          if (reply.failed) agentCallService.failChatTurn(activityCallId, 'The agent runtime could not complete this project chat turn.');
          else agentCallService.completeChatTurn(activityCallId, message.id);
        } catch (error) {
          logInfo(`Chat activity session could not be finalized: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (!agentMessages.length) {
      const stopped = this.stoppedMessage(threadId);
      saveChatMessageAndShare(stopped);
      agentMessages.push(stopped);
    }
    return { userMessage, agentMessage: agentMessages[0], agentMessages };
  }

  /**
   * Start the Orchestrator for one chat message and post its status reply.
   *
   * Idempotent on the source message: a transport retry, or a second click on
   * "Plan this build", returns the reply already written for that message.
   */
  private async startChatBuild(input: {
    threadId: string;
    thread: ChatThread;
    userMessage: ChatMessage;
    context: WorkspaceContext;
    /** The planning brief: Alpha's restated goal, or the user's own words. */
    request: string;
    /** The user's words, kept beside Alpha's restatement for the planner. */
    originalRequest?: string;
    repositories?: string[];
    attachmentIds?: string[];
    /** One extra line for the user, such as how the request was routed. */
    note?: string;
    /** Board issue to build in place instead of filing a new chat-build issue. */
    issueId?: string;
  }): Promise<SendMessageResult> {
    const { threadId, thread, userMessage } = input;
    const messageId = userMessage.id;
    // Links the run to this chat so recovery updates and milestones reach it.
    const bindToChat = (runId: string | undefined, buildMessageId: string) => {
      const { workspaceId, userId } = input.context;
      if (!runId || !workspaceId || !userId) return;
      // The reply is already saved; a link that cannot be made must not lose it or the build.
      try {
        runWithWorkspace(workspaceId, () => sqliteService.bindOrchestrationChat({ runId, threadId, buildMessageId, actorId: userId }));
      } catch (error) {
        logInfo(`Build ${runId} was not linked to conversation ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const existingBuildReply = sqliteService.getChatMessages(threadId).find(message => message.id === `${messageId}-build`);
    if (existingBuildReply) {
      bindToChat(existingBuildReply.orchestrationRunId, existingBuildReply.id);
      return { userMessage, agentMessage: existingBuildReply, agentMessages: [existingBuildReply] };
    }

    const repositories = [...new Set((input.repositories ?? []).map(repository => repository.trim()).filter(Boolean))];
    const buildAttachmentContext = chatAttachmentService.promptContext(threadId, input.attachmentIds ?? [], messageId, false, false);
    const original = input.originalRequest?.trim();
    const brief = original && original !== input.request.trim()
      ? `${input.request.trim()}\n\nThe user's original message:\n${original}`
      : input.request.trim();
    const builds = await startProjectBuildBatch({
      context: input.context,
      projectId: thread.projectId,
      threadId,
      messageId,
      content: `${brief}${buildAttachmentContext.text}`,
      repositories,
      issueId: input.issueId
    });
    const build = builds[0];
    const statusText = (result: ProjectBuildStartResult) => result.orchestrationRunId
      ? result.status === 'completed' ? `Orchestrator build complete · ${result.issueIdentifier}`
        : result.status === 'plan_ready' ? `Orchestrator plan ready · ${result.issueIdentifier}`
          : result.status === 'awaiting_review' ? `Orchestrator build ready for final review · ${result.issueIdentifier}`
            : result.status === 'blocked' ? `Orchestrator build paused · ${result.issueIdentifier}`
              : `Orchestrator ${result.status === 'in_progress' ? 'working' : 'starting'} · ${result.issueIdentifier}`
      : result.status === 'queued' ? `Build queued · ${result.issueIdentifier}`
      : result.status === 'in_progress' ? `Build already in progress · ${result.issueIdentifier}`
        : result.status === 'awaiting_review' ? `Build ready for review · ${result.issueIdentifier}`
          : result.status === 'failed' ? `Build stopped · ${result.issueIdentifier}`
            : result.status === 'blocked' ? 'Build not started'
              : `Build started · ${result.issueIdentifier}`;
    const summary = builds.length > 1 && builds.every(result => result.status === 'blocked')
      ? [
          '**Build not started for any repository.**',
          ...builds.map(result => `**${result.repository ?? 'Repository'}:** ${result.reason ?? 'The repository build could not be prepared.'}`),
          'No specialist was started, so no files were changed in this run. Open the Live Build Room to review each reason, then retry when the required correction is clear.'
        ].join('\n\n')
      : builds.length > 1
      ? [
          `**Build requested for ${builds.length} repositories**`,
          ...builds.map(result => [
            `**${result.repository ?? 'Repository'} · ${statusText(result)}**`,
            result.reason,
            result.branchName ? `Working branch: ${result.branchName}` : undefined
          ].filter(Boolean).join(' · ')),
          'Open the Live Build Room and choose a build to follow its agents, handoffs, changed files, and verification.'
        ].join('\n\n')
      : build.status === 'blocked'
        ? `**Build not started.** ${build.reason ?? 'The project needs setup before Alpha can write to its repository.'}`
        : build.orchestrationRunId
          ? [
              `**${statusText(build)}**`,
              build.repositories && build.repositories.length > 1 ? `**One shared build across:** ${build.repositories.join(', ')}` : undefined,
              build.status === 'plan_ready'
                ? `The Orchestrator prepared ${build.orchestrationTaskCount ?? 'several'} planned task(s) and assigned a specialist to each. No one has started changing code yet. Review each assignment and why the specialist was chosen in the Live Build Room, then choose **Start planned work**.`
                : `The Orchestrator is tracking ${build.orchestrationTaskCount ?? 'several'} task(s).${build.orchestrationCurrentTask ? `\n\nCurrent task: **${build.orchestrationCurrentTask.title}** (owner: ${build.orchestrationCurrentTask.ownerAgentId}).` : ''}`,
              build.reason,
              build.repository ? `**Repository:** ${build.repository}` : undefined,
              build.branchName ? `**Working branch:** ${build.branchName}` : undefined,
              build.status === 'plan_ready' ? undefined : 'The next specialist starts only after the current result passes its checks. Open the Live Build Room to review task evidence and findings.'
            ].filter(Boolean).join('\n\n')
        : [
            `**${statusText(build)}**`,
            build.reason,
            build.projectName ? `**Project:** ${build.projectName}` : undefined,
            build.repository ? `**Repository:** ${build.repository}` : undefined,
            build.branchName ? `**Working branch:** ${build.branchName}` : undefined,
            'Open the Live Build Room to follow each agent, handoff, changed file, and verification result.'
          ].filter(Boolean).join('\n\n');
    const reply: ChatMessage = {
      id: `${messageId}-build`,
      threadId,
      senderType: 'agent',
      senderName: 'Alpha Orchestrator',
      content: input.note ? `${summary}\n\n_${input.note}_` : summary,
      messageType: 'build',
      orchestrationRunId: build.orchestrationRunId,
      timestamp: new Date().toISOString()
    };
    saveChatMessageAndShare(reply);
    bindToChat(build.orchestrationRunId, reply.id);
    this.emit('chat_message', reply);
    return { userMessage, agentMessage: reply, agentMessages: [reply], build, builds: builds.length > 1 ? builds : undefined };
  }

  /**
   * The goal of this conversation's most recent build that stopped (cancelled or
   * failed), skipping goals that only point back at an earlier build. Undefined
   * while a build is still open, which keeps "continue" on that build instead.
   */
  private restartableGoal(threadId: string): string | undefined {
    const runIds = [...new Set(sqliteService.getChatMessages(threadId)
      .filter(message => message.messageType === 'build' && message.orchestrationRunId)
      .reverse()
      .map(message => message.orchestrationRunId!))];
    for (const runId of runIds) {
      const run = sqliteService.getOrchestrationSnapshot(runId)?.run;
      if (!run) continue;
      if (!['cancelled', 'failed'].includes(run.status)) return undefined;
      const goal = run.plan?.goal?.trim();
      if (goal && !referencesAlphaRecords(goal)) return goal;
    }
    return undefined;
  }

  /** Orchestrator instructions describing what this conversation can build. */
  private routingPromptFor(routing: ChatRoutingContext, thread: ChatThread): string {
    const project = thread.projectId
      ? sqliteService.getProjects().find(item => item.id === thread.projectId)
      : undefined;
    return orchestratorRoutingPrompt({
      projectName: project?.name,
      repositories: project ? reposForProject(project) : [],
      selectedRepositories: routing.repositories,
      workspaceProjects: workspaceRegistry.scopeProjects(sqliteService.getProjects(), routing.context)
        .map(item => item.key ? `${item.name} (${item.key})` : item.name),
      canBuild: routing.canBuild,
      answerOnly: routing.answerOnly
    });
  }

  /**
   * Act on the decision Alpha wrote, after the server's own checks.
   *
   * Returns a finished result when the message became a build. Otherwise it
   * rewrites `reply` in place — removing the decision line, or turning it into
   * a proposal the user answers — and returns null so the caller saves it.
   */
  private async applyAlphaRoute(input: {
    routing: ChatRoutingContext;
    thread: ChatThread;
    userMessage: ChatMessage;
    reply: ChatMessage;
    request: string;
    attachmentIds: string[];
  }): Promise<SendMessageResult | null> {
    const { routing, thread, userMessage, reply, request } = input;
    const projectId = thread.projectId;

    if (this.failedDefaultReplies.has(reply)) {
      // Alpha could not answer. Keep the old keyword routing so a clear build
      // request still reaches the Orchestrator instead of failing outright.
      if (routing.answerOnly || !routing.canBuild || !projectId || !isProjectBuildRequest(request)) return null;
      return this.startChatBuild({
        threadId: thread.id, thread, userMessage, context: routing.context, request,
        repositories: routing.repositories, attachmentIds: input.attachmentIds,
        note: 'Alpha could not reach its runtime, so this request was routed by its wording.'
      });
    }

    const parsed = parseAlphaRoute(reply.content);
    if (!parsed.decision && !parsed.malformed) return null;
    reply.content = parsed.message;

    if (routing.answerOnly || !routing.canBuild) {
      if (!reply.content) {
        reply.content = routing.answerOnly
          ? 'I did not start a build. Send the message without /ask if you want me to plan this change.'
          : 'This sounds like a product change, but your workspace role cannot start builds. Ask a project manager to update your access.';
      }
      return null;
    }

    // An unreadable decision becomes a question to the user, never a build.
    const decision = parsed.decision ?? { route: 'confirm_build' as const, goal: request, repositories: [] };
    const goal = decision.goal || request;
    const repositories = chooseBuildRepositories(routing.repositories, decision.repositories);

    // "continue" after a build stopped: plan that build's own goal again. A goal that points at
    // the stopped build ("continue MON-104 from the saved plan") gives specialists nothing they can open.
    const restartGoal = projectId && (decision.route === 'build' || decision.route === 'confirm_build') && isBareContinueRequest(request)
      ? this.restartableGoal(thread.id)
      : undefined;
    if (restartGoal && projectId) {
      return this.startChatBuild({
        threadId: thread.id, thread, userMessage, context: routing.context,
        request: restartGoal, originalRequest: request, repositories, attachmentIds: input.attachmentIds,
        note: 'The last build stopped, so the Orchestrator planned its request again from the start.'
      });
    }

    if (decision.route === 'build' && projectId) {
      return this.startChatBuild({
        threadId: thread.id, thread, userMessage, context: routing.context,
        request: goal, originalRequest: request, repositories, attachmentIds: input.attachmentIds
      });
    }

    const needsProject = !projectId;
    reply.messageType = needsProject ? 'project_needed' : 'build_proposal';
    reply.routeProposal = { sourceMessageId: userMessage.id, goal, repositories, status: 'open' };
    if (!reply.content) {
      reply.content = needsProject
        ? 'Which project is this for? Choose one in the header and I will plan the build.'
        : 'Do you want me to plan a build for this, or only answer it?';
    }
    return null;
  }

  /**
   * The user's answer to how a message should be handled.
   *
   * Backs "Plan this build", "Just answer", "Build this instead", and "This was
   * just a question". `messageId` is always the user's own message, so every
   * path is idempotent on it.
   */
  async routeMessage(input: {
    threadId: string;
    messageId: string;
    action: 'build' | 'answer';
    routing: ChatRoutingContext;
    userId: string;
  }): Promise<SendMessageResult> {
    const thread = sqliteService.getChatThreads().find(item => item.id === input.threadId);
    if (!thread) throw new ChatRouteError('Conversation not found.', 404);
    const messages = sqliteService.getChatMessages(thread.id);
    const userMessage = messages.find(message => message.id === input.messageId && message.senderType === 'user');
    if (!userMessage) throw new ChatRouteError('That message is no longer in this conversation.', 404);

    const proposals = messages.filter(message =>
      message.routeProposal?.sourceMessageId === userMessage.id && message.routeProposal.status === 'open');
    const settle = (status: 'accepted' | 'dismissed') => {
      for (const message of proposals) {
        sqliteService.updateChatMessageRouteProposal(thread.id, message.id, { ...message.routeProposal!, status });
      }
    };
    const request = parseChatOverride(userMessage.content).content || userMessage.content;
    const attachmentIds = userMessage.attachments?.map(item => item.id) ?? [];

    if (input.action === 'build') {
      if (!input.routing.canBuild) {
        throw new ChatRouteError('Your workspace role cannot start builds. Ask a project manager to update your access.', 403);
      }
      if (!thread.projectId) throw new ChatRouteError('Choose a project for this conversation before planning a build.', 409);
      const proposal = proposals.at(-1)?.routeProposal;
      const result = await this.startChatBuild({
        threadId: thread.id, thread, userMessage, context: input.routing.context,
        request: proposal?.goal || request,
        originalRequest: request,
        repositories: input.routing.repositories?.length ? input.routing.repositories : proposal?.repositories,
        attachmentIds
      });
      settle('accepted');
      return result;
    }

    // "Just answer" or "This was just a question": withdraw an unstarted plan first.
    const buildReply = messages.find(message => message.id === `${userMessage.id}-build`);
    if (buildReply?.orchestrationRunId) {
      const status = sqliteService.getOrchestrationSnapshot(buildReply.orchestrationRunId)?.run.status;
      if (status && !['planning', 'awaiting_plan_approval', 'cancelled', 'failed', 'blocked'].includes(status)) {
        throw new ChatRouteError('Specialists have already started this build. Stop it from its build controls first.', 409);
      }
      if (status === 'planning' || status === 'awaiting_plan_approval') {
        const { orchestrationService } = await import('./orchestrationRuntime.js');
        await orchestrationService.cancelRun({
          workspaceId: input.routing.context.workspaceId,
          runId: buildReply.orchestrationRunId,
          actorId: input.userId,
          reason: 'The user asked for an answer instead of a build.'
        });
      }
    }
    settle('dismissed');

    const reply = await this.generateDefaultReply(
      `${request}\n\nThe user wants an answer to this message, not a build. Answer it directly.`,
      thread.id,
      input.routing.context.workspaceId,
      `chat-${randomUUID()}`,
      undefined,
      this.routingPromptFor({ ...input.routing, answerOnly: true }, thread)
    );
    reply.content = parseAlphaRoute(reply.content).message || reply.content;
    saveChatMessageAndShare(reply);
    this.emit('chat_message', reply);
    return { userMessage, agentMessage: reply, agentMessages: [reply] };
  }

  private stoppedMessage(threadId: string): ChatMessage {
    return {
      id: `msg-${Date.now()}-${randomUUID()}-stopped`, threadId, senderType: 'system',
      senderName: 'Alpha', content: 'This chat turn was stopped. No more agents will start for it.',
      timestamp: new Date().toISOString()
    };
  }


  /**
   * Answer a message that named no agent.
   *
   * Alpha replies as itself on the machine's default runtime — no persona, no
   * agent identity, and no agent's name on a message they were never sent.
   *
   * It keeps its own CLI session per thread, keyed by DEFAULT_ASSISTANT.id, so
   * a plain conversation has continuity without borrowing an agent's transcript.
   */
  private async generateDefaultReply(
    prompt: string,
    threadId: string,
    workspaceId: string | undefined,
    runId: string,
    activityCallId?: string,
    /** Orchestrator instructions for this turn, when Alpha may route it. */
    routingPrompt?: string,
    approvalMode?: ChatApprovalMode
  ): Promise<ChatMessage> {
    const now = () => new Date().toISOString();
    const base = {
      id: `msg-${Date.now()}-${randomUUID()}-alpha`,
      threadId,
      senderType: 'agent' as const,
      senderName: DEFAULT_ASSISTANT.name,
      // Deliberately no agentId: nothing in the UI should attribute this to a
      // configured agent, because none was involved.
      timestamp: now()
    };

    // Alpha answers with the Orchestrator's model, the agent at the centre of
    // the chat, so changing it there changes who replies here.
    const agentsHere = workspaceId ? runWithWorkspace(workspaceId, () => sqliteService.getAgents()) : sqliteService.getAgents();
    const orchestrator = agentsHere.find(agent => agent.templateKey === 'orchestrator' && !agent.isArchived);
    let preferred: PreferredAssistantModel | undefined;
    if (orchestrator) {
      const setting = resolveAgent(orchestrator, { includeMemory: false });
      preferred = {
        provider: setting.modelProvider,
        modelName: setting.modelName,
        reasoningEffort: setting.reasoningEffort ?? null,
        agentName: orchestrator.name
      };
    }
    const candidates = defaultAssistantCandidates(sqliteService.getRuntimes(), preferred);
    if (!candidates.length) {
      const unavailable: ChatMessage = {
        ...base,
        senderType: 'system',
        content: [
          'No AI runtime is signed in on this machine, so I cannot answer.',
          '',
          'Install and sign in to one of the agent CLIs — the Runtimes page shows what it found.'
        ].join('\n')
      };
      this.failedDefaultReplies.add(unavailable);
      return unavailable;
    }

    const assistantProject = threadProject(threadId);
    const projectRepos = assistantProject ? reposForProject(assistantProject) : [];
    const localCode = assistantProject ? projectReadRoots(assistantProject) : { roots: [] as ProjectRoot[], missing: [] as string[] };
    const assistantServers = localCode.roots.length ? ['alpha-github', 'alpha-project-files'] : ['alpha-github'];
    const cwd = chatScratchFolder(threadId, assistantProject?.name ?? 'Alpha');
    const approvalSkills = skillsForChatApproval(approvalMode ?? 'ask', localCode.roots.length > 0);

    // A runtime whose plan is used up is asked last, so its turn is not spent
    // waiting on an answer that will only repeat the limit.
    const ordered = [
      ...candidates.filter(candidate => !usageLimitFor(candidate.provider)),
      ...candidates.filter(candidate => usageLimitFor(candidate.provider))
    ];
    const runtimeLabel = (candidate: DefaultAssistantRuntime) => candidate.name ?? candidate.provider;

    for (const runtime of ordered) {
      // Each runtime keeps its own session: one CLI cannot resume another's id.
      const sessionKey = `${DEFAULT_ASSISTANT.id}:${runtime.provider}`;
      const priorSession = sqliteService.getThreadSession(threadId, sessionKey);
      // A turn with no session of its own on this runtime sees no earlier
      // messages, so "yes, go ahead" would mean nothing. Give it the recent ones.
      const recentConversation = !priorSession || (routingPrompt && !providerResumesSessions(runtime.provider))
        ? describeRecentConversation(threadId)
        : undefined;

      logInfo(`Default assistant replying via ${runtime.provider}/${runtime.modelName}: ${runtime.reason}`);

      const turn = await runCliTurn({
        runId,
        cwd,
        provider: runtime.provider,
        approvalMode,
        modelName: runtime.modelName,
        codexBaseUrl: runtime.endpoint,
        reasoningEffort: runtime.reasoningEffort ?? undefined,
        // The tool policy still applies: a chat inspects, it does not mutate.
        systemPrompt: [DEFAULT_ASSISTANT_PROMPT, routingPrompt, recentConversation, describeWorkspaceForAlpha(workspaceId),
          describeOrchestratorGitHubAccess(projectRepos),
          describeLocalProjectFiles(assistantProject?.name ?? null, localCode.roots, localCode.missing),
          assistantProject ? describeProjectBuild(sqliteService.getLatestOrchestrationSnapshot(assistantProject.id),
            agentId => sqliteService.getAgents().find(agent => agent.id === agentId)?.name ?? agentId) : undefined,
          describeChatToolPolicy(assistantServers, approvalSkills, approvalSkills.includes('sk-git') ? 'write' : 'read', approvalSkills.length === 0)]
          .filter(Boolean)
          .join('\n\n---\n\n'),
        personaName: DEFAULT_ASSISTANT.name,
        prompt,
        priorSession: priorSession?.cliSessionId ?? null,
        // Read-only GitHub tools: a chat turn without the sk-git skill gets 'read' access from mcpAccessFor.
        mcpServers: assistantServers,
        autonomyLevel: approvalSkills.includes('sk-git') ? 'Full Autonomy' : undefined,
        // Set, even empty, for Codex and Claude: the turn then reads files only through Alpha.
        projectRoots: localCode.roots,
        // The project's repositories are cloned into its folder on this computer.
        projectFolder: assistantProject ? { dir: ensureProjectFolder(assistantProject), repos: projectRepos } : undefined,
        onEvent: activityCallId ? event => agentCallService.recordChatTurnCliEvent(activityCallId, event, cwd) : undefined
      });

      if (turn.sessionId) {
        sqliteService.setThreadSession(threadId, sessionKey, turn.sessionId);
      }

      if (turn.failureKind === 'limit') {
        markUsageLimited(runtime.provider, turn.failureDetail ?? 'Its usage limit was reached.');
        continue;
      }

      if (turn.failureKind) {
        const cli = turn.bin.replace('.cmd', '');
        const failed: ChatMessage = {
          ...base,
          content:
            `I could not reach the ${runtime.provider} CLI, so I have no answer for you.\n\n` +
            `Reason: ${turn.failureDetail}\n\n` +
            `Check that \`${cli}\` is installed and signed in — the Runtimes page shows its status.`,
          thinkingProcess: turn.thinking
        };
        this.failedDefaultReplies.add(failed);
        return failed;
      }

      clearUsageLimit(runtime.provider);
      // Say so when the answer came from somewhere other than the first choice.
      const skipped = candidates
        .slice(0, candidates.indexOf(runtime))
        .filter(candidate => usageLimitFor(candidate.provider));
      const note = skipped.length
        ? `_${skipped.map(runtimeLabel).join(' and ')} ${skipped.length === 1 ? 'is' : 'are'} at ${skipped.length === 1 ? 'its' : 'their'} usage limit, so this answer came from ${runtimeLabel(runtime)} (${runtime.modelName})._\n\n`
        : '';

      return {
        ...base,
        content: note + turn.content.trim(),
        thinkingProcess: turn.thinking,
        toolsExecuted: turn.tools
      };
    }

    // Every signed-in runtime said its plan is used up.
    const limited: ChatMessage = {
      ...base,
      senderType: 'system',
      content: [
        'Every signed-in AI runtime on this machine is at its usage limit, so I cannot answer right now.',
        '',
        ...candidates.map(candidate => `- ${runtimeLabel(candidate)}: ${usageLimitFor(candidate.provider) ?? 'usage limit reached'}`),
        '',
        'Pick a model on another runtime for the Orchestrator in the chat header, or wait for a limit to reset.'
      ].join('\n')
    };
    this.failedDefaultReplies.add(limited);
    return limited;
  }


  /**
   * One reply from this agent's CLI.
   *
   * The provider-specific argv rules live in `cliRunner` — the agent builder
   * needs the same dispatch, and two copies of them would drift. What stays
   * here is what is specific to chat: the thread's resumable session, and how
   * a failure is worded to somebody waiting on a message.
   */
  private async generateAgentReply(
    agent: any,
    prompt: string,
    threadId: string,
    priorTurn?: string,
    activityCallId?: string,
    runId = activityCallId ?? `chat-${randomUUID()}`,
    approvalMode?: ChatApprovalMode
  ): Promise<{ content: string; thinking?: string; tools: any[]; activityCallId?: string; failed?: boolean }> {
    /**
     * Resume the CLI's own session so the agent remembers this thread.
     *
     * Both CLIs keep the transcript on local disk and take an id to continue
     * it, which is far cheaper than replaying history into every prompt.
     * The id is looked up per (thread, machine, agent) — see
     * sqliteService.migrate() for why all three parts are required.
     */
    const priorSession = sqliteService.getThreadSession(threadId, agent.id);
    const activeProject = threadProject(threadId);
    const localProjectRoots = activeProject ? projectReadRoots(activeProject).roots : [];

    /**
     * Chat turns run in the managed workspace root, not `path.resolve('..')`.
     *
     * That old default was the directory above the daemon — Alpha's own source
     * tree. A chat agent asked about someone's repository was reading and
     * editing Alpha itself, and the allowlist could not object because the
     * seed data granted exactly that path.
     *
     * The workspace root is the honest answer for a thread: chats belong to no
     * project, so the right scope is everything Alpha has cloned or scaffolded
     * and nothing else. A repository the agent wants is one
     * `github_clone_repository` call away, and lands right here.
     */
    /**
     * The persona file wins over the database row, and the memory tiers are
     * appended to it.
     *
     * No project key: a chat thread belongs to no project, so Tier 2 does not
     * apply. Global and agent memory do.
     */
    const persona = resolveAgentLogged(agent, {
      includeToolPolicy: true,
      ...(approvalMode ? {
        skillsOverride: skillsForChatApproval(approvalMode, localProjectRoots.length > 0),
        ...(approvalMode === 'full' ? { autonomyOverride: 'Full Autonomy' as const } : {})
      } : {}),
      // Alpha's own roster. Without it the agent answers "what agents exist"
      // with whatever its underlying CLI defines, which is not Alpha's answer.
      roster: sqliteService
        .getAgents()
        .filter(a => !a.isArchived)
        .map(a => ({ id: a.id, name: a.name, role: a.role }))
    });

    /**
     * Has the persona changed since this conversation started?
     *
     * A null stored hash means the session predates the column, not that
     * anything changed — announcing an instruction change to every existing
     * thread on first upgrade would be noise, so unknown is treated as
     * unchanged.
     */
    const personaChanged =
      !!priorSession?.personaHash && priorSession.personaHash !== persona.personaHash;

    if (personaChanged) {
      logInfo(`Persona for ${agent.id} changed mid-thread ${threadId} — re-announcing`);
    }

    /**
     * Refuse the turn when the agent is pinned to a model its CLI has retired.
     *
     * Spawning anyway produces the least useful error in the product: `agy`
     * reports "invalid model selection" and tells the user to check that the
     * CLI is installed and signed in — which it is, so the advice sends them
     * to the Runtimes page, where everything looks green. Answering from here
     * costs nothing (no process, no tokens) and names the actual fix.
     */
    const runtimes = sqliteService.getRuntimes();
    const readiness = agentReadiness(agent, runtimes);
    if (readiness.status === 'stale_model') {
      logInfo(`Refusing turn for ${agent.id}: ${readiness.detail}`);
      return {
        content: `${readiness.detail}\n\n${readiness.command ?? ''}`.trim(),
        tools: [],
        activityCallId,
        failed: true
      };
    }

    const { env } = buildEnv(agent.envVars);
    // The agent's own values, as in a run; project variables no longer apply.
    reportIgnoredProjectEnv(threadProject(threadId));

    const cwd = chatWorkspace(threadId);
    const turn = await runCliTurn({
      runId,
      cwd,
      provider: persona.modelProvider,
      approvalMode,
      modelName: persona.modelName,
      codexBaseUrl: runtimes.find(runtime =>
        runtime.provider === persona.modelProvider && runtime.models.includes(persona.modelName)
      )?.endpoint,
      reasoningEffort: persona.reasoningEffort,
      systemPrompt: persona.systemPrompt,
      personaName: persona.name,
      // What other agents said this turn rides with the message, not the system
      // prompt: it is true of this turn only, and putting it in the persona
      // would break the stable cacheable prefix a resumed session depends on.
      prompt: priorTurn ? `${prompt}

---

${priorTurn}` : prompt,
      priorSession: priorSession?.cliSessionId ?? null,
      personaChanged,
      mcpServers: persona.mcpServers,
      mcpEnv: env,
      // What this agent may actually do this turn. Resolved from the persona
      // rather than the raw row so a persona file's `skills:` overlay counts,
      // the same way it does for every other field.
      skills: persona.skills,
      projectRoots: localProjectRoots,
      projectFolder: activeProject ? { dir: ensureProjectFolder(activeProject), repos: reposForProject(activeProject) } : undefined,
      autonomyLevel: persona.autonomyLevel,
      env,
      customCliArgs: agent.customCliArgs,
      onEvent: activityCallId
        ? event => agentCallService.recordChatTurnCliEvent(activityCallId, event, cwd)
        : undefined
    });

    // Store the session so the next message in this thread continues it.
    // Claude mints a NEW id on every resume, so this must be re-saved each
    // turn rather than written once. The persona hash rides along: it is what
    // the NEXT turn compares against.
    if (turn.sessionId) {
      sqliteService.setThreadSession(threadId, agent.id, turn.sessionId, persona.personaHash);
    }

    let content = turn.content;
    if (turn.failureKind === 'limit') {
      content =
        `${persona.modelProvider} is at its usage limit, so ${persona.name} cannot answer right now.\n\n` +
        `${turn.failureDetail}\n\n` +
        'Choose a model on another runtime for this agent (click it in the chat header), or wait for the limit to reset.';
    } else if (turn.failureKind === 'empty') {
      content =
        `I could not reach the ${persona.modelProvider} CLI, so I have no answer for you.\n\n` +
        `Reason: ${turn.failureDetail}\n\n` +
        `Check that \`${turn.bin.replace('.cmd', '')}\` is installed and signed in — the Runtimes page shows its status.`;
    } else if (turn.failureKind === 'spawn') {
      content =
        `I could not start the ${persona.modelProvider} CLI.\n\n` +
        `Reason: ${turn.failureDetail}`;
    }

    return {
      content: content.trim(),
      thinking: turn.thinking,
      tools: turn.tools,
      activityCallId,
      failed: Boolean(turn.failureKind)
    };
  }
}

export const chatService = new ChatService();

/**
 * What the agents who have already answered said.
 *
 * Truncated per reply because this grows with every member: four agents at
 * full length would put three long answers into the fourth one's prompt. The
 * cap keeps a multi-agent chat turn near the CLI's own baseline rather than
 * doubling it.
 */
const PRIOR_REPLY_CHARS = 800;

function describePriorReplies(messages: ChatMessage[]): string {
  const lines = messages.map(m => {
    const body = m.content.length > PRIOR_REPLY_CHARS
      ? `${m.content.slice(0, PRIOR_REPLY_CHARS)}…`
      : m.content;
    return `### ${m.senderName}
${body}`;
  });

  return [
    'Other agents have already answered this message:',
    '',
    ...lines,
    '',
    'Add what your own specialism contributes. Do not repeat what they have already covered,',
    'and say so plainly if you disagree with them.'
  ].join('\n');
}
