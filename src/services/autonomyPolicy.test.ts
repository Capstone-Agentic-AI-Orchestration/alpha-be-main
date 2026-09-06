import { describe, it, expect } from 'vitest';
import { mcpAccessFor } from './autonomyPolicy.js';

/**
 * `autonomyLevel` was written, validated and displayed, and read by nothing.
 * Supervised and Full Autonomy produced identical runs, so the field on every
 * agent card was a label with no behaviour behind it.
 *
 * These fix the mapping in place, and in particular fix the two directions it
 * must never drift: a chat turn is read-only whatever the agent is, and an
 * unknown level is read-only rather than permissive.
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
});

describe('a chat turn', () => {
  /**
   * The hole this closes. Chat had `mcp__alpha-github` in its allowed tools, so
   * an agent answering a question in the sidebar could push a branch and open a
   * pull request — with none of the things that make a run reviewable.
   */
  it('is read-only however autonomous the agent is', () => {
    expect(mcpAccessFor('Full Autonomy', 'chat')).toBe('read');
    expect(mcpAccessFor('Semi-Autonomous (Requires Approval)', 'chat')).toBe('read');
    expect(mcpAccessFor('Supervised', 'chat')).toBe('read');
  });
});

describe('a level that cannot be resolved', () => {
  it('fails closed rather than open', () => {
    expect(mcpAccessFor(undefined, 'run')).toBe('read');
    // A typo in persona frontmatter is likelier than a deliberate new tier.
    expect(mcpAccessFor('Autonomous' as never, 'run')).toBe('read');
  });
});
