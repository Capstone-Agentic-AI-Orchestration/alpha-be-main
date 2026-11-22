/**
 * One spelling of a GitHub repository for comparison: owner/name, lower case, without the
 * https://github.com/ prefix, a .git suffix or a trailing slash. Compare repositories with
 * sameRepository, never with a bare toLowerCase(): a task saved as a URL and a workspace saved
 * as owner/name are the same codebase, and an unequal comparison stopped final checks.
 */
export function canonicalRepository(value: string | undefined): string {
  return (value ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
}

export function sameRepository(left: string | undefined, right: string | undefined): boolean {
  return canonicalRepository(left) === canonicalRepository(right);
}
