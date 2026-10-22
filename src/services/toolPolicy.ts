/**
 * What an agent may actually do during a chat turn.
 *
 * One definition, used twice: to build the CLI's `--allowedTools` /
 * `--disallowedTools` argv, and to tell the agent in its own system prompt what
 * it can and cannot reach.
 *
 * ## Skills are the grant, and used to be decoration
 *
 * `agent.skills` — `sk-fs`, `sk-bash`, `sk-git` and friends — was seeded onto
 * every agent, rendered on every agent card, and read by nothing. Chat ran on
 * one fixed allowlist regardless, so Kaelen, told to "write robust, concise,
 * bug-free TypeScript code" and granted `sk-fs` and `sk-bash`, ran with Write,
 * Edit and Bash denied. He narrated edits he could not make and offered to run
 * tests he could not run; the reply read as either a lie or a failure depending
 * on how charitable the reader was.
 *
 * The card was not wrong about the intent, only about the effect. So the grant
 * now does what the card always claimed: SKILL_TOOLS maps each skill to the
 * tools it hands over, and `chatToolsFor` turns an agent's list into the argv.
 * An agent granted no skills is still inspection-only — the previous behaviour,
 * now the floor rather than the ceiling.
 *
 * ## What that widens, stated plainly
 *
 * A chat turn has no branch, no diff and no approval gate. An edit made here
 * lands in the working tree with nothing to review it against and nothing in
 * Alpha to undo it — unlike a run, which produces a branch and stops at
 * `awaiting_approval`. That is a real safety rail removed, and it is the point
 * of the change rather than a side effect of it: agents are meant to be able to
 * touch files while being talked to.
 *
 * The rail that stays is the grant itself. Capability is per agent and visible
 * on the agent card, so widening it is a deliberate act with a name attached
 * rather than a global switch.
 *
 * ## Why the prompt still has to say it
 *
 * Deriving the sentence from the same map that builds the argv is the point. A
 * hand-written sentence would be wrong the first time anyone edited the flags —
 * and it was: an earlier version of this file told every agent it was read-only,
 * which is now true only of the ones granted nothing.
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

/**
 * What exists in this workspace, for Alpha answering on its own behalf.
 *
 * `describeRoster` says "you are one of these agents", which is true for an
 * agent and wrong for Alpha — it is the application, not a member of the team.
 * More importantly, Alpha had no roster at all: asked which agents
 * existed it fell back to its CLI's own tools, ran `ListAgents`, and answered
 * about Claude Code sessions. Truthfully, and about the wrong system.
 *
 * Agents live in `~/.alpha/alpha.db`, and a chat turn may only Read,
 * Glob and Grep a workspace directory. There is no file to find, so the answer
 * has to be supplied here or it cannot be known.
 */
export function describeAlphaWorkspace(agents: RosterEntry[]): string {
  if (!agents.length) return '';

  const parts: string[] = ['## This workspace', ''];

  if (agents.length) {
    parts.push('Agents configured in Alpha:', '');
    for (const a of agents) parts.push(`- ${a.name} — ${a.role}`);
    parts.push('');
  }

  parts.push(
    'For a build, the Orchestrator assigns these agents to tasks by role. Alpha has',
    'no squads or fixed teams.',
    'Answer questions about agents from this list. Never report the',
    "underlying CLI's own agents, sessions, subagent types or configuration —",
    'they belong to the tool Alpha runs on, not to Alpha, and the person you are',
    'talking to has no reason to know they exist.'
  );

  return parts.join('\n');
}

/**
 * Tools every chat turn has, whatever it was granted.
 *
 * Inspection costs nothing to undo, and an agent that cannot read the workspace
 * cannot say anything useful about it. Never denied, and never named in
 * SKILL_TOOLS — a skill grants something *in addition* to these.
 */
export const CHAT_BASE_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * What each catalog skill actually hands over.
 *
 * Keyed by the seeded skill ids in sqliteService. A skill absent from this map
 * grants no CLI tool — `sk-git` is the deliberate case: what it grants is write
 * access to the GitHub MCP server, which is not a CLI tool and is resolved by
 * `mcpAccessFor` in autonomyPolicy instead.
 *
 * `sk-code-exec` maps to Bash rather than to a sandbox of its own. Alpha has no
 * separate execution sandbox to give it, and a card promising "run isolated
 * scripts" while granting nothing is the exact failure this map exists to end.
 * If a real sandbox ever ships, this is the line that changes.
 */
export const SKILL_TOOLS: Record<string, readonly string[]> = {
  'sk-fs': ['Write', 'Edit'],
  'sk-bash': ['Bash'],
  'sk-code-exec': ['Bash'],
  'sk-browser': ['WebFetch', 'WebSearch']
};

/**
 * Every tool any skill could grant.
 *
 * The denied list is this minus what was granted, computed rather than written
 * down — the two lists cannot drift apart if only one of them is authored.
 *
 * Naming them at all is what makes the refusal clean. `--allowedTools` is
 * already exhaustive in Claude Code, so an ungranted tool is refused either
 * way — but refused by *prompting*, and a headless process has no TTY to
 * prompt on, so the turn hangs rather than failing.
 *
 * NotebookEdit is here despite no skill granting it: it mutates a file, and the
 * point of the list is that every mutating tool is accounted for.
 */
export const GRANTABLE_TOOLS: readonly string[] = [
  ...new Set([...Object.values(SKILL_TOOLS).flat(), 'NotebookEdit'])
];

