import type { IssueComment } from '../models/index.js';

/**
 * Task comments are written by people: the project manager, the client, the
 * developers. Agents and Alpha itself do not comment on cards.
 *
 * They used to, from about seventeen places (run started, run finished, build
 * planned, published for review, archived by...), which buried what people
 * wrote under a run log that already lives in the project chat and the Build
 * review tab. This is the one rule every comment store checks, so a new agent
 * feature cannot quietly start commenting again.
 */
export function isPersonComment(comment: Pick<IssueComment, 'authorType'>): boolean {
  return comment.authorType === 'user';
}

/** Refuses an agent's or Alpha's comment, loudly, before anything is written. */
export function assertPersonComment(comment: Pick<IssueComment, 'id' | 'authorType'>): void {
  if (!isPersonComment(comment)) {
    throw new Error(`Task comments are written by people only; refused a ${comment.authorType} comment (${comment.id}). Report progress in the project chat instead.`);
  }
}
