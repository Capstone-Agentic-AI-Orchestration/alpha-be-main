import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { sqliteService } from './sqliteService.js';
import { ChatMessage, ChatThread, Squad } from '../models/index.js';
import { runCliTurn } from './cliRunner.js';
import {
  ensureWorkspacesRoot,
  resolveProjectWorkspace,
  allowAttachedWorkspace
} from './workspaceService.js';
import { resolveAgentLogged } from './personaService.js';
import { buildEnv } from './customCliArgs.js';
import {
  DEFAULT_ASSISTANT,
  DEFAULT_ASSISTANT_PROMPT,
  pickDefaultRuntime
} from './defaultAssistant.js';
import { describeChatToolPolicy, describeAlphaWorkspace } from './toolPolicy.js';
import { agentReadiness } from './agentReadiness.js';
import { logInfo } from '../utils/logger.js';

export interface SendMessageParams {
  threadId: string;
  content: string;
  senderName?: string;
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
    logInfo(`Thread project "${project.name}" has no working copy on disk — using the managed root`);
    return root;
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
function describeWorkspaceForAlpha(): string {
  const agents = sqliteService
    .getAgents()
    .filter(a => !a.isArchived)
    .map(a => ({ id: a.id, name: a.name, role: a.role }));

  const byId = new Map(agents.map(a => [a.id, a.name]));

  const squads = sqliteService.getSquads().map(sq => ({
    name: sq.name,
    topology: sq.topology,
    memberNames: (sq.memberAgentIds ?? []).map(id => byId.get(id) ?? id)
  }));

  return describeAlphaWorkspace(agents, squads);
}

export class ChatService extends EventEmitter {
  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const { threadId, content, senderName = 'You' } = params;
    const now = new Date().toISOString();

    let thread = sqliteService.getChatThreads().find(t => t.id === threadId);
    if (!thread) {
      thread = sqliteService.createChatThread({
        id: threadId,
        title: content.slice(0, 40) || 'New Conversation',
        lastMessageSnippet: content.slice(0, 100),
        lastMessageAt: now,
        // No agent is assigned up front — the thread belongs to whoever the
        // user @-mentions. Defaulting to agent-ada meant every conversation
        // silently had a participant nobody chose.
        agentIds: [],
        createdAt: now
      });
    }

    // 1. Save user message
    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}-user`,
      threadId,
      senderType: 'user',
      senderName,
      content,
      timestamp: now
    };
    sqliteService.saveChatMessage(userMessage);

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

    if (!mentioned.length) {
      const reply = await this.generateDefaultReply(content, threadId);
      sqliteService.saveChatMessage(reply);
      this.emit('chat_message', reply);
      return { userMessage, agentMessage: reply, agentMessages: [reply] };
    }

    /**
     * The thread still records who has taken part, for the roster the UI shows
     * and for per-agent CLI sessions. It is no longer used to decide who
     * answers — that is what made a mention permanent.
     */
    const roster = [...new Set([...(thread.agentIds ?? []), ...mentioned.map(a => a.id)])];
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
    if (mentioned.length > 1) {
      logInfo(`Chat: ${mentioned.length} agents addressed — answering in sequence`);
    }

    const agentMessages: ChatMessage[] = [];

    for (const [index, agent] of mentioned.entries()) {
      const priorTurn = agentMessages.length ? describePriorReplies(agentMessages) : undefined;
      const reply = await this.generateAgentReply(agent, content, threadId, priorTurn);

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

      sqliteService.saveChatMessage(message);
      this.emit('chat_message', message);
      agentMessages.push(message);
    }

    return { userMessage, agentMessage: agentMessages[0], agentMessages };
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
  private async generateDefaultReply(prompt: string, threadId: string): Promise<ChatMessage> {
    const now = () => new Date().toISOString();
    const base = {
      id: `msg-${Date.now()}-alpha`,
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

    logInfo(`Default assistant replying via ${runtime.provider}/${runtime.modelName}`);

    const turn = await runCliTurn({
      runId: `chat-${Date.now()}`,
      cwd: chatWorkspace(threadId),
      provider: runtime.provider,
      modelName: runtime.modelName,
      // The tool policy still applies: a chat inspects, it does not mutate.
      systemPrompt: [DEFAULT_ASSISTANT_PROMPT, describeWorkspaceForAlpha(), describeChatToolPolicy()]
        .filter(Boolean)
        .join(`

---

`),
      personaName: DEFAULT_ASSISTANT.name,
      prompt,
      priorSession: priorSession?.cliSessionId ?? null
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
    priorTurn?: string
  ): Promise<{ content: string; thinking?: string; tools: any[] }> {
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
    const readiness = agentReadiness(agent, sqliteService.getRuntimes());
    if (readiness.status === 'stale_model') {
      logInfo(`Refusing turn for ${agent.id}: ${readiness.detail}`);
      return {
        content: `${readiness.detail}\n\n${readiness.command ?? ''}`.trim(),
        tools: []
      };
    }

    const { env } = buildEnv(agent.envVars);
    // A thread pinned to a project resolves that project's MCP values, so
    // asking an agent about ALF in chat reaches the same Supabase its runs do.
    const { env: projectEnv } = buildEnv(threadProject(threadId)?.envVars);

    const turn = await runCliTurn({
      runId: `chat-${Date.now()}`,
      cwd: chatWorkspace(threadId),
      provider: persona.modelProvider,
      modelName: persona.modelName,
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
      mcpEnv: { ...projectEnv, ...env },
      env,
      customCliArgs: agent.customCliArgs
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
      tools: turn.tools
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
