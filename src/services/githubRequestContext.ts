import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request GitHub identity.
 *
 * Why this exists: `githubService` is a module singleton. On the desktop that is
 * correct — one process, one human. On the hosted deployment it is one process
 * serving everyone, and storing a user's OAuth token on the instance means the
 * last person to sign in becomes the identity for every subsequent request.
 * User A would create repositories as User B.
 *
 * AsyncLocalStorage keeps the token on the async call chain of the request that
 * owns it, so concurrent requests cannot observe each other's credentials, and
 * no method signature has to change to carry it.
 *
 * Populated by middleware once sessions exist; until then it is simply empty and
 * the service falls back to the single-tenant environment token.
 */
export interface GitHubRequestIdentity {
  /** The signed-in user's GitHub OAuth token for THIS request. */
  token: string;
  /** GitHub login, for logging and attribution. */
  login?: string;
}

const store = new AsyncLocalStorage<GitHubRequestIdentity>();

/** Run `fn` with `identity` visible to any GitHub call it makes. */
export function withGitHubIdentity<T>(identity: GitHubRequestIdentity, fn: () => T): T {
  return store.run(identity, fn);
}

/** The current request's GitHub identity, or undefined outside a request. */
export function currentGitHubIdentity(): GitHubRequestIdentity | undefined {
  return store.getStore();
}
