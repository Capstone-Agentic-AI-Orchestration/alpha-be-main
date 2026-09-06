import { AutonomyLevel } from '../models/index.js';

/**
 * What an agent's MCP tools may do to a remote, this turn.
 *
 * ## Why this exists
 *
 * `autonomyLevel` was stored in SQLite, validated in persona frontmatter and
 * returned by the API, and read by nothing. Supervised and Full Autonomy
 * produced byte-identical runs, so the field on every agent card was decoration
 * — and the one on the seeded Reviewer said Supervised while it could push code
 * and open pull requests like anyone else.
 *
 * ## The axis
 *
 * Not "how much is this agent trusted" in the abstract, but what it may do to
 * a shared remote, in three bands:
 *
 *   read    reads, and commentary — a review body is speech, not a change, and
 *           costs nothing to undo, so every level has it.
 *   write   push a branch and open a pull request. A proposal: additive,
 *           reversible, and visible to the team before it counts.
 *   (none)  merge, force-push, push to a protected branch. No level reaches
 *           these. They belong to the person at the review gate.
 *
 * A chat turn is always `read` regardless of the agent, and that is the hole
 * this closes rather than a policy choice: chat had `mcp__alpha-github` in its
 * allowed tools, so an agent asked a question in the sidebar could push a
 * branch and open a pull request — with no branch of its own, no diff, and no
 * approval gate, none of which a chat turn has. toolPolicy already said chat
 * must be read-only; its MCP tools had simply never been included in that.
 */
export type McpAccess = 'read' | 'write';

export function mcpAccessFor(
  autonomy: AutonomyLevel | undefined,
  mode: 'run' | 'chat'
): McpAccess {
  if (mode === 'chat') return 'read';

  switch (autonomy) {
    case 'Semi-Autonomous (Requires Approval)':
    case 'Full Autonomy':
      return 'write';
    /*
     * Supervised, and anything unrecognised, fail closed. An agent whose level
     * could not be resolved is not an agent to hand a push to, and a level this
     * function has not been taught is more likely a typo in frontmatter than a
     * new permission the author meant to grant.
     */
    default:
      return 'read';
  }
}
