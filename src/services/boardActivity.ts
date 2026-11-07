import type { IssueComment } from '../models/index.js';

/**
 * Board activity notes (archived, restored, changed by an agent) are for the
 * team's board, not the GitHub issue: GitHub sync skips comments with this id
 * prefix, so archiving or an agent's edit leaves a linked issue untouched and
 * costs no GitHub request.
 */
export const BOARD_ACTIVITY_COMMENT_PREFIX = 'comm-activity-';

export function isBoardActivityComment(comment: Pick<IssueComment, 'id'>): boolean {
  return comment.id.startsWith(BOARD_ACTIVITY_COMMENT_PREFIX);
}
