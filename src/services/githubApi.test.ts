import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * The one way Alpha reaches GitHub, on a desktop and on Render.
 *
 * What matters is whose token goes out. In the cloud it must be the person
 * making the request and nobody else -- there is no `gh` there, and falling
 * back to anything shared would be acting with permissions nobody was granted.
 * And a list must be read to the end, or a board with more than one page of
 * issues looks like issues were deleted.
 */

async function load(mode: 'cloud' | 'desktop') {
  if (mode === 'cloud') process.env.ALPHA_MODE = 'cloud';
  else delete process.env.ALPHA_MODE;
  vi.resetModules();
  const api = await import('./githubApi.js');
  const context = await import('./githubRequestContext.js');
  return { ...api, ...context };
}

/** A fetch that answers from a table of URL -> response, recording what it was sent. */
function stubFetch(pages: Record<string, { status?: number; body: unknown; link?: string }>) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const page = pages[url];
    if (!page) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: page.link ? { link: page.link } : {}
    });
  });
  return sent;
}

afterEach(() => {
  delete process.env.ALPHA_MODE;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('whose token', () => {
  it('uses the signed-in person’s token', async () => {
    const { githubApi, withGitHubIdentity } = await load('cloud');
    const sent = stubFetch({ 'https://api.github.com/user': { body: { login: 'octocat' } } });

    await withGitHubIdentity({ token: 'person-token' }, () => githubApi().get('/user'));

    expect((sent[0].init.headers as Record<string, string>).Authorization).toBe('Bearer person-token');
  });

  /** On Render there is no `gh`, and no shared credential to fall back to. */
  it('refuses in the cloud when nobody is signed in', async () => {
    const { githubApi, GitHubApiError } = await load('cloud');
    const sent = stubFetch({});

    const call = githubApi().get('/user');

    await expect(call).rejects.toBeInstanceOf(GitHubApiError);
    await expect(call).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(0);
  });
});

describe('reading a list', () => {
  /**
   * GitHub caps a page at a hundred. A sync that stopped there would drop the
   * rest of a busy repository's issues off the board without saying so.
   */
  it('follows the Link header to the last page', async () => {
    const { githubApi, withGitHubIdentity } = await load('cloud');
    stubFetch({
      'https://api.github.com/repos/o/r/issues?per_page=100': {
        body: [{ number: 1 }, { number: 2 }],
        link: '<https://api.github.com/repositories/9/issues?per_page=100&page=2>; rel="next", ' +
          '<https://api.github.com/repositories/9/issues?per_page=100&page=2>; rel="last"'
      },
      'https://api.github.com/repositories/9/issues?per_page=100&page=2': { body: [{ number: 3 }] }
    });

    const all = await withGitHubIdentity({ token: 't' }, () =>
      githubApi().getAll<{ number: number }>('/repos/o/r/issues?per_page=100')
    );

    expect(all.map(i => i.number)).toEqual([1, 2, 3]);
  });

  it('reads the next page from a Link header', async () => {
    const { nextPage } = await load('desktop');
    expect(nextPage(null)).toBeNull();
    expect(nextPage('<https://x/last>; rel="last"')).toBeNull();
    expect(nextPage('<https://x/prev>; rel="prev", <https://x/next>; rel="next"')).toBe('https://x/next');
  });
});

describe('failures', () => {
  /** GitHub's own message is what tells a person what to fix. */
  it('carries the status and GitHub’s message', async () => {
    const { githubApi, withGitHubIdentity } = await load('cloud');
    stubFetch({
      'https://api.github.com/repos/o/r/issues': {
        status: 403,
        body: { message: 'Resource not accessible by integration' }
      }
    });

    const call = withGitHubIdentity({ token: 't' }, () => githubApi().post('/repos/o/r/issues', { title: 'x' }));

    await expect(call).rejects.toMatchObject({ status: 403 });
    await expect(call).rejects.toThrow(/403 .*Resource not accessible by integration/);
  });
});