/** What a chat turn may and may not use, given the agent's granted skills. */
export interface ChatTools {
  allowed: string[];
  denied: string[];
}

/**
 * Resolve an agent's skills into the two argv lists.
 *
 * Unknown skill ids are ignored rather than rejected: the catalog is seeded
 * data a user can add to, and an id this map has not been taught should grant
 * nothing — not throw in the middle of a turn.
 */
export function chatToolsFor(skills: string[] = []): ChatTools {
  const granted = new Set<string>();
  for (const id of skills) {
    for (const tool of SKILL_TOOLS[id] ?? []) granted.add(tool);
  }

  return {
    allowed: [...CHAT_BASE_TOOLS, ...granted],
    denied: GRANTABLE_TOOLS.filter(t => !granted.has(t))
  };
}

/**
 * The constraint, worded for the model.
 *
 * Written as capability plus instruction rather than a bare prohibition: a model
 * told only what it cannot do still tends to narrate doing it. Telling it what
 * to do instead — make the edit, name the files, hand over the command — gives
 * the reply somewhere to go.
 *
 * Two shapes, because there are now two kinds of turn. An agent granted nothing
 * gets the old inspection-only text. An agent granted Write is told the edits
 * are real and unreviewed, because a model that believes its edits are
 * hypothetical is careless with them.
 */
export function describeChatToolPolicy(
  mcpServers: string[] = [],
  skills: string[] = [],
  githubAccess: 'read' | 'write' = 'read'
): string {
  const { allowed, denied } = chatToolsFor(skills);
  const canWrite = allowed.includes('Write') || allowed.includes('Edit');
  const canRunShell = allowed.includes('Bash');

  const mcp = mcpServers.length
    ? ` You also have the MCP servers: ${mcpServers.join(', ')}.`
    : '';

  // One sentence per line, never wrapped mid-sentence: a hard break inside a
  // clause is one more thing for the model to resolve, and it makes the text
  // awkward to assert on or grep for later.
  const lines = [
    '## Tool access for this conversation',
    '',
    `You can use: ${allowed.join(', ')}.${mcp}`,
    'These are Claude Code tool names; on another runtime, use its equivalent file-reading and search tools.',
    ''
  ];

  if (denied.length) {
    lines.push(`Do not ${denied.join(', ')} — those are not granted to you here.`, '');
  }

  if (canWrite) {
    lines.push(
      'Your file edits are real. They land in the working tree the user is looking at, immediately, with no branch, no diff and no approval step in between.',
      'Nothing in Alpha can undo them for you.',
      '',
      'So: make the edit when you are asked for it, and say plainly which files you changed.',
      'When a change is large, risky, or you are not sure it is wanted, propose it as a code block first and let the user say go.'
    );
  } else {
    lines.push(
      'This conversation is for inspection and advice only: nothing you write here reaches the project being discussed.',
      '',
      'So: propose changes as code blocks, and name the exact file path each one belongs to.',
      'Do not claim to have created or edited anything.'
    );
  }

  if (!canRunShell) {
    lines.push(
      '',
      'Shell commands are blocked. Hand over any command you would have run, for the user to execute.'
    );
  }

  if (mcpServers.includes('alpha-github')) {
    lines.push(
      '',
      githubAccess === 'write'
        ? 'On GitHub you may read, and you may push a branch — additive, reversible, and visible to the team before it counts. You may not merge, force-push, or push to a protected branch.'
        : 'On GitHub you have read access only. You may not push a branch or open a pull request.'
    );
  }

  return lines.join('\n');
}

/**
 * How a reply should be shaped, for a chat window rather than a terminal.
 *
 * The bubble renders markdown now, which removed most of what made a long reply
 * unreadable — the syntax was being shown as literal characters, and one
 * measured reply was 37% link targets by weight. This is the other half: what
 * the renderer cannot fix, because it is in the text rather than in how the
 * text is displayed.
 *
 * Three things, each observed in a real transcript:
 *
 *   absolute paths   Replies carried `file:///C:/Users/<name>/.alpha/cli-home/
 *                    antigravity.gemini/antigravity-cli/brain/70e096c7-6b00-
 *                    4289-8457-6efa65ccb743/architecture_overview.md`. Rendered
 *                    they collapse to a chip, but they still cost tokens, still
 *                    name a machine and a user, and mean nothing to a reader who
 *                    thinks in repository paths.
 *
 *   LaTeX            `$\rightarrow$` for an arrow, twice in one reply. There is
 *                    no math renderer and no reason to add one for arrows.
 *
 *   one long line    478 characters unbroken. It wraps, but a paragraph that
 *                    long is a wall whichever width it is poured into.
 *
 * Worded as preferences with reasons rather than prohibitions. A model told
 * "never" about formatting tends to spend its opening sentence acknowledging
 * the rule, which costs more than the habit did.
 */
export function describeReplyFormat(): string {
  return [
    '## How to write your reply',
    '',
    'This is rendered as markdown in a chat panel, not printed to a terminal.',
    '',
    'Refer to a file by its path relative to the project root, in backticks — `src/ContactForm.tsx`.',
    'Absolute paths and `file://` URLs are noise to the reader: they name this machine rather than the repository, and the person reading already knows which project they are in.',
    '',
    'Write arrows and symbols as plain characters — use → and ×, never LaTeX like $\\rightarrow$. Nothing here renders math.',
    '',
    'Keep paragraphs short enough to scan. Prefer a list to a long sentence with several clauses in it, and use at most one level of heading — a reply is not a document.'
  ].join('\n');
}
