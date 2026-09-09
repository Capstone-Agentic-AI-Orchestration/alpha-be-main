import { describe, it, expect } from 'vitest';
import { isFinalSquadMember } from './squadPosition.js';

/**
 * One pull request per issue, and one card move per issue.
 *
 * A squad is several runs against one issue on one branch. Both of the things
 * that happen at the end of a run — opening the pull request, and moving the
 * kanban card to Review — belong to the last member only. The card move had no
 * such guard, so the first of four members finishing announced the issue as
 * ready to review while three agents were still committing.
 */
describe('isFinalSquadMember', () => {
  const squad = (n: number) => ({ memberAgentIds: Array.from({ length: n }, (_, i) => `agent-${i}`) });

  it('treats a solo run as final', () => {
    // No squad at all: the run is the whole of the work on the issue.
    expect(isFinalSquadMember({}, undefined)).toBe(true);
  });

  it('holds back every member before the last', () => {
    const four = squad(4);
    expect(isFinalSquadMember({ squadRunId: 'sr-1', squadOrder: 0 }, four)).toBe(false);
    expect(isFinalSquadMember({ squadRunId: 'sr-1', squadOrder: 1 }, four)).toBe(false);
    expect(isFinalSquadMember({ squadRunId: 'sr-1', squadOrder: 2 }, four)).toBe(false);
  });

  it('releases the last member', () => {
    expect(isFinalSquadMember({ squadRunId: 'sr-1', squadOrder: 3 }, squad(4))).toBe(true);
  });

  it('releases the only member of a one-agent squad', () => {
    // Order 0 of 1 is both the first and the last. An off-by-one here would
    // strand a single-member squad: no pull request, card stuck in progress.
    expect(isFinalSquadMember({ squadRunId: 'sr-1', squadOrder: 0 }, squad(1))).toBe(true);
  });

  /**
   * A squad run that cannot be read is treated as no squad at all.
   *
   * Deliberate, and the safer of the two failures: a run whose squad row is
   * missing still opens its pull request and still moves its card, so the work
   * is visible and reviewable. The alternative leaves the issue in
   * `agent_running` for ever with no pull request and nothing on screen
   * explaining why.
   */
  it('falls back to final when the squad run cannot be loaded', () => {
    expect(isFinalSquadMember({ squadRunId: 'sr-gone', squadOrder: 1 }, undefined)).toBe(true);
  });

  it('does not treat a missing order as the last position', () => {
    // squadOrder is written at the same moment as squadRunId, so absent-with-a-
    // squad should not happen — but guessing "last" here would open a premature
    // pull request, which is the outcome this predicate exists to prevent.
    expect(isFinalSquadMember({ squadRunId: 'sr-1' }, squad(3))).toBe(false);
  });
});
