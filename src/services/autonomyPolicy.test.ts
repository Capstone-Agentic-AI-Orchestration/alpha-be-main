import { describe, it, expect } from 'vitest';
import { mcpAccessFor } from './autonomyPolicy.js';

/**
 * `autonomyLevel` was written, validated and displayed, and read by nothing.
 * Supervised and Full Autonomy produced identical runs, so the field on every
 * agent card was a label with no behaviour behind it.
 *
 * These fix the mapping in place, and in particular the directions it must never
 * drift: an unknown level is read-only rather than permissive, a supervised
 * agent never reaches a remote, and a chat turn needs the grant to be explicit
 * on the agent itself before autonomy is even consulted.
 */
describe('a run', () => {
  it('lets an approval-gated agent propose work', () => {
    expect(mcpAccessFor('Semi-Autonomous (Requires Approval)', 'run')).toBe('write');
  });

  it('lets a fully autonomous agent propose work', () => {
    // Still only 'write' — merging is not on this axis at any level.
    expect(mcpAccessFor('Full Autonomy', 'run')).toBe('write');
  });

  /** The seeded Reviewer is Supervised, and was pushing code regardless. */
  it('keeps a supervised agent off the remote', () => {
    expect(mcpAccessFor('Supervised', 'run')).toBe('read');
  });

  it('does not consult skills', () => {
    // Runs already have the gate chat lacks — a branch, a diff, and
    // `awaiting_approval` — and the seeded Tester holds no sk-git while its
    // runs legitimately push through Alpha's own pipeline. Narrowing here would
    // break a working path to fix nothing.
    expect(mcpAccessFor('Full Autonomy', 'run', [])).toBe('write');
    expect(mcpAccessFor('Full Autonomy', 'run', ['sk-fs'])).toBe('write');
  });
});

describe('a chat turn', () => {
  /**
   * The hole that made this pinned to `read` for everyone: chat had
   * `mcp__alpha-github` in its allowed tools with nothing qualifying it, so an
   * agent answering a question in the sidebar could push a branch and open a
   * pull request — with none of the things that make a run reviewable.
   *
   * It is a policy question again rather than a blanket answer, and takes two
   * keys: the skill says GitHub was handed over deliberately, the level says the
   * agent is trusted to write to a remote.
   */
  it('needs sk-git before autonomy is even considered', () => {
    expect(mcpAccessFor('Full Autonomy', 'chat', [])).toBe('read');
    expect(mcpAccessFor('Full Autonomy', 'chat', ['sk-fs', 'sk-bash'])).toBe('read');
  });

  it('grants write to a trusted agent that holds the skill', () => {
    expect(mcpAccessFor('Full Autonomy', 'chat', ['sk-git'])).toBe('write');
    expect(mcpAccessFor('Semi-Autonomous (Requires Approval)', 'chat', ['sk-git'])).toBe('write');
  });

  /**
   * The seeded Reviewer: Supervised, and holding sk-git. It may read a
   * repository and say what it thinks about one — which is its whole job — and
   * may not push. Exactly what its card claims.
   */
  it('still keeps a supervised agent off the remote, skill or not', () => {
    expect(mcpAccessFor('Supervised', 'chat', ['sk-git'])).toBe('read');
  });

  it('defaults to read when no skills are passed at all', () => {
    // Every caller that has not been taught to pass them keeps the old
    // behaviour rather than silently gaining write.
    expect(mcpAccessFor('Full Autonomy', 'chat')).toBe('read');
  });
});

describe('an orchestration review', () => {
  it('keeps remote tools read-only even for a fully autonomous agent with GitHub access', () => {
    expect(mcpAccessFor('Full Autonomy', 'review', ['sk-git'])).toBe('read');
  });
});

describe('a level that cannot be resolved', () => {
  it('fails closed rather than open', () => {
    expect(mcpAccessFor(undefined, 'run')).toBe('read');
    // A typo in persona frontmatter is likelier than a deliberate new tier.
    expect(mcpAccessFor('Autonomous' as never, 'run')).toBe('read');
  });

  it('fails closed in chat even holding the skill', () => {
    expect(mcpAccessFor(undefined, 'chat', ['sk-git'])).toBe('read');
    expect(mcpAccessFor('Autonomous' as never, 'chat', ['sk-git'])).toBe('read');
  });
});
