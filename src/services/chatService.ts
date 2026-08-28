import { EventEmitter } from 'node:events';
import { sqliteService } from './sqliteService.js';
import { ChatMessage, ChatThread } from '../models/index.js';
import { runCliTurn } from './cliRunner.js';
import { ensureWorkspacesRoot } from './workspaceService.js';
import { resolveAgentLogged } from './personaService.js';

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

    // 2. Resolve who is being addressed.
    //
    //    Order: an explicit @mention in THIS message, else whoever the thread
    //    is already talking to. A thread with no agent and no mention is not an
    //    error — it is a question addressed to nobody, and it gets a reply
    //    telling the user how to address someone.
    const agents = sqliteService.getAgents().filter(a => !a.isArchived);
    const mentioned = this.resolveMentions(content, agents);

    let participants = mentioned.length
      ? mentioned
      : agents.filter(a => (thread!.agentIds ?? []).includes(a.id));

    if (!participants.length) {
      const roster = agents.map(a => `@${a.name.split(' ')[0]}`).join(', ');
      const hint: ChatMessage = {
        id: `msg-${Date.now()}-system`,
        threadId,
        senderType: 'system',
        senderName: 'Alpha',
        content:
          `No agent is assigned to this conversation yet.\n\n` +
          `Mention one to start: ${roster || 'no agents configured'}`,
        timestamp: new Date().toISOString()
      };
      sqliteService.saveChatMessage(hint);
      this.emit('chat_message', hint);
      return { userMessage, agentMessage: hint };
    }

    // An @mention joins that agent to the thread for subsequent messages, so
    // follow-ups do not need to repeat the mention.
    const roster = [...new Set([...(thread.agentIds ?? []), ...participants.map(a => a.id)])];
    sqliteService.setChatThreadAgents(threadId, roster);

    const targetAgent = participants[0];

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
    const persona = resolveAgentLogged(agent);

    const turn = await runCliTurn({
      runId: `chat-${Date.now()}`,
      cwd: ensureWorkspacesRoot(),
      provider: persona.modelProvider,
      modelName: persona.modelName,
      systemPrompt: persona.systemPrompt,
      personaName: persona.name,
      prompt,
      priorSession,
      mcpServers: persona.mcpServers
    });

    // Store the session so the next message in this thread continues it.
    // Claude mints a NEW id on every resume, so this must be re-saved each
    // turn rather than written once.
    if (turn.sessionId) {
      sqliteService.setThreadSession(threadId, agent.id, turn.sessionId);
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
