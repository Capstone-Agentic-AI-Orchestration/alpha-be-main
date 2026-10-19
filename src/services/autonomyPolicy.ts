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
 * ## Chat was once always read, and no longer is
 *
 * It was pinned to `read` because chat had `mcp__alpha-github` in its allowed
 * tools with nothing qualifying it, so an agent asked a question in the sidebar
 * could push a branch and open a pull request — with no branch of its own, no
 * diff, and no approval gate, none of which a chat turn has.
 *
 * What that pin lacked was a way to say *which* agents. It is back to being a
 * policy question rather than a blanket answer, and now takes two keys instead
 * of one:
 *
 *   the skill    `sk-git` — was this agent handed GitHub at all, deliberately,
 *                on its own card
 *   the level    `autonomyLevel` — and is it trusted to write to a remote
 *
 * Both, or it reads. That keeps the seeded Reviewer honest: it holds `sk-git`
 * and is Supervised, so it may read a repository and say what it thinks about
 * one, which is its whole job, and may not push — exactly what its card claims.
 *
 * A run is unchanged, and deliberately does not consult skills. Runs already
 * have the gate chat lacks (a branch, a diff, `awaiting_approval`), and the
 * seeded Tester holds no `sk-git` while its runs legitimately push through
 * Alpha's own pipeline. Narrowing that here would break a working path to fix
 * nothing.
 */
export type McpAccess = 'read' | 'write';

/** The skill that grants GitHub write. See SKILL_TOOLS in toolPolicy. */
export const GITHUB_WRITE_SKILL = 'sk-git';

export function mcpAccessFor(
  autonomy: AutonomyLevel | undefined,
  mode: 'run' | 'chat' | 'review',
  skills: string[] = []
): McpAccess {
  if (mode === 'review') return 'read';
  // Chat needs the grant to be explicit on the agent itself; a run inherits it
  // from the pipeline that will review the result.
  if (mode === 'chat' && !skills.includes(GITHUB_WRITE_SKILL)) return 'read';

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
