import { issueStore } from '../store/stores.js';
import type { Issue } from '../models/index.js';
import { logInfo } from '../utils/logger.js';
import { sqliteService } from './sqliteService.js';
import { supabaseService } from './supabaseService.js';
import { currentWorkspaceId } from './workspaceContext.js';

/**
 * Getting a card onto the team's board, and keeping at it.
 *
 * A card change is saved on this desktop first and then sent to the team board.
 * That send used to be fire-and-forget: when the board refused it -- a token
 * that could not be fetched while the cloud woke up, a network drop -- the card
 * kept its new state here, the board kept the old one, and the next refresh
 * showed the old one with nothing said. A person who moved a card saw it move
 * back.
 *
 * Now a refused card waits here and is sent again with growing gaps. A retry
 * sends the card as it is at that moment, and never over a newer change a
 * teammate made on the board meanwhile: theirs is the later decision, and this
 * desktop picks it up on its next sync.
 */

export const BOARD_SHARE_WARNING =
  'Saved on this computer, but the team board has not confirmed it yet. Alpha keeps retrying; until then teammates may still see the earlier version.';

const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;
/** How long a card move waits for the board before answering with the warning instead. */
const REPLY_WAIT_MS = 8_000;

export function boardShareRetryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempts));
}

let timer: NodeJS.Timeout | null = null;
let retrying = false;

function scheduleRetry(delayMs: number): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void retryBoardShares();
  }, Math.max(1_000, delayMs));
  timer.unref?.();
}

function later(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Send a card to the team board, queueing a retry when it is refused. True once the board has it. */
export async function shareCard(issue: Issue, workspaceId: string = currentWorkspaceId()): Promise<boolean> {
  // The cloud is the board, and a desktop on its own shares none: nothing to send or remember.
  // Returning before the queue matters in the cloud, which keeps no local database at all.
  if (!supabaseService.sharesBoard()) return true;
  const refused = await supabaseService.shareIssue(issue);
  if (!refused) {
    sqliteService.clearBoardShare(workspaceId, issue.id);
    return true;
  }
  sqliteService.queueBoardShare(workspaceId, issue.id, refused, later(FIRST_RETRY_MS));
  scheduleRetry(FIRST_RETRY_MS);
  return false;
}

/**
 * `shareCard` for a person waiting on a reply: the warning to show, or
 * undefined once the board has the card. A slow board answers with the warning
 * after a few seconds; the send carries on and queues itself if it fails.
 */
export async function shareCardForReply(issue: Issue, workspaceId: string): Promise<string | undefined> {
  let wait: NodeJS.Timeout | undefined;
  const slow = new Promise<'slow'>(resolve => {
    wait = setTimeout(() => resolve('slow'), REPLY_WAIT_MS);
    wait.unref?.();
  });
  const outcome = await Promise.race([shareCard(issue, workspaceId), slow]);
  if (wait) clearTimeout(wait);
  return outcome === true ? undefined : BOARD_SHARE_WARNING;
}

/** Send the cards whose retry is due. Exported for tests and startup. */
export async function retryBoardShares(now: number = Date.now()): Promise<void> {
  if (retrying || !supabaseService.sharesBoard()) return;
  retrying = true;
  try {
    for (const entry of sqliteService.getDueBoardShares(20, new Date(now).toISOString())) {
      const backOff = (why: string) =>
        sqliteService.scheduleBoardShareRetry(entry.workspaceId, entry.issueId, later(boardShareRetryDelayMs(entry.attempts + 1)), why);

      // The board token is issued for the workspace this desktop is in.
      if (entry.workspaceId !== currentWorkspaceId()) { backOff('waiting for its workspace'); continue; }

      const issue = await issueStore().get(entry.workspaceId, entry.issueId);
      if (!issue) { sqliteService.clearBoardShare(entry.workspaceId, entry.issueId); continue; }

      let boardCopy: string | null;
      try {
        boardCopy = await supabaseService.sharedIssueUpdatedAt(issue.id);
      } catch (err: any) {
        backOff(String(err?.message ?? err));
        continue;
      }
      if (boardCopy && Date.parse(boardCopy) > Date.parse(issue.updatedAt)) {
        sqliteService.clearBoardShare(entry.workspaceId, issue.id);
        logInfo(`Dropped a waiting board update for ${issue.identifier}: the team board already has a newer change.`);
        continue;
      }

      const refused = await supabaseService.shareIssue(issue);
      if (refused) backOff(refused);
      else sqliteService.clearBoardShare(entry.workspaceId, issue.id);
    }
  } finally {
    retrying = false;
    const next = sqliteService.nextBoardShareAt();
    if (next) scheduleRetry(Date.parse(next) - Date.now());
  }
}

/**
 * Pick up cards still waiting from an earlier session, at once. A restart is
 * often what someone does when a card will not stick, and the board may have
 * been repaired meanwhile; the backoff resumes from here if it still refuses.
 */
export function startBoardShareRetries(): void {
  if (!supabaseService.sharesBoard()) return;
  sqliteService.makeBoardSharesDue();
  if (sqliteService.nextBoardShareAt()) scheduleRetry(5_000);
}

/** Test seam. */
export function resetBoardShareQueue(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  retrying = false;
}
