import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { IS_CLOUD } from '../config/env.js';
import { currentGitHubIdentity } from './githubRequestContext.js';
import { isSessionAuthenticated, requiresSessionAuthentication, storedToken } from './alphaGitHubToken.js';

const execFileAsync = promisify(execFile);

/**
 * GitHub's REST API, as the person making the request.
 *
 * The board sync and the issue push used to shell out to `gh api`. That works
 * on a developer's machine and not at all on Render, where there is no `gh`:
 * every "Sync board" a project manager pressed on the web failed for every
 * project, and every card they moved stayed off GitHub. This is one path for
 * both halves.
 *
 * ## Whose token
 *
 * In the cloud, the signed-in person's own OAuth token, which `sessionContext`
 * puts on the request. Never a shared server credential: GitHub's permissions
 * are per person, and a sync that ran as the App would show a project manager
 * repositories they cannot open, and write to GitHub under nobody's name.
 *
 * On a desktop, the token Alpha was signed in with -- its own, not the
 * machine's. It used to read `gh auth token`, which meant the app acted as
 * whichever account the developer last used in their terminal, and changed
 * underneath it when they switched. A daemon run from source still falls back
 * to `gh`, so working on Alpha does not require signing in to it.
 */
export interface GitHubApi {
  get<T>(path: string): Promise<T>;
  /** Every page of a list, following GitHub's `Link: rel="next"`. */
  getAll<T>(path: string): Promise<T[]>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

/** A GitHub answer that was not a success, with its status for callers that branch on it. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

const API = 'https://api.github.com';

/**
 * A bounded walk, not an unbounded one. Five thousand issues is past any board
 * this product is for; a repository beyond it is better served by an error in
 * the log than by a sync that never returns.
 */
const MAX_PAGES = 50;

/** The token this request acts with. */
export async function tokenForThisRequest(): Promise<string> {
  const fromRequest = currentGitHubIdentity()?.token;
  if (fromRequest) return fromRequest;

  if (IS_CLOUD) {
    // No person, no GitHub call: acting as the server instead would be acting
    // with permissions nobody was granted.
    throw new GitHubApiError('Sign in with GitHub to reach GitHub from here.', 401);
  }

  // Alpha's own sign-in, which is the account the person chose in the app.
  if (requiresSessionAuthentication() && !isSessionAuthenticated()) {
    throw new GitHubApiError('Alpha is not signed in to GitHub. Sign in from Connected Accounts.', 401);
  }
  const own = storedToken();
  if (own) return own;

  /**
   * Otherwise the machine's `gh`, but only from source.
   *
   * An installed copy signs in for itself. Letting it fall through to the CLI
   * put back exactly what the in-app sign-in removed -- the app opening onto
   * the board as whoever the terminal was signed in as, having asked nobody.
   * A developer running Alpha from a checkout has `gh` already and should not
   * complete a device flow to run what they are editing.
   */
  if (requiresSessionAuthentication()) {
    throw new GitHubApiError('Alpha is not signed in to GitHub. Sign in from Connected Accounts.', 401);
  }

  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000, windowsHide: true });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // Falls through to the message below, which says what to do about it.
  }
  throw new GitHubApiError('Alpha is not signed in to GitHub. Sign in from Connected Accounts.', 401);
}

/** The `rel="next"` target of a `Link` header, if there is one. */
export function nextPage(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}

async function call(method: string, url: string, body?: unknown, explicitToken?: string): Promise<Response> {
  const token = explicitToken ?? (await tokenForThisRequest());
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Alpha',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    // GitHub's own message ("Not Found", "Resource not accessible by
    // integration") is the useful part; the rest is the path it refers to.
    let message = detail;
    try {
      message = (JSON.parse(detail) as { message?: string }).message ?? detail;
    } catch {
      /* not JSON */
    }
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const retry = Number(res.headers.get('retry-after')) ||
      (res.headers.get('x-ratelimit-remaining') === '0' && reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : undefined);
    throw new GitHubApiError(`GitHub ${res.status} on ${method} ${url}: ${message}`, res.status, retry);
  }
  return res;
}

function restApiFor(token?: string): GitHubApi {
  return {
    async get<T>(path: string): Promise<T> {
      return (await call('GET', path, undefined, token)).json() as Promise<T>;
    },

    async getAll<T>(path: string): Promise<T[]> {
      const items: T[] = [];
      let url: string | null = path;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const res = await call('GET', url, undefined, token);
        items.push(...((await res.json()) as T[]));
        url = nextPage(res.headers.get('link'));
      }
      return items;
    },

    async post<T>(path: string, body: unknown): Promise<T> {
      return (await call('POST', path, body, token)).json() as Promise<T>;
    },

    async patch<T>(path: string, body: unknown): Promise<T> {
      return (await call('PATCH', path, body, token)).json() as Promise<T>;
    },

    async put<T>(path: string, body: unknown): Promise<T> {
      return (await call('PUT', path, body, token)).json() as Promise<T>;
    },

    async delete(path: string): Promise<void> {
      // 204 No Content: there is no body to read.
      await call('DELETE', path, undefined, token);
    }
  };
}

const restApi: GitHubApi = restApiFor();

/**
 * The same API acting with an explicit token instead of the request's or the
 * signed-in account's -- for a process with no request and no session of its
 * own, such as the agents' GitHub tool server, which gets its token from `gh`.
 */
export function githubApiWithToken(token: string): GitHubApi {
  return override ?? restApiFor(token);
}

let override: GitHubApi | null = null;

export function githubApi(): GitHubApi {
  return override ?? restApi;
}

/** For tests, which answer for GitHub rather than calling it. */
export function useGitHubApi(api: GitHubApi | null): void {
  override = api;
}
