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

/** Tools a chat turn may use. Inspection only. */
export const CHAT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * Tools a chat turn may not use.
 *
 * Denied outright rather than left to prompt: `bypassPermissions` is worse, and
 * leaving them to ask would hang a headless process on a TTY that is not there.
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
    `You cannot ${CHAT_DISALLOWED_TOOLS.join(', ')} — file writes and shell commands are disabled here, and attempting one fails rather than asking permission.`,
    '',
    'So: propose changes as code blocks, and name the exact file path each one belongs to.',
    'Hand over any command you would have run, for the user to execute.',
    'Do not claim to have created, edited, or run anything.'
  ].join('\n');
}
