import { describe, expect, it } from 'vitest';

import { DAEMON_ONLY_ENV, childProcessEnv } from './childProcessEnv.js';

describe('childProcessEnv', () => {
  it('removes daemon secrets and keeps the rest, overlay included', () => {
    const source = { PATH: '/bin', ALPHA_LOCAL_TOKEN: 't', SUPABASE_SERVICE_ROLE_KEY: 'k', ALPHA_SESSION_SECRET: 's' };
    const env = childProcessEnv({ CI: 'true' }, source);
    expect(env).toEqual({ PATH: '/bin', CI: 'true' });
    for (const key of DAEMON_ONLY_ENV) expect(key in env).toBe(false);
  });

  it('does not let an overlay put a daemon secret back', () => {
    expect(childProcessEnv({ ALPHA_LOCAL_TOKEN: 'x' }, {})).toEqual({});
  });
});
