import { githubApi } from './githubApi.js';
import { logError } from '../utils/logger.js';

/**
 * Pull requests, through GitHub's REST API rather than `gh`.
 *
 * The desktop merges with `gh pr merge` inside the project's checkout. The
 * cloud has neither, so approving a run on the web -- which merges its pull
 * request -- needs this instead, acting as the person who approved.
 */

interface PullRef {
  ownerRepo: string;
  number: number;
}

/** `https://github.com/owner/repo/pull/12`, and nothing else. */
export function parsePullRequestUrl(url: string): PullRef | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  return match ? { ownerRepo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

interface PullRequest {
  head: { ref: string; repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
}

/**
 * Squash-merge a pull request and delete its branch, as `gh pr merge --squash
 * --delete-branch` does on a desktop.
 *
 * A failure to merge is thrown with GitHub's reason, which is what the review
 * gate reports: checks still running, a conflict, a protected branch. Failing
 * to delete the branch afterwards is not a failure of the merge and is only
 * logged -- the work is merged either way.
 */
export async function mergePullRequestOverApi(prUrl: string): Promise<string> {
  const ref = parsePullRequestUrl(prUrl);
  if (!ref) throw new Error(`${prUrl} is not a GitHub pull request URL.`);

  const path = `/repos/${ref.ownerRepo}/pulls/${ref.number}`;
  const pull = await githubApi().get<PullRequest>(path);
  const merged = await githubApi().put<{ message?: string }>(`${path}/merge`, { merge_method: 'squash' });

  // A branch in a fork belongs to whoever forked; it is not ours to delete.
  if (pull.head.repo?.full_name === pull.base.repo.full_name) {
    try {
      await githubApi().delete(`/repos/${ref.ownerRepo}/git/refs/heads/${encodeURIComponent(pull.head.ref)}`);
    } catch (err: any) {
      logError(`Merged ${prUrl} but could not delete ${pull.head.ref}:`, String(err?.message ?? err));
    }
  }

  return merged.message ?? 'Pull request merged.';
}
