import { processManager } from './processManager.js';
import { createLineBuffer } from '../utils/lineBuffer.js';
import { StreamParser, StreamFamily } from './streamParser.js';
import { TurnAccumulator, CliToolRecord } from './turnAccumulator.js';
import { parseCustomCliArgs } from './customCliArgs.js';
import { CHAT_ALLOWED_TOOLS, CHAT_DISALLOWED_TOOLS } from './toolPolicy.js';
import { cliHomeEnv } from './cliHome.js';
import { RuntimeService } from './runtimeService.js';
import { cleanupRunMcpConfig, mcpToolPatterns, writeRunMcpConfig } from './mcpConfigService.js';
import { EXECUTION_LIMITS } from '../config/constants.js';
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

export type { CliToolRecord } from './turnAccumulator.js';

/**
 * What a turn is for, which decides what it is allowed to do.
 *
 * `chat` is a conversation: read-only, because it has no branch, no diff and no
 * approval gate. `run` is Alpha doing the work on an issue — it has all three,
 * and editing the repository is the point.
 *
 * One builder for both so the provider-specific argv rules exist once. They
 * previously existed twice: runnerService predates this module and was never
 * migrated, so every fix here — the persona flag, --model, the isolation from
 * the operator's own CLI configuration — reached chat and not runs.
 */
export type TurnMode = 'chat' | 'run';

export interface CliTurnOptions {
  runId: string;
  cwd: string;
  /** Defaults to 'chat', so existing callers keep today's read-only behaviour. */
  mode?: TurnMode;
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
   * The persona changed since this session started.
   *
   * Only meaningful with `priorSession`. Claude Code receives the persona on
   * every turn via `--append-system-prompt`, so it picks up edits by itself;
   * `codex` and `agy` take it prepended to the first message only, which left
   * an edit invisible to any conversation already underway. When this is set
   * those families are told, in the next message, that their instructions
   * changed.
   */
  personaChanged?: boolean;
  /**
   * Environment for the spawned CLI, from `agent.envVars`.
   *
   * Merged over `process.env` by processManager. Never logged — an agent's env
   * is where its API keys live.
   */
  env?: Record<string, string>;
  /**
   * Extra CLI flags from `agent.customCliArgs`.
   *
   * Parsed and filtered — see `parseCustomCliArgs`. Anything that would widen
   * what the turn can reach is dropped rather than honoured.
   */
  customCliArgs?: string;
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
  /**
   * Environment overrides for this family, merged over the caller's own.
   *
   * Carries the managed home that isolates a CLI from the operator's personal
   * configuration — see cliHome.
   */
  env: Record<string, string>;
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
  const { provider, cwd, modelName, systemPrompt, personaName, prompt, priorSession } = options;
  const isRun = options.mode === 'run';

  /**
   * The agent's own extra flags, minus anything the runner owns.
   *
   * Rejections are logged rather than dropped quietly: a flag someone typed
   * that silently does nothing is the failure mode this whole field had before
   * it was read at all.
   */
  const custom = parseCustomCliArgs(options.customCliArgs);
  if (custom.rejected.length) {
    logError('Ignored custom CLI arguments', custom.rejected.join('; '));
  }
  const customArgs = custom.args;

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
    if (!persona) return message;
    // Already in the transcript and unchanged — repeating it every turn would
    // grow the context without adding anything.
    if (priorSession && !options.personaChanged) return message;

    const stayInCharacter = personaName
      ? `Stay in character as ${personaName} at all times. If asked who or what ` +
        `you are, answer as ${personaName}, never as the underlying tool or model.\n\n`
      : '';

    /**
     * Mid-session re-injection is worded as a correction, not an introduction.
     *
     * Dropping the persona in again unannounced reads, in a transcript that
     * already contains one, as a duplicate rather than a replacement — and the
     * model has no way to know which of the two now governs. Saying so
     * explicitly is what makes an edit to a persona file take effect on a
     * conversation that is already running.
     */
    const preamble =
      priorSession && options.personaChanged
        ? 'Your instructions have been updated. Everything below replaces any ' +
          'earlier instructions in this conversation; follow it from now on.\n\n'
        : '';

