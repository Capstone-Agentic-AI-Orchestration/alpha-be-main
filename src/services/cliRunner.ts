import { processManager } from './processManager.js';
import { createLineBuffer } from '../utils/lineBuffer.js';
import { StreamParser, StreamFamily } from './streamParser.js';
import { RuntimeService } from './runtimeService.js';
import { cleanupRunMcpConfig, mcpToolPatterns, writeRunMcpConfig } from './mcpConfigService.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * One turn against whichever agent CLI a provider maps to.
 *
 * This was the body of `ChatService.generateAgentReply`. It moved out when the
 * agent builder needed the same thing — a persona, a prompt, a resumable
 * session — and the alternative was a second copy of the provider-specific
 * argv rules below, which are the part most likely to drift.
 *
 * The caller owns the session store and decides what a failure means: chat
 * turns one into a message in the thread, the builder into an error response.
 */

export interface CliToolRecord {
  id: string;
  toolName: string;
  parameters: Record<string, unknown>;
  status: 'success';
  executedAt: string;
}

export interface CliTurnOptions {
  runId: string;
  cwd: string;
  /** Agent `modelProvider` value — selects the CLI family. */
  provider: string;
  modelName?: string;
  systemPrompt?: string;
  /** Name the persona should answer to on families without `--system-prompt`. */
  personaName?: string;
  prompt: string;
  /** CLI session id to continue, or null to start a new one. */
  priorSession: string | null;
  /**
   * MCP server names this agent is granted, from `agent.mcpServers`.
   *
   * Resolved against the built-ins and the user catalog, then written to a
   * per-run config. An agent granted nothing gets no `--mcp-config` at all,
   * which is not the same as getting an empty one.
   */
  mcpServers?: string[];
}

export interface CliTurnResult {
  content: string;
  thinking: string;
  tools: CliToolRecord[];
  /** Save this against the conversation — Claude mints a new id on every resume. */
  sessionId: string | null;
  /** The executable that was invoked, for error messages. */
  bin: string;
  /** Why nothing usable came back, or null on success. */
  failureDetail: string | null;
  /**
   * `spawn` — the process never started. `empty` — it ran but produced no
   * content. Callers word these differently: one is "could not start", the
   * other "could not reach", and the second is worth a "is it signed in?".
   */
  failureKind: 'spawn' | 'empty' | null;
}

/** Resolved argv for one turn, plus which stream dialect to expect back. */
interface TurnInvocation {
  bin: string;
  args: string[];
  family: StreamFamily;
}

/**
 * Build the argv for one turn.
 *
 * Separate from `runCliTurn` because the provider-specific rules below are the
 * part most likely to need changing, and they are far easier to read — and to
 * test — without a spawn and a stream loop wrapped around them. Exported for
 * exactly that: cliRunner.test.ts asserts on the flags rather than on a
 * subprocess, which is the only way to catch a regression like
 * `--system-prompt` in place of `--append-system-prompt` without a live CLI.
 */
