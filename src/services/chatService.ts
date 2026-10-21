import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { sqliteService } from './sqliteService.js';
import { ChatMessage, ChatThread, Squad } from '../models/index.js';
import { runCliTurn } from './cliRunner.js';
import {
  ensureWorkspacesRoot,
  resolveProjectWorkspace,
  allowAttachedWorkspace
} from './workspaceService.js';
import { resolveAgentLogged } from './personaService.js';
import { buildEnv, reportIgnoredProjectEnv } from './customCliArgs.js';
import {
  DEFAULT_ASSISTANT,
  DEFAULT_ASSISTANT_PROMPT,
  pickDefaultRuntime
} from './defaultAssistant.js';
import { describeChatToolPolicy, describeAlphaWorkspace } from './toolPolicy.js';
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
import { runWithWorkspace } from './workspaceContext.js';

export interface SendMessageParams {
  threadId: string;
  content: string;
  senderName?: string;
  /** Explicit target from the chat picker. Null clears a persisted target. */
  targetAgentId?: string | null;
  targetSquadId?: string | null;
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
  buildRequest?: { context: WorkspaceContext; repository?: string; repositories?: string[] };
}

/**
 * Match every `@mention` in a message to an agent, or to a whole squad.
 *
 * An agent matches on first name (`@Ada`), full name with no space
 * (`@AdaLovelace`), id (`@agent-ada`) or role (`@Reviewer`) — all things a
 * person plausibly types.
 *
 * A squad matches on its full name with no space or its id, and expands to
 * its members in execution order. Deliberately NOT on its first word: the
 * seeded squad is "Alpha Core Execution Squad", and `@Alpha` is both its
 * first word and the name of the default assistant. Agents are matched
 * first, so an agent name always wins a tie.
 *
 * Returns agents in mention order, de-duplicated, so naming a squad and then
 * one of its members does not make that member answer twice.
 */
export function resolveMentions(content: string, agents: any[], squads: Squad[] = []): any[] {
  const tokens = [...content.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(m => m[1].toLowerCase());
  const picked: any[] = [];
  const add = (agent: any) => {
    if (agent && !picked.some(p => p.id === agent.id)) picked.push(agent);
  };

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
    if (agent) {
      add(agent);
      continue;
    }

    const squad = squads.find(sq => {
      const name = String(sq.name ?? '').toLowerCase();
      return sq.id?.toLowerCase() === token || name.replace(/\s+/g, '') === token;
    });
    if (squad) {
      for (const id of orderedSquadMembers(squad)) {
        add(agents.find(a => a.id === id));
      }
    }
  }

  return picked;
}

/**
 * Resolve the target chosen in the Chats tab when the message has no explicit
 * @mention. Keeping this separate from mention resolution makes the precedence
 * clear: a typed mention wins, otherwise the per-thread picker wins, otherwise
 * Alpha answers as the automatic responder.
 */
export function resolveChatTarget(
  targetAgentId: string | undefined,
  targetSquadId: string | undefined,
  agents: any[],
  squads: Squad[] = []
): any[] {
  if (targetAgentId) {
    const agent = agents.find(a => a.id === targetAgentId);
    return agent ? [agent] : [];
  }

  if (targetSquadId) {
    const squad = squads.find(sq => sq.id === targetSquadId);
    if (!squad) return [];
    return orderedSquadMembers(squad)
      .map(id => agents.find(a => a.id === id))
      .filter(Boolean);
  }

  return [];
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
   * Every reply, in the order they were produced. Longer than one when a squad
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
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const isolated = fs.mkdtempSync(path.join(RUNS_DIR, 'chat-empty-'));
    sqliteService.addAllowedPath(isolated, `Empty chat context for ${project.name}`);
    logInfo(`Thread project "${project.name}" has no working copy on disk — using an empty isolated context`);
    return isolated;
  }

  // The same consent record a run makes: a hand-attached folder is registered,
  // a managed checkout is already covered by the root allowlist entry.
  allowAttachedWorkspace(workspace, project.name);
  return workspace.dir;
}

/**
 * The agents and squads Alpha can speak about.
 *
 * An agent reply already gets a roster — see `resolveAgentLogged` — and Alpha,
 * the one you would naturally ask "which squads do I have", got nothing. Asked
 * about them it reached for its CLI's own tooling, ran `ListAgents`, and
 * reported on Claude Code sessions instead.
 *
 * Squads are included here and not in the agent roster because Alpha is the
 * only participant that talks about the workspace as a whole; an agent is a
 * member of it.
 */
