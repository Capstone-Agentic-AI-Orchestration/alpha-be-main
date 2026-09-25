import { processManager } from './processManager.js';
import { createLineBuffer } from '../utils/lineBuffer.js';
import { StreamParser, StreamFamily, ParsedEvent } from './streamParser.js';
import { TurnAccumulator, CliToolRecord } from './turnAccumulator.js';
import { parseCustomCliArgs } from './customCliArgs.js';
import { chatToolsFor } from './toolPolicy.js';
import { cliHomeEnv } from './cliHome.js';
import { agentCredentialEnv } from './gitCredentialIsolation.js';
import { RuntimeService } from './runtimeService.js';
import { cleanupRunMcpConfig, mcpToolPatterns, writeRunMcpConfig } from './mcpConfigService.js';
import { mcpAccessFor } from './autonomyPolicy.js';
import { AutonomyLevel, ReasoningEffort } from '../models/index.js';
import { EXECUTION_LIMITS } from '../config/constants.js';
import { RUNS_DIR } from '../config/env.js';
import fs from 'node:fs';
import path from 'node:path';
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
  /**
   * Path to a file holding the composed persona.
   *
   * Claude takes `--append-system-prompt-file`, which keeps a multi-line
   * persona out of argv entirely. Callers get one from `writeTurnPersona`.
   * Without it the persona falls back to the inline flag, which is correct
   * only when it happens to be single-line.
   */
  personaFile?: string;
  /** Agent `modelProvider` value — selects the CLI family. */
  provider: string;
  modelName?: string;
  /** Optional effort override; omitted means the model/runtime default. */
  reasoningEffort?: ReasoningEffort;
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
  /**
   * Values layered over the daemon's environment when resolving `${VAR}` in
   * those servers — the project's, then the agent's own.
   *
   * Separate from `env`, which is what the CLI process itself is given. A
   * project's `SUPABASE_PROJECT_REF` belongs in an MCP server's URL, not in
   * the agent's shell.
   */
  mcpEnv?: Record<string, string>;
  /**
   * Skills granted to this agent, from `agent.skills`.
   *
   * On a chat turn these ARE the capability: `chatToolsFor` turns them into the
   * allowed and denied lists, so an agent holding `sk-fs` may edit files and one
   * holding nothing may not. A run ignores them — see autonomyPolicy.
   */
  skills?: string[];
  /**
   * The agent's autonomy level, for what its MCP tools may do to a remote.
   *
   * Paired with `sk-git` on a chat turn: the skill says GitHub was granted, this
   * says whether the agent is trusted to write to it.
   */
  autonomyLevel?: AutonomyLevel;
  /** Receives only parsed operational events; callers decide what is safe to persist. */
  onEvent?: (event: ParsedEvent) => void;
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


/**
 * Write the composed persona to a file for this turn, and return its path.
 *
 * Claude takes `--append-system-prompt-file`, and using it is what keeps a
 * multi-line persona out of a command line that cmd.exe would truncate. Lives
 * beside the run's MCP config under `~/.alpha/runs/<runId>/`, so
 * `cleanupRunMcpConfig` removes it with the rest of the directory.
 *
 * Returns null when there is no persona, or when the write fails — the caller
 * then falls back to the inline flag rather than losing the turn.
 */
export function writeTurnPersona(runId: string, persona: string): string | null {
  const text = persona?.trim();
  if (!text) return null;

  try {
    const dir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'persona.md');
    fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch (err: any) {
    logError('Could not write the turn persona file', err?.message ?? String(err));
    return null;
  }
}

