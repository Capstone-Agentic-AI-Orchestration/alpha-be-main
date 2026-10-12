import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['ALPHA_MODE', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ALPHA_CLOUD_API'] as const;
const previousEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousEnv.clear();
  vi.resetModules();
});

describe('SupabaseService cloud-mode initialization', () => {
  it('does not initialize the desktop board client in the hosted service', async () => {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    process.env.ALPHA_MODE = 'cloud';
    process.env.SUPABASE_URL = 'https://alpha-test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'public-test-key';
    delete process.env.ALPHA_CLOUD_API;

    vi.resetModules();

    const { supabaseService } = await import('./supabaseService.js');

    expect(supabaseService.isConfigured()).toBe(false);
    expect(supabaseService.getClient()).toBeNull();
  });
});
