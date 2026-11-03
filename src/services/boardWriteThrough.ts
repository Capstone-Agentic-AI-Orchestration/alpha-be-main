import { sqliteService } from './sqliteService.js';
import { currentWorkspaceId } from './workspaceContext.js';
import { pushIssue } from './githubBoardWrite.js';
import { logError } from '../utils/logger.js';
import { Issue, IssueComment } from '../models/index.js';
import { supabaseService } from './supabaseService.js';

/**
 * Move a card locally and tell the shared board.
 *
 * `sqliteService.updateIssue` is deliberately local-only. The pull writes
 * through it constantly, and a data layer that pushed would send every pulled
 * change straight back out — a loop between two machines that never settles.
 * The rule that follows is "never push what the sync just wrote", but it was
 * implemented as "only the HTTP layer pushes", and those are not the same rule:
 * the second one also silences the runner.
 *
 * So an agent could finish, commit, open a pull request — and leave the card
 * reading Todo for everyone except the person whose laptop happened to run it.
 * A board that updates only for the machine doing the work is precisely the
 * thing a shared board exists not to be.
 *
 * Provenance is what actually distinguishes the two cases, not layer: a change
 * this daemon originated should be published, a change it just pulled should
 * not. The runner originates; the sync does not, and does not call this.
 */
/**
 * Write a comment locally and give it to the team's board.
 *
 * For comments this daemon originates -- run summaries, review verdicts,
 * reconciliation notes -- by the same provenance rule as `updateIssueAndPush`.
 * On a desktop of its own, GitHub gets them from the next sync; on a team's,
 * that sync is the cloud's, so they have to reach the cloud first.
 */
export function addCommentAndShare(comment: IssueComment): IssueComment {
  const saved = sqliteService.addIssueComment(comment);
  void supabaseService.shareComment(saved);
  return saved;
}

export function updateIssueAndPush(issueId: string, updates: Partial<Issue>): void {
  const updated = sqliteService.updateIssue(issueId, updates);
  if (!updated) return;

  /*
   * Deliberately not awaited. The local write has already happened and is what
   * the UI reads; a slow or unreachable GitHub must not fail a run that
   * otherwise succeeded, and no caller has anything to do with the result.
   */
  /*
   * The workspace comes from the async-local value the request or run is
   * already inside. Correct on a desktop, where the runner originates every
   * one of these and one process serves one person.
   */
  void pushIssue(updated, currentWorkspaceId())
    .then(result => {
      /*
       * A repository attached after the issue was filed leaves the card with no
       * number, so this push creates it rather than edits it. Storing what comes
       * back matters: without it the next status change would open a second
       * issue instead of moving this one.
       */
      const saved = result.patch ? sqliteService.updateIssue(issueId, result.patch) : null;
      if (result.error) {
        logError(`Board push failed for ${updated.identifier}: ${result.error}`);
      }
      return saved ?? updated;
    })
    .catch(err => {
      logError(`Board push failed for ${updated.identifier}:`, err);
      return updated;
    })
    /*
     * Then the team's board, with whatever GitHub number the push just made.
     *
     * Storing the number only here left every other copy of the board without
     * it. The cloud's next GitHub sync met the new issue, found no card with
     * its number, and made a second card for it; a teammate's desktop running
     * the same card opened a second issue. Both happened: MON-103 and MON-1
     * were one task, and CLO-102 opened #2 and #3. `shareIssue` reports its
     * own failures and never throws.
     */
    .then(latest => supabaseService.shareIssue(latest));
}