    return `${preamble}${persona}\n\n${stayInCharacter}---\n\n${message}`;
  };

  if (isCodex) {
    return {
      family: 'codex',
      // Left on the real home: codex keeps auth.json under ~/.codex, so
      // relocating it would sign the user out. See cliHome.
      env: {},
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
        // A run edits the repository it was given; a chat only inspects it.
        '--sandbox', isRun ? 'workspace-write' : 'read-only',
        '--skip-git-repo-check',
        /**
         * Isolate codex from ~/.codex/config.toml — the operator's own file.
         *
         * This is codex's equivalent of --setting-sources for claude, and
         * without it an Alpha agent inherited everything configured there.
         * On this machine that meant a `node_repl` MCP server (arbitrary
         * JavaScript, plus browser control), a `supabase` MCP server pointing
         * at a live project, eighteen paths marked trust_level = "trusted",
         * a shell_environment_policy, and a different default model and
         * reasoning effort — none of it granted by Alpha.
         *
         * Credentials are unaffected: they live in ~/.codex/auth.json, not in
         * config.toml, and codex still reads and attempts to refresh the token
         * with this flag set.
         */
        '--ignore-user-config',
        // Before the `--`, necessarily: after it, `--model` would be read as
        // part of the prompt text rather than as a flag.
        ...(modelName ? ['--model', modelName] : []),
        // Before the terminator for the same reason --model is.
        ...customArgs,
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
      // Isolates agy from ~/.gemini — the operator's own GEMINI.md, agents,
      // rules, skills and memory were all being loaded into every Alpha turn.
      env: cliHomeEnv('antigravity'),
      args: [
        '-p', withPersona(prompt),
        '--output-format', 'stream-json',
        // A chat message that happens to start with '/' is a message, not a
        // command. Without this agy expands it as a slash command or skill.
        '--disable-slash-commands',
        /**
         * Without --add-dir the working directory is outside agy's workspace,
         * and its file writes land in its own scratch directory instead —
         * measured. For a chat that is a harmless accident; for a run it would
         * be fatal, because the run would report success having changed
         * nothing in the repository it was given.
         */
        ...(isRun ? ['--add-dir', cwd] : []),
        ...(modelName ? ['--model', modelName] : []),
        ...(priorSession ? ['--conversation', priorSession] : []),
        ...customArgs
      ]
    };
  }

  return {
    family: 'claude',
    // Already isolated by --setting-sources below, and its credentials live
    // under ~/.claude, so the home must stay real.
    env: {},
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
      /**
       * A chat inspects; a run edits.
       *
       * Chat denies the write tools outright — safer than bypassPermissions and,
       * unlike leaving them to prompt, cannot hang a headless process waiting on
       * a TTY that isn't there. MCP tools are namespaced `mcp__<server>__<tool>`
       * and the allowlist is exhaustive, so without the patterns appended here
       * the servers would connect and every call against them be denied.
       *
       * A run instead takes `acceptEdits`, which applies the edits it decides on
       * without prompting. Verified to still work alongside `--setting-sources
       * ''` below: the isolation removes the operator's settings, not the
       * permission mode given on the command line.
       */
      ...(isRun
        ? ['--permission-mode', 'acceptEdits', '--max-turns', String(EXECUTION_LIMITS.MAX_TURNS)]
        : [
            '--allowedTools', ...CHAT_ALLOWED_TOOLS, ...mcpToolPatterns(mcp.serverNames),
            '--disallowedTools', ...CHAT_DISALLOWED_TOOLS
          ]),
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
       * Claude Code only. Neither `agy` nor `codex exec` accepts an MCP config
       * on the command line, so an agent on those families gets no MCP servers
       * at all — `agent.mcpServers` does nothing for them yet.
       *
       * That is now the truth rather than an understatement. Until
       * --ignore-user-config was passed, codex did not get "no servers": it got
       * every server the operator had configured in ~/.codex/config.toml.
       *
       * `--strict-mcp-config` makes the pruning real: without it the CLI merges
       * its own configured servers in, and an agent granted one server would
       * still see every server the operator has installed.
       */
      ...(mcp.configPath ? ['--mcp-config', mcp.configPath, '--strict-mcp-config'] : []),
      ...(priorSession ? ['--resume', priorSession] : []),
      // Last, so the agent's own flags are visible in argv order — but they
      // cannot override anything above: parseCustomCliArgs drops every flag
      // this runner sets. See customCliArgs for why that is a denylist.
      ...customArgs
    ]
  };
}

export async function runCliTurn(options: CliTurnOptions): Promise<CliTurnResult> {
  const { runId, cwd, provider, modelName } = options;

  // Owns the "what is the answer, what is narration" rule — see TurnAccumulator.
  const turn = new TurnAccumulator();
  const idleThinking = `Analyzing question using ${provider} (${modelName ?? 'default model'})...`;

  let stderr = '';

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
        // Agent env first, then the family's isolation overrides — a HOME
        // supplied by an agent's envVars must not defeat the isolation.
        // Merged over process.env by processManager. Not logged: an agent's
        // env is where its API keys live.
        env: { ...options.env, ...invocation.env },
        onExit: () => resolve()
      });

      if (child.stdout) {
        createLineBuffer(child.stdout, (line) => {
          for (const ev of parser.parseLine(line)) turn.accept(ev);
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

    const content = turn.getContent();
    const thinking = turn.getThinking(idleThinking);

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
        turn.getStreamError() ||
        stderrLines.find(l => /error|fail|not supported|denied/i.test(l)) ||
        stderrLines.at(-1) ||
        'the CLI produced no output';
      logError('CLI turn produced no content', detail);
      return {
        content: '',
        thinking,
        tools: turn.getTools(),
        sessionId: parser.getSessionId() ?? null,
        bin,
        failureDetail: detail,
        failureKind: 'empty'
      };
    }

    return {
      content: content.trim(),
      thinking,
      tools: turn.getTools(),
      sessionId: parser.getSessionId() ?? null,
      bin,
      failureDetail: null,
      failureKind: null
    };
  } catch (err: any) {
    logError('Failed to start CLI turn:', err);
    return {
      content: '',
      thinking: turn.getThinking(idleThinking),
      tools: turn.getTools(),
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