function describeWorkspaceForAlpha(workspaceId?: string): string {
  const agents = (workspaceId ? workspaceRegistry.scope('agents', sqliteService.getAgents(), workspaceId) : sqliteService.getAgents())
    .filter(a => !a.isArchived)
    .map(a => ({ id: a.id, name: a.name, role: a.role }));

  const byId = new Map(agents.map(a => [a.id, a.name]));

  const squads = (workspaceId ? workspaceRegistry.scope('squads', sqliteService.getSquads(), workspaceId) : sqliteService.getSquads()).map(sq => ({
    name: sq.name,
    topology: sq.topology,
    memberNames: (sq.memberAgentIds ?? []).map(id => byId.get(id) ?? id)
  }));

  return describeAlphaWorkspace(agents, squads);
}

export class ChatService extends EventEmitter {
  private readonly activeTurns = new Map<string, ActiveChatTurn>();

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
    squadId?: string;
  }): Promise<string | undefined> {
    const { params, project, threadId, messageId, agent, instruction, turn } = input;
    if (!project || !params.workspaceId || !params.userId) return undefined;
    try {
      const call = await agentCallService.startChatTurn({
        workspaceId: params.workspaceId, project, threadId, messageId,
        squadId: input.squadId, agent, requestedBy: params.userId, instruction
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
        targetSquadId: params.targetSquadId ?? undefined,
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
      const existingBuildReply = existingUserMessage
        ? sqliteService.getChatMessages(threadId).find(message => message.id === `${messageId}-build`)
        : undefined;
      if (existingBuildReply) {
        if (existingBuildReply.orchestrationRunId && workspaceId && params.userId) {
          runWithWorkspace(workspaceId, () => sqliteService.bindOrchestrationChat({
            runId: existingBuildReply.orchestrationRunId!,
            threadId,
            buildMessageId: existingBuildReply.id,
            actorId: params.userId!
          }));
        }
        return { userMessage, agentMessage: existingBuildReply, agentMessages: [existingBuildReply] };
      }

      const repositories = [...new Set((params.buildRequest.repositories ?? (params.buildRequest.repository ? [params.buildRequest.repository] : []))
        .map(repository => repository.trim()).filter(Boolean))];
      const buildAttachmentContext = chatAttachmentService.promptContext(threadId, attachmentIds, messageId, false, false);
      const builds = await startProjectBuildBatch({
        context: params.buildRequest.context,
        projectId: thread.projectId,
        threadId,
        messageId: userMessage.id,
        content: `${content}${buildAttachmentContext.text}`,
        repositories
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
              result.squadName ? `Agent sequence: ${result.squadName}` : undefined,
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
              build.squadName ? `**Agent sequence:** ${build.squadName}` : undefined,
              build.branchName ? `**Working branch:** ${build.branchName}` : undefined,
              'Open the Live Build Room to follow each agent, handoff, changed file, and verification result.'
            ].filter(Boolean).join('\n\n');
      const reply: ChatMessage = {
        id: `${messageId}-build`,
        threadId,
        senderType: 'agent',
        senderName: 'Alpha Orchestrator',
        content: summary,
        messageType: 'build',
        orchestrationRunId: build.orchestrationRunId,
        timestamp: new Date().toISOString()
      };
      saveChatMessageAndShare(reply);
      if (build.orchestrationRunId && workspaceId && params.userId) {
        runWithWorkspace(workspaceId, () => sqliteService.bindOrchestrationChat({
          runId: build.orchestrationRunId!,
          threadId,
          buildMessageId: reply.id,
          actorId: params.userId!
        }));
      }
      this.emit('chat_message', reply);
      return { userMessage, agentMessage: reply, agentMessages: [reply], build, builds: builds.length > 1 ? builds : undefined };
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
    const squads = sqliteService.getSquads();
    const mentioned = resolveMentions(content, agents, squads);
    const hasExplicitTarget =
      params.targetAgentId !== undefined || params.targetSquadId !== undefined;
    const targetAgentId = hasExplicitTarget
      ? params.targetAgentId ?? undefined
      : thread.targetAgentId;
    const targetSquadId = hasExplicitTarget
      ? params.targetSquadId ?? undefined
      : thread.targetSquadId;
    const addressed = mentioned.length
      ? mentioned
      : resolveChatTarget(targetAgentId, targetSquadId, agents, squads);

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
      const reply = await this.runWithSteering(turn, requestContent, prompt =>
        this.generateDefaultReply(prompt, threadId, workspaceId, runId, activityCallId)
      );
      if (!reply || turn.stopRequested) {
        if (activityCallId) agentCallService.cancelChatTurn(activityCallId);
        const stopped = this.stoppedMessage(threadId);
        saveChatMessageAndShare(stopped);
        return { userMessage, agentMessage: stopped, agentMessages: [stopped] };
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
     * One `@agent` is one reply, which is the ordinary case. Naming a squad
     * expands to its members, and each of them speaks after seeing what the
     * members before it said — the conversational counterpart of the written
     * handoff a squad run passes between members.
     *
     * Sequential rather than parallel on purpose: PROVIDER_CONCURRENCY caps
     * Anthropic at 2 concurrent, and a four-member squad answering at once
     * would spend the whole allowance on a single chat message.
     */
    if (addressed.length > 1) {
      logInfo(`Chat: ${addressed.length} agents addressed — answering in sequence`);
    }

    const agentMessages: ChatMessage[] = [];
    const project = thread.projectId
      ? sqliteService.getProjects().find(item => item.id === thread!.projectId)
      : undefined;
    let activeSquadAssignments: Array<{ squadId: string; status: string }> = [];
      if (project && workspaceId) {
      try {
        activeSquadAssignments = (await workspaceRegistry.listSquadProjectAssignments(workspaceId, project.id))
          .filter(assignment => assignment.status === 'active');
      } catch {
        // Chat still works if the room directory is temporarily unavailable.
      }
    }

    for (const [index, agent] of addressed.entries()) {
      const priorTurn = agentMessages.length ? describePriorReplies(agentMessages) : undefined;
      const squadId = activeSquadAssignments.find(assignment =>
        sqliteService.getSquads().some(squad => squad.id === assignment.squadId && squad.memberAgentIds.includes(agent.id))
      )?.squadId;
      let activityCallId: string | undefined;
      if (project && workspaceId && params.userId) {
        activityCallId = await this.startProjectChatActivity({
          params, project, threadId, messageId: userMessage.id, squadId, agent,
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
          this.generateAgentReply(agent, prompt, threadId, priorTurn, activityCallId, runId)
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
    activityCallId?: string
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

    const runtime = pickDefaultRuntime(sqliteService.getRuntimes());
    if (!runtime) {
      return {
        ...base,
        senderType: 'system',
        content: [
          'No AI runtime is signed in on this machine, so I cannot answer.',
          '',
          'Install and sign in to one of the agent CLIs — the Runtimes page shows what it found.'
        ].join('\n')
      };
    }

    const priorSession = sqliteService.getThreadSession(threadId, DEFAULT_ASSISTANT.id);
    const cwd = chatWorkspace(threadId);

    logInfo(`Default assistant replying via ${runtime.provider}/${runtime.modelName}`);

    const turn = await runCliTurn({
      runId,
      cwd,
      provider: runtime.provider,
      modelName: runtime.modelName,
      codexBaseUrl: runtime.endpoint,
      // The tool policy still applies: a chat inspects, it does not mutate.
      systemPrompt: [DEFAULT_ASSISTANT_PROMPT, describeWorkspaceForAlpha(workspaceId), describeChatToolPolicy()]
        .filter(Boolean)
        .join(`

---

`),
      personaName: DEFAULT_ASSISTANT.name,
      prompt,
      priorSession: priorSession?.cliSessionId ?? null,
      onEvent: activityCallId ? event => agentCallService.recordChatTurnCliEvent(activityCallId, event, cwd) : undefined
    });

    if (turn.sessionId) {
      sqliteService.setThreadSession(threadId, DEFAULT_ASSISTANT.id, turn.sessionId);
    }

    if (turn.failureKind) {
      const cli = turn.bin.replace('.cmd', '');
      return {
        ...base,
        content:
          `I could not reach the ${runtime.provider} CLI, so I have no answer for you.

` +
          `Reason: ${turn.failureDetail}

` +
          `Check that \`${cli}\` is installed and signed in — the Runtimes page shows its status.`,
        thinkingProcess: turn.thinking
      };
    }

    return {
      ...base,
      content: turn.content.trim(),
      thinkingProcess: turn.thinking,
      toolsExecuted: turn.tools
    };
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
    runId = activityCallId ?? `chat-${randomUUID()}`
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
      modelName: persona.modelName,
      codexBaseUrl: runtimes.find(runtime =>
        runtime.provider === persona.modelProvider && runtime.models.includes(persona.modelName)
      )?.endpoint,
      reasoningEffort: persona.reasoningEffort,
      systemPrompt: persona.systemPrompt,
      personaName: persona.name,
      // What squadmates said this turn rides with the message, not the system
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
    if (turn.failureKind === 'empty') {
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

/** Leader first when there is one, then the rest in their configured order. */
function orderedSquadMembers(squad: Squad): string[] {
  const members = [...new Set(squad.memberAgentIds ?? [])];
  const leader = squad.leaderAgentId;
  if (!leader || !members.includes(leader)) return members;
  return [leader, ...members.filter(id => id !== leader)];
}

/**
 * What the squadmates who have already answered said.
 *
 * Truncated per reply because this grows with every member: four agents at
 * full length would put three long answers into the fourth one's prompt. The
 * cap keeps a squad chat turn near the CLI's own baseline rather than doubling
 * it, which is the same reason a squad RUN passes a written handoff instead of
 * a replayed transcript.
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
    'Your squadmates have already answered this message:',
    '',
    ...lines,
    '',
    'Add what your own specialism contributes. Do not repeat what they have already covered,',
    'and say so plainly if you disagree with them.'
  ].join('\n');
}
