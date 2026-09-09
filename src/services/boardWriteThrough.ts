import { sqliteService } from './sqliteService.js';
import { pushIssue } from './githubBoardWrite.js';
import { logError } from '../utils/logger.js';
import { Issue } from '../models/index.js';

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
export function updateIssueAndPush(issueId: string, updates: Partial<Issue>): void {
  const updated = sqliteService.updateIssue(issueId, updates);
  if (!updated) return;

  /*
   * Deliberately not awaited. The local write has already happened and is what
   * the UI reads; a slow or unreachable GitHub must not fail a run that
   * otherwise succeeded, and no caller has anything to do with the result.
   */
  void pushIssue(updated)
    .then(result => {
      /*
       * A repository attached after the issue was filed leaves the card with no
       * number, so this push creates it rather than edits it. Storing what comes
       * back matters: without it the next status change would open a second
       * issue instead of moving this one.
       */
      if (result.patch) sqliteService.updateIssue(issueId, result.patch);
      if (result.error) {
        logError(`Board push failed for ${updated.identifier}: ${result.error}`);
      }
    })
    .catch(err => logError(`Board push failed for ${updated.identifier}:`, err));
}