/** Resolved argv for one turn, plus which stream dialect to expect back. */
interface TurnInvocation {
  bin: string;
  args: string[];
  family: StreamFamily;
  /**
   * The prompt, to be written to the child's stdin rather than passed in argv.
   *
   * On Windows `claude` and `codex` are `.cmd` shims, so cross-spawn runs them
   * through cmd.exe — whose command line ends at the first newline. A
   * multi-line prompt in argv was therefore truncated, and every flag after it
   * silently discarded: `--output-format stream-json` (so the run parsed plain
   * text and logged nothing), `--setting-sources ''` (so the operator's own
   * CLAUDE.md leaked back in), and `--model`. Measured, then fixed here.
   *
   * `agy` is a real executable rather than a shim and is unaffected, so it
   * keeps its prompt in argv where its persona has been verified to apply.
   */
  stdin?: string;
  /**
   * Environment overrides for this family, merged over the caller's own.
   *
   * Carries the managed home that isolates a CLI from the operator's personal
   * configuration — see cliHome.
   */
  env: Record<string, string>;
}

/** Translate the stored effort into the flag syntax of the selected CLI. */
function reasoningArgs(provider: string, effort?: ReasoningEffort): string[] {
  if (!effort) return [];

  if (provider === 'OpenAI') {
    // Codex exposes reasoning through its config surface rather than --effort.
    // Quote the TOML string so values remain safe even when the field came from
    // an imported persona file.
    const supported: ReasoningEffort[] = [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ];
    return supported.includes(effort)
      ? ['--config', `model_reasoning_effort=${JSON.stringify(effort)}`]
      : [];
  }

  if (provider === 'Antigravity' || provider === 'Google Gemini') {
    return ['low', 'medium', 'high'].includes(effort) ? ['--effort', effort] : [];
  }

  if (provider === 'Anthropic') {
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
      ? ['--effort', effort]
      : [];
  }

  // Ollama, LM Studio, and OpenCode do not share a portable effort flag. Auto
  // is the honest choice for those runtimes.
  return [];
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
  const {
    provider,
    cwd,
    modelName,
    reasoningEffort,
    systemPrompt,
    personaName,
    prompt,
    priorSession
  } = options;
  const isRun = options.mode === 'run';

  /*
   * What this chat turn was granted, resolved from the agent's own skills.
   *
   * Computed for both modes because two provider branches below need to know
   * whether a turn can write at all, and a run always can. `canWrite` is the
   * question those branches actually ask — not "is this a run" as it used to be,
   * which is now the wrong question for a chat granted `sk-fs`.
   */
  const chatTools = chatToolsFor(options.skills);
  const canWrite = isRun || chatTools.allowed.some(t => t === 'Write' || t === 'Edit');
  const canRunShell = isRun || chatTools.allowed.includes('Bash');

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
      bin: RuntimeService.codexPath(),
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
        // A run edits the repository it was given; so does a chat whose agent
        // was granted `sk-fs`. Codex's non-interactive approval switch is a
        // special case: `--approve-for-me` selects its workspace-write policy,
        // and the CLI rejects it when `--sandbox` is present. Keep the explicit
        // sandbox for chats, where Alpha must preserve the agent's capability
        // boundary, and use the compatible approval mode for launched runs.
        ...(isRun
          ? ['--approve-for-me']
          : ['--sandbox', canWrite ? 'workspace-write' : 'read-only']),
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
        ...reasoningArgs(provider, reasoningEffort),
        // Before the terminator for the same reason --model is.
        ...customArgs,
      ],
      // `codex exec` with no positional prompt reads it from stdin, which keeps
      // the persona-prefixed text out of a command line cmd.exe would truncate.
      stdin: withPersona(prompt)
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
         * Run mode: give agy the workspace, and let it act in it.
         *
         * `--add-dir` — without it the working directory is outside agy's
         * workspace and its file writes land in its own scratch directory
         * instead (measured). For a chat that is a harmless accident; for a run
         * it is fatal, because the run reports success having changed nothing
         * in the repository it was given.
         *
         * The permission flag — agy has no granular equivalent to Claude's
         * `--permission-mode`. In headless mode any tool needing the "command"
         * permission cannot prompt and is auto-denied, so `run_command` fails
         * and the turn dies producing no output at all. Since step three of the
         * task prompt is "run existing tests", that ends most real runs, and
         * every run by Orion, whose entire role is testing. Measured both ways:
         * denied without it, `v22.18.0` with it.
         *
         * Its name overstates what it changes here. A Claude run already
         * permits arbitrary shell — `acceptEdits` with no `--disallowedTools`
         * runs `node -v` happily, also measured. So this is parity with the
         * agents that already have it rather than an escalation.
         *
         * Two things it does genuinely widen, worth knowing:
         *   - agy auto-approves ALL tool requests, and its toolset includes
         *     browser automation, which a Claude run does not get.
         *   - a branch and a diff undo file changes, not `npm install` or a
         *     network call. The review gate protects the repository, not the
         *     machine. Already true of Claude runs, but true here too.
         *
         * A settings-based allow-rule would be narrower, and agy's own error
         * message suggests one — but `permissions.allow` with `command(node -v)`
         * and with `command(*)` were both still denied, and no syntax is
         * documented. Revisit if agy ships a granular flag.
         *
         * ## Why chat now gets --add-dir too
         *
         * The two flags grant different things, and only one of them is about
         * writing. `--add-dir` says "this directory is my workspace" —
         * visibility. `--dangerously-skip-permissions` auto-approves tool
         * requests — capability. Chat needs the first and must never have the
         * second.
         *
         * Withholding both meant a chat turn could not read the directory it
         * was standing in. Once chat resolved a real project workspace instead
         * of the managed root, that stopped being theoretical: asking an agent
         * to review the repository returned "Antigravity run ended with status
         * CANCELED" in eight seconds, having read nothing. The same agent
         * answered a question about itself perfectly, so the CLI was healthy —
         * it simply had no workspace.
         *
         * Chat is read-only for an agent granted no skills: the allowed list is
         * Read, Glob and Grep, and the denied list names every mutating tool.
         * An agent granted `sk-fs` or `sk-bash` gets the flag here too, because
         * agy auto-denies in headless mode and would otherwise die producing
         * nothing rather than making the edit it was just told it could make.
         */
        '--add-dir', cwd,
        ...(canWrite || canRunShell ? ['--dangerously-skip-permissions'] : []),
        ...(modelName ? ['--model', modelName] : []),
        ...reasoningArgs(provider, reasoningEffort),
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
    bin: RuntimeService.claudePath(),
    // `-p` with no value reads the prompt from stdin, which is what keeps a
    // multi-line task description out of the command line.
    stdin: prompt,
    args: [
      '-p',
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
      /**
       * The file form when one was written, the inline form otherwise.
       *
       * A persona always contains newlines — every generated file opens
       * `# Name`, blank line, prose — so inline meant the value was cut at the
       * first newline and everything after it in argv was lost. See
       * TurnInvocation.stdin.
       */
      ...(options.personaFile
        ? ['--append-system-prompt-file', options.personaFile]
        : persona
          ? ['--append-system-prompt', persona]
          : []),
      '--output-format', 'stream-json',
      // Claude only emits content_block_delta events when this opt-in is set.
      // The parser already understands those fragments and folds them into one
      // activity, so the run can show the assistant while it is still writing.
      '--include-partial-messages',
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
        ? [
            '--permission-mode', 'acceptEdits',
            '--max-turns', String(EXECUTION_LIMITS.MAX_TURNS),
            /*
             * The same allowlist the chat branch needs, for the same reason,
             * and its absence here meant no agent had ever completed an MCP
             * call in a run — 'alpha' 4, 'agent' 0 in remote_actions.
             *
             * `acceptEdits` covers edits, not MCP tools: those still ask, and a
             * headless run has no one to ask. The call did not fail loudly,
             * either — the agent reported that it had drafted a review and
             * needed permission to post it, then the turn ended. Alpha's own
             * pipeline pushes and opens the pull request straight afterwards,
             * so from the outside the run looked like it had worked.
             */
            ...(mcp.serverNames.length
              ? ['--allowedTools', ...mcpToolPatterns(mcp.serverNames)]
              : [])
          ]
        : [
            /*
             * Built from the agent's skills rather than a fixed list. Both
             * halves matter: the allowed list is exhaustive, and the denied list
             * is what turns an ungranted tool into a clean refusal instead of a
             * prompt no headless process can answer. See toolPolicy.
             */
            '--allowedTools', ...chatTools.allowed, ...mcpToolPatterns(mcp.serverNames),
            '--disallowedTools', ...chatTools.denied
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
      ...reasoningArgs(provider, reasoningEffort),
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
       */
      ...(mcp.configPath ? ['--mcp-config', mcp.configPath] : []),
      /**
       * Unconditional, including when no config was written.
       *
       * The flag means "only use MCP servers from --mcp-config", so with no
       * config given it means none at all — which is exactly what an agent
       * granted no servers should get. It used to be attached only alongside
       * `--mcp-config`, which left the zero-server case, the one that needs the
       * fence most, as the only case without it.
       *
       * What that leaked is not the operator's config files. `--setting-sources
       * ''` already keeps `~/.claude.json` and settings out, and the CLI duly
       * reported `mcp_servers: []`. It is the *account-level* claude.ai
       * connectors, which travel with the credentials under `~/.claude` — and
       * those stay put on purpose, because relocating this family's home would
       * sign the user out (see cliHome).
       *
       * Measured, same argv but for this flag, asking Alpha "do you have mcp
       * right now":
       *   without — "several MCP-backed connectors are configured but sitting
       *     unauthorized: Apollo.io, Canva, Figma, Gmail, Google Calendar,
       *     Google Drive, Miro"
       *   with    — "No, no MCP servers are connected right now."
       *
       * Nothing was callable either way: the chat allowlist carries an
       * `mcp__<server>__*` pattern only for servers actually granted. But a
       * chat user learning which SaaS accounts the machine owner has connected
       * is a disclosure on its own, and Alpha is meant to be usable by people
       * who are not the machine owner.
       */
      '--strict-mcp-config',
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
  /*
   * Chat access, resolved per agent. This function serves chat and the agent
   * builder, never a run.
   *
   * It used to pass a flat `read` for everyone. The refusal has to happen inside
   * the server either way — the allow-list works on server names, so
   * `mcp__alpha-github` either grants every tool the server exposes or none —
   * which is why this is an argument to the config writer and not a flag.
   * mcpAccessFor now decides it from the agent's own `sk-git` and autonomy
   * level; an agent holding neither still gets exactly what it got before.
   */
  const mcp = writeRunMcpConfig(
    runId,
    options.mcpServers,
    options.mcpEnv,
    options.cwd,
    mcpAccessFor(options.autonomyLevel, options.mode === 'run' ? 'run' : 'chat', options.skills)
  );
  if (mcp.serverNames.length) {
    logInfo(`MCP servers for ${runId}: ${mcp.serverNames.join(', ')}`);
  }

  try {
    const invocation = buildTurnInvocation(
      { ...options, personaFile: writeTurnPersona(runId, options.systemPrompt ?? '') ?? undefined },
      mcp
    );
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
        /**
          * Agent env first, then the family's isolation overrides — a HOME
          * supplied by an agent's envVars must not defeat the isolation.
          * Merged over process.env by processManager. Not logged: an agent's
          * env is where its API keys live.
          *
          * Credential isolation goes last for the same reason. An agent whose
          * envVars set GH_TOKEN would otherwise hand itself back the access
          * this removes, and the point is that pushing goes through the tool
          * that can refuse a protected branch and record what it did.
          */
        env: { ...options.env, ...invocation.env, ...agentCredentialEnv() },
        stdin: invocation.stdin,
        onExit: () => resolve()
      });

      if (child.stdout) {
        createLineBuffer(child.stdout, (line) => {
          for (const ev of parser.parseLine(line)) {
            turn.accept(ev);
            if (options.onEvent && ['tool_call', 'tool_result', 'stage_transition', 'error', 'status'].includes(ev.type)) {
              try { options.onEvent(ev); } catch { /* activity reporting must never stop an agent turn */ }
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
