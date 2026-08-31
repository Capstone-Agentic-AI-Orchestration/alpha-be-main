import { EventEmitter } from 'node:events';
import { sqliteService } from './sqliteService.js';
import { ChatMessage, ChatThread } from '../models/index.js';
import { runCliTurn } from './cliRunner.js';
import { ensureWorkspacesRoot } from './workspaceService.js';
import { resolveAgentLogged } from './personaService.js';
import { buildEnv } from './customCliArgs.js';
import {
  DEFAULT_ASSISTANT,
  DEFAULT_ASSISTANT_PROMPT,
  pickDefaultRuntime
} from './defaultAssistant.js';
import { describeChatToolPolicy } from './toolPolicy.js';
import { logInfo } from '../utils/logger.js';

export interface SendMessageParams {
  threadId: string;
  content: string;
  senderName?: string;
}

export class ChatService extends EventEmitter {
  async sendMessage(params: SendMessageParams): Promise<{ userMessage: ChatMessage; agentMessage: ChatMessage }> {
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
    const mentioned = this.resolveMentions(content, agents);

    if (!mentioned.length) {
      const reply = await this.generateDefaultReply(content, threadId);
      sqliteService.saveChatMessage(reply);
      this.emit('chat_message', reply);
      return { userMessage, agentMessage: reply };
    }

    /**
     * The thread still records who has taken part, for the roster the UI shows
     * and for per-agent CLI sessions. It is no longer used to decide who
     * answers — that is what made a mention permanent.
     */
    const roster = [...new Set([...(thread.agentIds ?? []), ...mentioned.map(a => a.id)])];
    sqliteService.setChatThreadAgents(threadId, roster);

    const targetAgent = mentioned[0];

    // 3. Generate Agent Response using CLI
    const agentMsgId = `msg-${Date.now()}-agent`;
    const agentResponse = await this.generateAgentReply(targetAgent, content, threadId);

    const agentMessage: ChatMessage = {
      id: agentMsgId,
      threadId,
      senderType: 'agent',
      senderName: targetAgent.name,
      agentId: targetAgent.id,
      content: agentResponse.content,
      thinkingProcess: agentResponse.thinking,
      toolsExecuted: agentResponse.tools,
      timestamp: new Date().toISOString()
    };

    sqliteService.saveChatMessage(agentMessage);
    this.emit('chat_message', agentMessage);

    return { userMessage, agentMessage };
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
      cwd: ensureWorkspacesRoot(),
      provider: runtime.provider,
      modelName: runtime.modelName,
      // The tool policy still applies: a chat inspects, it does not mutate.
      systemPrompt: `${DEFAULT_ASSISTANT_PROMPT}

---

${describeChatToolPolicy()}`,
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
   * Match every `@mention` in a message to a configured agent.
   *
   * Matches on first name (`@Ada`), full name with no space (`@AdaLovelace`),
   * id (`@agent-ada`) or role (`@Reviewer`), because those are all things a
   * person plausibly types. Returns them in mention order and de-duplicated.
   */
  private resolveMentions(content: string, agents: any[]): any[] {
    const tokens = [...content.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(m => m[1].toLowerCase());
    const picked: any[] = [];

    for (const token of tokens) {
      const hit = agents.find(a => {
        const name = String(a.name ?? '').toLowerCase();
        return (
          a.id?.toLowerCase() === token ||
          name.replace(/\s+/g, '') === token ||
          name.split(/\s+/)[0] === token ||
          String(a.role ?? '').toLowerCase().replace(/\s+/g, '') === token
        );
      });
      if (hit && !picked.some(p => p.id === hit.id)) picked.push(hit);
    }

    return picked;
  }

  /**
   * One reply from this agent's CLI.
   *
   * The provider-specific argv rules live in `cliRunner` — the agent builder
   * needs the same dispatch, and two copies of them would drift. What stays
   * here is what is specific to chat: the thread's resumable session, and how
   * a failure is worded to somebody waiting on a message.
   */
  private async generateAgentReply(agent: any, prompt: string, threadId: string): Promise<{ content: string; thinking?: string; tools: any[] }> {
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

    const { env } = buildEnv(agent.envVars);

    const turn = await runCliTurn({
      runId: `chat-${Date.now()}`,
      cwd: ensureWorkspacesRoot(),
      provider: persona.modelProvider,
      modelName: persona.modelName,
      systemPrompt: persona.systemPrompt,
      personaName: persona.name,
      prompt,
      priorSession: priorSession?.cliSessionId ?? null,
      personaChanged,
      mcpServers: persona.mcpServers,
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
