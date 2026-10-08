import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import dotenv from 'dotenv';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('test configuration isolation', () => {
  it('does not load the workstation environment file', () => {
    expect(vi.isMockFunction(dotenv.config)).toBe(true);
    expect(dotenv.config()).toEqual({ parsed: {} });
  });

  it('keeps the desktop default when a test removes ALPHA_MODE', async () => {
    vi.stubEnv('ALPHA_MODE', undefined);
    const config = await import('./env.js');
    expect(config.ALPHA_MODE).toBe('desktop');
    expect(config.IS_CLOUD).toBe(false);
    expect(config.DATABASE_URL).toBe('');
    expect(config.SUPABASE_URL).toBe('');
  });

  it('allows explicit cloud fixtures without real database credentials', async () => {
    vi.stubEnv('ALPHA_MODE', 'cloud');
    const config = await import('./env.js');
    expect(config.IS_CLOUD).toBe(true);
    expect(config.DATABASE_URL).toBe('');
  });

  it('uses each fixture home rather than a shared SQLite override', async () => {
    const fixtureHome = path.resolve('test-fixture-home');
    vi.stubEnv('ALPHA_HOME', fixtureHome);
    vi.stubEnv('SQLITE_DB_PATH', '');
    const config = await import('./env.js');
    expect(config.DB_PATH).toBe(path.join(fixtureHome, 'alpha.db'));
  });
});