export function buildTurnInvocation(
  options: CliTurnOptions,
  mcp: ReturnType<typeof writeRunMcpConfig>
): TurnInvocation {
  const { provider, modelName, systemPrompt, personaName, prompt, priorSession } = options;

  const isWin = process.platform === 'win32';
  const isCodex = provider === 'OpenAI';
  const isAntigravity = provider === 'Antigravity' || provider === 'Google Gemini';

  /**
   * The persona, already composed by personaService — agent file body plus
   * whichever memory tiers applied.
   */
  const persona = systemPrompt?.trim() ?? '';

  /**
   * Only Claude Code takes a persona as a flag.
   *
   * `agy` offers `--agent <name>` (a named file in ~/.gemini/agents) and
   * `codex exec` takes instructions as the prompt argument — neither accepts a
   * persona inline. Passing nothing meant the persona was silently dropped and
   * the model answered as itself: an agent labelled "Ada Lovelace" in the UI
   * replied "I am Antigravity, built by Google DeepMind".
   *
   * So for those families the persona is prepended to the message instead — but
   * only on the FIRST message of a session. Once a session exists the persona is
   * already in its transcript, and repeating it every turn would grow the
   * context without adding anything.
   */
  const withPersona = (message: string) => {
    if (priorSession || !persona) return message;

    const stayInCharacter = personaName
      ? `Stay in character as ${personaName} at all times. If asked who or what ` +
        `you are, answer as ${personaName}, never as the underlying tool or model.\n\n`
      : '';

    return `${persona}\n\n${stayInCharacter}---\n\n${message}`;
  };

  if (isCodex) {
    return {
      family: 'codex',
      bin: isWin ? 'codex.cmd' : 'codex',
      // Flags MUST precede the positional prompt: `codex exec [OPTIONS] [PROMPT]`.
      // With the prompt first, codex silently ignores everything after it and
      // reports "--skip-git-repo-check was not specified" even though it was.
      //
      // `--skip-git-repo-check` because codex refuses to start outside a git
      // repo, and a chat has no reason to require one.
      //
      // Codex resume is `codex exec resume <id>`, a different argv shape — left
      // out until there is a captured transcript to verify against.
      args: [
        'exec',
        '--json',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        // Before the `--`, necessarily: after it, `--model` would be read as
        // part of the prompt text rather than as a flag.
        ...(modelName ? ['--model', modelName] : []),
        // -- ends option parsing: a prompt that happens to start with a
        // hyphen is then read as text, not as a codex flag.
        '--',
        withPersona(prompt)
      ]
    };
  }

  if (isAntigravity) {
    // Antigravity ships as a desktop IDE, so `agy` is usually not on PATH;
    // resolve the install location. Its flags mirror Claude Code's but its
    // event schema does not — see StreamParser.handleAntigravityEvent.
    return {
      family: 'antigravity',
      bin: RuntimeService.agyPath(),
      args: [
        '-p', withPersona(prompt),
        '--output-format', 'stream-json',
        ...(modelName ? ['--model', modelName] : []),
        ...(priorSession ? ['--conversation', priorSession] : [])
      ]
    };
  }

  return {
    family: 'claude',
    bin: isWin ? 'claude.cmd' : 'claude',
    args: [
      '-p', prompt,
      /**
       * `--append-system-prompt`, NOT `--system-prompt`.
       *
       * `--system-prompt` REPLACES Claude Code's default system prompt outright.
       * Passing a one-line persona there left the model with that single line as
       * its entire instruction — no tool-use guidance, no output conventions,
       * nothing — which is why replies read as generic and unfocused. The CLI's
       * own help is explicit about the pair:
       *
       *   --system-prompt          System prompt to use for the session
       *   --append-system-prompt   Append a system prompt to the default
       *
       * and `--exclude-dynamic-system-prompt-sections` documents the same thing
       * from the other side: "Only applies with the default system prompt
       * (ignored with --system-prompt)."
       *
       * Omitted entirely when there is no persona. The old code passed
       * `systemPrompt ?? ''`, so an agent with no prompt got an EMPTY system
       * prompt — strictly worse than not passing the flag at all.
       */
      ...(persona ? ['--append-system-prompt', persona] : []),
      '--output-format', 'stream-json',
      // REQUIRED. Without it the CLI exits 1 with
      // "When using --print, --output-format=stream-json requires --verbose",
      // stdout stays empty, and this method silently returns a canned string.
      '--verbose',
      // These turns inspect, they do not mutate. Denying the write tools
      // outright is safer than bypassPermissions and — unlike leaving them to
      // prompt — cannot hang a headless process waiting on a TTY that isn't there.
      //
      // MCP tools are namespaced `mcp__<server>__<tool>`, and this allowlist is
      // exhaustive: without the patterns appended here the servers would
      // connect and then every call against them would be denied.
      '--allowedTools', 'Read', 'Glob', 'Grep', ...mcpToolPatterns(mcp.serverNames),
      '--disallowedTools', 'Write', 'Edit', 'Bash',
      // Isolate the agent persona from the operator's personal Claude Code
      // configuration. Without this the host's ~/.claude/CLAUDE.md is loaded
      // into every reply — output-style directives and all — so Ada answered
      // in the machine owner's preferred format instead of her own.
      '--setting-sources', '',
      // Honour the agent's configured model. `--model` previously appeared only
      // in the Antigravity branch, so an agent whose card read `claude-sonnet-5`
      // ran on whatever the machine's default was — the picker was decorative.
      ...(modelName ? ['--model', modelName] : []),
      /**
       * Attach the run's MCP servers.
       *
       * Claude Code only. `agy` and `codex exec` take MCP configuration from
       * their own settings files rather than argv, so pointing them at this
       * per-run file is not possible — granting an agent a server therefore has
       * no effect on those families yet, and silently pretending otherwise would
       * be worse than the gap.
       *
       * `--strict-mcp-config` makes the pruning real: without it the CLI merges
       * its own configured servers in, and an agent granted one server would
       * still see every server the operator has installed.
       */
      ...(mcp.configPath ? ['--mcp-config', mcp.configPath, '--strict-mcp-config'] : []),
      ...(priorSession ? ['--resume', priorSession] : [])
    ]
  };
}

export async function runCliTurn(options: CliTurnOptions): Promise<CliTurnResult> {
  const { runId, cwd, provider, modelName } = options;

  const tools: CliToolRecord[] = [];
  let content = '';
  let thinking = `Analyzing question using ${provider} (${modelName ?? 'default model'})...`;

  let stderr = '';
  let streamError = '';

  // Defaults so the catch block can still report something useful if argv
  // construction itself fails — RuntimeService.agyPath() throws when the
  // Antigravity install cannot be located.
  let family: StreamFamily = 'claude';
  let bin = process.platform === 'win32' ? 'claude.cmd' : 'claude';

  // Resolve the agent's granted MCP servers into a config for this run only.
  const mcp = writeRunMcpConfig(runId, options.mcpServers);
  if (mcp.serverNames.length) {
    logInfo(`MCP servers for ${runId}: ${mcp.serverNames.join(', ')}`);
  }

  try {
    const invocation = buildTurnInvocation(options, mcp);
    family = invocation.family;
    bin = invocation.bin;
    const args = invocation.args;

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

    const unhandled = parser.getUnhandledTypes();
    if (unhandled.length) {
      logError('CLI stream had unhandled event types', unhandled.join(', '));
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
        stderrLines.at(-1) ||
        'the CLI produced no output';
      logError('CLI turn produced no content', detail);
      return {
        content: '',
        thinking,
        tools,
        sessionId: parser.getSessionId() ?? null,
        bin,
        failureDetail: detail,
        failureKind: 'empty'
      };
    }

    return {
      content: content.trim(),
      thinking,
      tools,
      sessionId: parser.getSessionId() ?? null,
      bin,
      failureDetail: null,
      failureKind: null
    };
  } catch (err: any) {
    logError('Failed to start CLI turn:', err);
    return {
      content: '',
      thinking,
      tools,
      sessionId: null,
      bin,
      failureDetail: err?.message ?? String(err),
      failureKind: 'spawn'
    };
  } finally {
    // The config exists only for the duration of the spawn. Leaving it would
    // accumulate a directory per turn under ~/.alpha/runs.
    cleanupRunMcpConfig(runId);
  }
}
