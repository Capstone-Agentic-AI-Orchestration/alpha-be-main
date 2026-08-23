import { EventEmitter } from 'node:events';
import { sqliteService } from './sqliteService.js';
import { processManager } from './processManager.js';
import { ChatMessage, ChatThread } from '../models/index.js';
import { createLineBuffer } from '../utils/lineBuffer.js';
import { StreamParser, StreamFamily } from './streamParser.js';
import { RuntimeService } from './runtimeService.js';
import { logInfo, logError } from '../utils/logger.js';
import path from 'node:path';

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

  private async generateAgentReply(agent: any, prompt: string, threadId: string): Promise<{ content: string; thinking?: string; tools: any[] }> {
    const cwd = path.resolve('..');
    const runId = `chat-${Date.now()}`;
    const cleanPrompt = `Instructions: ${agent.systemPrompt}. User Query: ${prompt}. (Respond directly and concisely).`;

    const tools: any[] = [];
    let content = '';
    let thinking = `Analyzing question using ${agent.modelProvider} (${agent.modelName})...`;

    let stderr = '';
    let streamError = '';

    try {
      const isWin = process.platform === 'win32';
      const isCodex = agent.modelProvider === 'OpenAI';
      const isAntigravity =
        agent.modelProvider === 'Antigravity' || agent.modelProvider === 'Google Gemini';

      let family: StreamFamily = 'claude';
      let bin = isWin ? 'claude.cmd' : 'claude';
      let args = [
        '-p', prompt,
        '--system-prompt', agent.systemPrompt,
        '--output-format', 'stream-json',
        // REQUIRED. Without it the CLI exits 1 with
        // "When using --print, --output-format=stream-json requires --verbose",
        // stdout stays empty, and this method silently returns a canned string.
        '--verbose',
        // Chat inspects, it does not mutate. Denying the write tools outright
        // is safer than bypassPermissions and — unlike leaving them to prompt —
        // cannot hang a headless process waiting on a TTY that isn't there.
        '--allowedTools', 'Read', 'Glob', 'Grep',
        '--disallowedTools', 'Write', 'Edit', 'Bash',
        // Isolate the agent persona from the operator's personal Claude Code
        // configuration. Without this the host's ~/.claude/CLAUDE.md is loaded
        // into every reply — output-style directives and all — so Ada answered
        // in the machine owner's preferred format instead of her own.
        '--setting-sources', ''
      ];

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
       * Only Claude Code has a `--system-prompt` flag.
       *
       * `agy` offers `--agent <name>` (a named file in ~/.gemini/agents) and
       * `codex exec` takes instructions as the prompt argument — neither accepts
       * a persona inline. Passing nothing meant the persona was silently dropped
       * and the model answered as itself: an agent labelled "Ada Lovelace" in the
       * UI replied "I am Antigravity, built by Google DeepMind".
       *
       * So for those families the persona is prepended to the message instead —
       * but only on the FIRST message of a session. Once a session exists the
       * persona is already in its transcript, and repeating it every turn would
       * grow the context without adding anything.
       */
      const withPersona = (message: string) =>
        !priorSession && agent.systemPrompt?.trim()
          ? `${agent.systemPrompt.trim()}\n\n` +
            `Stay in character as ${agent.name} at all times. If asked who or what ` +
            `you are, answer as ${agent.name}, never as the underlying tool or model.\n\n` +
            `---\n\n${message}`
          : message;

      if (isCodex) {
        family = 'codex';
        bin = isWin ? 'codex.cmd' : 'codex';
        // Flags MUST precede the positional prompt: `codex exec [OPTIONS] [PROMPT]`.
        // With the prompt first, codex silently ignores everything after it and
        // reports "--skip-git-repo-check was not specified" even though it was.
        //
        // `--skip-git-repo-check` because codex refuses to start outside a git
        // repo, and a chat has no reason to require one.
        args = [
          'exec',
          '--json',
          '--sandbox', 'read-only',
          '--skip-git-repo-check',
          withPersona(prompt)
        ];
      } else if (isAntigravity) {
        // Antigravity ships as a desktop IDE, so `agy` is usually not on PATH;
        // resolve the install location. Its flags mirror Claude Code's but its
        // event schema does not — see StreamParser.handleAntigravityEvent.
        family = 'antigravity';
        bin = RuntimeService.agyPath();
        args = ['-p', withPersona(prompt), '--output-format', 'stream-json'];
        if (agent.modelName) args.push('--model', agent.modelName);
      }

      // Apply the resume flag for whichever family we settled on.
      if (priorSession) {
        if (family === 'claude') args.push('--resume', priorSession);
        else if (family === 'antigravity') args.push('--conversation', priorSession);
        // Codex resume is `codex exec resume <id>`, a different argv shape —
        // left out until there is a captured transcript to verify against.
      }

      // Same parser the run pipeline uses — tested against real captured
      // transcripts in streamParser.test.ts. The hand-rolled inline parser this
      // replaced matched on top-level `type: 'text' | 'tool_use'`, which never
      // occurs: those are content blocks nested inside an assistant message.
      const parser = new StreamParser(family);

      await new Promise<void>((resolve) => {
        const child = processManager.spawnProcess({
          runId,
          bin,
          args,
          cwd,
          onExit: () => resolve()
        });

        if (child.stdout) {
          createLineBuffer(child.stdout, (line) => {
            for (const ev of parser.parseLine(line)) {
              if (ev.type === 'log' && ev.message) {
                content += (content ? '\n' : '') + ev.message;
              } else if (ev.type === 'thinking' && ev.thinking) {
                thinking = ev.thinking;
              } else if (ev.type === 'error' && ev.message) {
                // The CLI's own error is far more useful than stderr's first
                // line, which is often an unrelated warning.
                streamError = ev.message;
              } else if (ev.type === 'tool_call' && ev.toolName) {
                tools.push({
                  id: `tool-${Date.now()}-${tools.length}`,
                  toolName: ev.toolName,
                  parameters: ev.toolInput ?? {},
                  status: 'success',
                  executedAt: new Date().toISOString()
                });
              }
            }
          });
        }

        if (child.stderr) {
          createLineBuffer(child.stderr, (line) => {
            stderr += line + '\n';
          });
        }
      });

      // Store the session so the next message in this thread continues it.
      // Claude mints a NEW id on every resume, so this must be re-saved each
      // turn rather than written once.
      const sessionId = parser.getSessionId();
      if (sessionId) {
        sqliteService.setThreadSession(threadId, agent.id, sessionId);
      }

      const unhandled = parser.getUnhandledTypes();
      if (unhandled.length) {
        logError('Chat stream had unhandled event types', unhandled.join(', '));
      }

      if (!content.trim()) {
        // Report the real reason instead of a reassuring placeholder. The old
        // fallback ("All systems and components are aligned") made a failed
        // spawn look like a successful answer, which is how this went unnoticed.
        // stderr's FIRST line is usually a warning, not the failure — codex
        // opens with "Reading additional input from stdin...". Prefer the CLI's
        // own structured error, then a stderr line that looks like one, then
        // the last line.
        const stderrLines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
        const detail =
          streamError ||
          stderrLines.find(l => /error|fail|not supported|denied/i.test(l)) ||
          stderrLines[stderrLines.length - 1] ||
          'the CLI produced no output';
        logError('Agent reply was empty', detail);
        content =
          `I could not reach the ${agent.modelProvider} CLI, so I have no answer for you.\n\n` +
          `Reason: ${detail}\n\n` +
          `Check that \`${bin.replace('.cmd', '')}\` is installed and signed in — the Runtimes page shows its status.`;
      }
    } catch (err: any) {
      logError('Failed to generate agent reply via CLI:', err);
      content =
        `I could not start the ${agent.modelProvider} CLI.\n\n` +
        `Reason: ${err?.message ?? String(err)}`;
    }

    return {
      content: content.trim(),
      thinking,
      tools
    };
  }
}

export const chatService = new ChatService();
