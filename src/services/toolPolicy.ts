/**
 * What an agent may actually do during a chat turn.
 *
 * One definition, used twice: to build the CLI's `--allowedTools` /
 * `--disallowedTools` argv, and to tell the agent in its own system prompt what
 * it can and cannot reach.
 *
 * ## Why the prompt has to say it
 *
 * The seeded personas promise things the runner denies. Kaelen is told to
 * "write robust, concise, bug-free TypeScript code" and granted `sk-fs` and
 * `sk-bash`; Orion is told to "write thorough unit and regression tests". Both
 * then run with Write, Edit and Bash denied, so they narrate edits they cannot
 * make and offer to run tests they cannot run. The reply reads as either a lie
 * or a failure depending on how charitable the reader is.
 *
 * Stating the constraint costs a few dozen tokens and removes the contradiction
 * without widening what a chat turn can touch — which is the part that would
 * need a real security decision, not a prompt change. A chat has no branch, no
 * diff and no approval gate, so read-only is the right default for it; relaxing
 * it belongs on the run path, where those things exist.
 *
 * Deriving the sentence from the same arrays that build the argv is the point.
 * A hand-written sentence would be wrong the first time anyone edited the flags.
 */

/** One entry in the Alpha roster, as the prompt needs it. */
export interface RosterEntry {
  id: string;
  name: string;
  role: string;
}

/**
 * Who else exists in Alpha, and a instruction not to answer with anyone else.
 *
 * Isolating the CLI from the operator's configuration (see cliHome) stops an
 * agent reciting the machine owner's personal roster, but it leaves a second
 * gap: the agent then knows about no agents at all, so it answers with whatever
 * its underlying CLI happens to define — `research` and `self` for agy. Those
 * are the tool's internals. To the person chatting they are noise, and
 * presented as "the agents in the system" they are simply wrong.
 *
 * The roster is the honest answer, and it has to be supplied because nothing
 * else in the prompt contains it.
 */
export function describeRoster(roster: RosterEntry[], selfId: string): string {
  if (!roster.length) return '';

  const lines = roster.map(a => {
    const label = a.id === selfId ? ' (you)' : '';
    return `- ${a.name} — ${a.role}${label}`;
  });

  return [
    '## Your team',
    '',
    'You are one of the agents configured in Alpha. These are all of them:',
    '',
    ...lines,
    '',
    'If you are asked what agents or subagents exist, answer with this list.',
    'Never report the underlying CLI\'s own agents, subagent types, skills, or',
    'configuration files — they are not part of Alpha, and the person you are',
    'talking to has no reason to know they exist.'
  ].join('\n');
}

/** One squad, as Alpha needs to describe it. */
export interface SquadEntry {
  name: string;
  topology: string;
  memberNames: string[];
}

/**
 * What exists in this workspace, for Alpha answering on its own behalf.
 *
 * `describeRoster` says "you are one of these agents", which is true for an
 * agent and wrong for Alpha — it is the application, not a member of the team.
 * More importantly, Alpha had no roster at all: asked which agents or squads
 * existed it fell back to its CLI's own tools, ran `ListAgents`, and answered
 * about Claude Code sessions. Truthfully, and about the wrong system.
 *
 * Agents and squads live in `~/.alpha/alpha.db`, and a chat turn may only Read,
 * Glob and Grep a workspace directory. There is no file to find, so the answer
 * has to be supplied here or it cannot be known.
 */
export function describeAlphaWorkspace(agents: RosterEntry[], squads: SquadEntry[]): string {
  if (!agents.length && !squads.length) return '';

  const parts: string[] = ['## This workspace', ''];

  if (agents.length) {
    parts.push('Agents configured in Alpha:', '');
    for (const a of agents) parts.push(`- ${a.name} — ${a.role}`);
    parts.push('');
  }

  if (squads.length) {
    parts.push('Squads:', '');
    for (const sq of squads) {
      const members = sq.memberNames.length ? sq.memberNames.join(', ') : 'no members';
      parts.push(`- ${sq.name} (${sq.topology}) — ${members}`);
    }
    parts.push('');
  }

  parts.push(
    'Answer questions about agents and squads from this list. Never report the',
    "underlying CLI's own agents, sessions, subagent types or configuration —",
    'they belong to the tool Alpha runs on, not to Alpha, and the person you are',
    'talking to has no reason to know they exist.'
  );

  return parts.join('\n');
}

/** Tools a chat turn may use. Inspection only. */
export const CHAT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * Tools a chat turn may not use.
 *
 * Denied outright rather than left to prompt: `bypassPermissions` is worse, and
 * leaving them to ask would hang a headless process on a TTY that is not there.
 *
 * ## Enforcement is not uniform, and the wording below reflects that
 *
 * Only Claude Code takes these as flags. Measured against the other two:
 *
 * - `codex exec --sandbox read-only` enforces it.
 * - `agy` has NO tool-permission flags. `--sandbox` does not stop a file write;
 *   `--mode plan` is ignored outright alongside `--disable-slash-commands`
 *   ("--mode plan has no effect while slash command expansion is disabled") and
 *   did not block a write when tested without it either. Its shell tool IS
 *   auto-denied, because headless mode cannot prompt for the permission it
 *   needs — but `write_to_file` is not.
 *
 * What keeps Antigravity turns harmless today is that Alpha passes no
 * `--add-dir`, so the cwd is outside agy's workspace and its writes land in its
 * own scratch directory under the managed home. That is agy's behaviour, not a
 * guarantee Alpha makes.
 *
 * Hence the text says "do not" and "nothing you write reaches the project"
 * rather than claiming an attempt fails. An earlier version asserted that
 * writes "fail rather than asking permission", which is true for Claude and
 * codex and false for agy — and a prompt that lies about its own constraints
 * teaches the model to disbelieve them.
 */
export const CHAT_DISALLOWED_TOOLS = ['Write', 'Edit', 'Bash'] as const;

/**
 * The constraint, worded for the model.
 *
 * Written as capability plus instruction rather than a bare prohibition: a model
 * told only what it cannot do still tends to narrate doing it. Telling it what
 * to do instead — propose, quote paths, hand over commands — gives the reply
 * somewhere to go.
 */
export function describeChatToolPolicy(mcpServers: string[] = []): string {
  const mcp = mcpServers.length
    ? ` You also have the MCP servers: ${mcpServers.join(', ')}.`
    : '';

  // One sentence per line, never wrapped mid-sentence: a hard break inside a
  // clause is one more thing for the model to resolve, and it makes the text
  // awkward to assert on or grep for later.
  return [
    '## Tool access for this conversation',
    '',
    `You can inspect the workspace with ${CHAT_ALLOWED_TOOLS.join(', ')}.${mcp}`,
    '',
    `Do not ${CHAT_DISALLOWED_TOOLS.join(', ')}. This conversation is for inspection and advice only: nothing you write here reaches the project being discussed, and shell commands are blocked.`,
    '',
    'So: propose changes as code blocks, and name the exact file path each one belongs to.',
    'Hand over any command you would have run, for the user to execute.',
    'Do not claim to have created, edited, or run anything.'
  ].join('\n');
}
