/**
 * `agent.customCliArgs` — extra flags, supplied as one string by whoever
 * configured the agent — turned into argv.
 *
 * The field has been in the schema and the UI since the beginning and was never
 * read, so it did nothing. Honouring it means user text becomes arguments to a
 * spawned process, which is worth doing carefully rather than by concatenation.
 *
 * ## What this is and is not protecting against
 *
 * Not shell injection: `processManager` spawns through cross-spawn with no
 * shell, so `;`, `&&` and backticks are literal characters in an argument and
 * cannot start a second command. That is already handled.
 *
 * What it protects is the turn's own guarantees. Every flag this runner sets
 * deliberately — the read-only tool policy, the MCP pruning, the isolation from
 * the operator's own Claude Code settings, the output format the parser depends
 * on — could be re-specified here and silently win, because argv parsers
 * generally take the last occurrence. `--dangerously-skip-permissions` in this
 * box would turn a read-only chat into an agent with write access, and nothing
 * would say so.
 *
 * So the rule is a denylist of what the runner owns, not an allowlist of what a
 * CLI accepts: the three CLIs have hundreds of flags between them, they change,
 * and most are harmless. Rejections are returned rather than dropped silently —
 * a flag that does nothing is exactly the kind of thing that goes unnoticed.
 */

import { logInfo } from '../utils/logger.js';

/**
 * Flags the runner owns. Matched on the flag name, so `--model=x` and
 * `--model x` are both caught.
 *
 * Grouped by why, because the reason is what tells a future reader whether a
 * new flag belongs here.
 */
const RESERVED_FLAGS = new Set([
  // Would widen what the turn can touch.
  '--allowedtools', '--allowed-tools',
  '--disallowedtools', '--disallowed-tools',
  '--dangerously-skip-permissions',
  '--permission-mode', '--permission-prompt-tool',
  '--add-dir',
  '--sandbox',
  // Codex owns the non-interactive run approval policy too. It cannot be
  // combined with --sandbox and must not be replaced by an agent-supplied flag.
  '--approve-for-me',
  '--agents',

  // Would undo the isolation from the operator's own configuration.
  '--setting-sources',
  '--settings',
  '--mcp-config', '--strict-mcp-config',
  '--plugin-dir',

  // Would replace or duplicate the composed persona.
  '--system-prompt', '--system-prompt-file',
  '--append-system-prompt', '--append-system-prompt-file',

  // The stream contract the parser depends on.
  '--output-format', '--input-format',
  '--include-partial-messages',
  '-p', '--print',

  // Session and model are decided from the agent record.
  '--model', '-m',
  '--effort', '--reasoning-effort',
  // Codex uses -c/--config for model and reasoning settings. Letting custom
  // config through could silently override the agent's selected effort or
  // sandbox policy.
  '--config', '-c',
  '--resume', '-r', '--continue',
  '--conversation',
  '--fork-session',

  // Positional-argument terminator: everything after it stops being flags.
  '--'
]);

export interface CustomArgsResult {
  /** Flags to append to the turn's argv. */
  args: string[];
  /** Flags that were refused, with the reason, for logging and the UI. */
  rejected: string[];
}

/**
 * Split a command-line string into tokens, honouring quotes.
 *
 * A hand-typed field will contain `--foo "some value"`, and splitting on
 * whitespace alone would turn that into two arguments.
 */
export function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);

  return tokens;
}

/** The flag name from a token, lowercased: `--model=x` -> `--model`. */
function flagName(token: string): string {
  return token.split('=')[0].toLowerCase();
}

export function parseCustomCliArgs(raw: string | undefined): CustomArgsResult {
  const args: string[] = [];
  const rejected: string[] = [];

  const tokens = tokenize(raw ?? '');

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // A control character in argv is never intentional and is the kind of thing
    // that makes a log unreadable or a downstream parser misbehave.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(token)) {
      rejected.push(`${JSON.stringify(token)} (control characters)`);
      continue;
    }

    if (!token.startsWith('-')) {
      // A bare word here would land as a positional argument — for `claude -p`
      // that is a second prompt, for `codex exec` it replaces the prompt.
      rejected.push(`${token} (positional arguments are not allowed)`);
      continue;
    }

    if (RESERVED_FLAGS.has(flagName(token))) {
      rejected.push(`${flagName(token)} (set by Alpha for this turn)`);
      // Skip its value too, when it is given as a separate token, so the value
      // does not survive as a stray positional.
      if (!token.includes('=') && tokens[i + 1] && !tokens[i + 1].startsWith('-')) i++;
      continue;
    }

    args.push(token);
    // Carry an inline value: `--foo bar` keeps `bar`, `--foo --bar` does not.
    if (!token.includes('=') && tokens[i + 1] && !tokens[i + 1].startsWith('-')) {
      args.push(tokens[++i]);
    }
  }

  return { args, rejected };
}

/**
 * `agent.envVars` as an environment for the spawned CLI.
 *
 * Keys are restricted to the POSIX-portable shape. A key with `=` or a null in
 * it does not survive the environment block on any platform, and one with
 * arbitrary punctuation is far more likely to be a typo than an intent.
 */
export function buildEnv(
  envVars: { key: string; value: string }[] | undefined
): { env: Record<string, string>; rejected: string[] } {
  const env: Record<string, string> = {};
  const rejected: string[] = [];

  for (const entry of envVars ?? []) {
    const key = String(entry?.key ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      // The key, never the value — the value is why this field is marked secret.
      rejected.push(`${key || '(blank)'} (not a valid environment variable name)`);
      continue;
    }
    env[key] = String(entry?.value ?? '');
  }

  return { env, rejected };
}

const reportedIgnoredProjects = new Set<string>();

/**
 * Project-level variables are no longer passed to agents: variables are set
 * per repository now, on its hosted environments, and each agent keeps its
 * own. A desktop that stored some before keeps them on disk untouched --
 * nothing is deleted -- and is told once per project that they no longer
 * apply, so a missing `${VAR}` in an MCP server is not a mystery.
 */
export function reportIgnoredProjectEnv(project: { id: string; key?: string; envVars?: { key: string }[] } | null | undefined): void {
  const stored = project?.envVars ?? [];
  if (!project || stored.length === 0 || reportedIgnoredProjects.has(project.id)) return;
  reportedIgnoredProjects.add(project.id);
  logInfo(
    `Project ${project.key ?? project.id} still stores ${stored.length} project variable(s) ` +
      `(${stored.map(v => v.key).join(', ')}); project variables are no longer passed to agents. ` +
      'Set them on the agent, or on the repository for its hosted environments.'
  );
}
