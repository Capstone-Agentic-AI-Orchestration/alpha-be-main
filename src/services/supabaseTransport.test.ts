import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * The team board, on a Node without a global WebSocket.
 *
 * supabase-js finds its WebSocket on the global object, which Node has only
 * from 22. The installed desktop runs on Electron's Node, which is older, so
 * creating the client threw, the daemon logged it where nobody looks, and
 * every installed copy ran solo: no team board, no realtime, and developers
 * refused their own Sync with a project manager's 403. The test runner's Node
 * has the global, so it is taken away here to stand in for Electron's.
 */

const realWebSocket = (globalThis as any).WebSocket;

afterEach(() => {
  (globalThis as any).WebSocket = realWebSocket;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.ALPHA_MODE;
  vi.doUnmock('@supabase/supabase-js');
  vi.resetModules();
});

describe('the Supabase client on a Node with no global WebSocket', () => {
  it('still starts, so a desktop is on the team board', async () => {
    delete (globalThis as any).WebSocket;
    expect(typeof (globalThis as any).WebSocket).toBe('undefined');

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    delete process.env.ALPHA_MODE;
    vi.resetModules();
    const { supabaseService } = await import('./supabaseService.js');

    expect(supabaseService.isConfigured()).toBe(true);
    expect(supabaseService.sharesBoard()).toBe(true);
  });
});

/**
 * A desktop meant to be on the team board and not on it says why.
 *
 * The failure used to be one log line an installed app never shows, and the
 * visible symptom a Sync refused with a project manager's permission error.
 */
describe('a desktop whose team board client did not start', () => {
  it('names the reason', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    delete process.env.ALPHA_MODE;
    vi.resetModules();
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => {
        throw new Error('Node.js detected but native WebSocket not found.');
      }
    }));
    const { supabaseService } = await import('./supabaseService.js');

    expect(supabaseService.sharesBoard()).toBe(false);
    expect(supabaseService.connectionProblem()).toMatch(/native WebSocket not found/);
  });

  it('says nothing for a checkout run solo on purpose', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_ANON_KEY = '';
    delete process.env.ALPHA_MODE;
    vi.resetModules();
    const { supabaseService } = await import('./supabaseService.js');

    expect(supabaseService.connectionProblem()).toBeNull();
  });
});
