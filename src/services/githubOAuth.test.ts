import { afterEach, describe, expect, it, vi } from 'vitest';

describe('desktop GitHub OAuth routing', () => {
  afterEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_CALLBACK_URL;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('builds an account-specific chooser URL and keeps the handoff pending', async () => {
    process.env.GITHUB_CLIENT_ID = 'Iv1.test-client';
    process.env.GITHUB_CALLBACK_URL = 'https://alpha.example.com/api/github/oauth/callback';
    vi.resetModules();

    const { RestGitHubService } = await import('./githubService.js');
    const service = new RestGitHubService();
    const handoffToken = 'a'.repeat(64);
    const flow = service.startDesktopOAuth(handoffToken, 'pineapple-2005');
    const params = new URL(flow.url).searchParams;

    expect(params.get('login')).toBe('pineapple-2005');
    expect(params.get('prompt')).toBe('select_account');
    expect(params.get('redirect_uri')).toBe(process.env.GITHUB_CALLBACK_URL);
    expect(service.isDesktopOAuthState(flow.state)).toBe(true);
    expect(service.takeDesktopOAuthResult(flow.state, handoffToken)).toEqual({ status: 'pending' });
  });

  it('does not fall back to an unscoped device flow for a selected profile', async () => {
    delete process.env.ALPHA_CLOUD_API;
    vi.resetModules();

    const { GhCliGitHubService } = await import('./githubService.js');
    await expect(new GhCliGitHubService().startDeviceLogin('pineapple-2005'))
      .rejects.toThrow(/cannot target a remembered GitHub profile/i);
  });

  it('rejects a different account before handing its credential to the desktop', async () => {
    process.env.GITHUB_CLIENT_ID = 'Iv1.test-client';
    process.env.GITHUB_CLIENT_SECRET = 'test-secret';
    process.env.GITHUB_CALLBACK_URL = 'https://alpha.example.com/api/github/oauth/callback';
    vi.resetModules();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'oauth-token-for-someone-else' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ login: 'someone-else', id: 123 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { RestGitHubService } = await import('./githubService.js');
    const service = new RestGitHubService();
    const handoffToken = 'b'.repeat(64);
    const flow = service.startDesktopOAuth(handoffToken, 'pineapple-2005');

    await expect(service.handleOAuthCallback('test-code', flow.state))
      .rejects.toThrow(/authorized @someone-else.*started for @pineapple-2005/i);
    expect(service.takeDesktopOAuthResult(flow.state, handoffToken)).toEqual({
      status: 'failed',
      message: expect.stringMatching(/authorized @someone-else.*started for @pineapple-2005/i)
    });
  });
});
