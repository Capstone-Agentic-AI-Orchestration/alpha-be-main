import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Which interface the daemon listens on, and why it is not just a default.
 *
 * The two deployments want opposite answers. On a workstation this API spawns
 * shell commands, so binding a public interface would hand every device on the
 * network a way to start a run. In a container the health check and all real
 * traffic arrive from outside, so a loopback bind answers nothing and the
 * platform rolls the deploy back with no useful error.
 *
 * A mode-dependent default handles that. What it does not handle is the local
 * `.env` — `dotenv` loads it, it sets HOST=127.0.0.1 for desktop development,
 * and an explicit value beats a default. That file is gitignored, so the
 * safety of a real deploy rested on it being absent, which holds right up
 * until someone copies their env to the server.
 */
async function envWith(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import('./env.js');
}

afterEach(() => {
  delete process.env.ALPHA_MODE;
  delete process.env.HOST;
  vi.resetModules();
});

describe('host binding', () => {
  it('binds loopback on the desktop', async () => {
    const { HOST } = await envWith({ ALPHA_MODE: 'desktop', HOST: undefined });
    expect(HOST).toBe('127.0.0.1');
  });

  it('binds all interfaces in cloud mode', async () => {
    const { HOST } = await envWith({ ALPHA_MODE: 'cloud', HOST: undefined });
    expect(HOST).toBe('0.0.0.0');
  });

  /** The case a gitignored .env was silently creating. */
  it('overrides a configured loopback host in cloud mode, and says so', async () => {
    const { HOST, hostOverrideNote } = await envWith({ ALPHA_MODE: 'cloud', HOST: '127.0.0.1' });
    expect(HOST).toBe('0.0.0.0');
    expect(hostOverrideNote()).toContain('health check');
  });

  it('overrides the other spellings of loopback too', async () => {
    for (const loopback of ['localhost', '::1', 'LOCALHOST']) {
      const { HOST } = await envWith({ ALPHA_MODE: 'cloud', HOST: loopback });
      expect(HOST).toBe('0.0.0.0');
    }
  });

  /** An operator who names a real interface meant it; only loopback is overridden. */
  it('respects a non-loopback host in cloud mode', async () => {
    const { HOST, hostOverrideNote } = await envWith({ ALPHA_MODE: 'cloud', HOST: '10.0.0.5' });
    expect(HOST).toBe('10.0.0.5');
    expect(hostOverrideNote()).toBe('');
  });

  /** On the desktop, loopback is the point. Nothing is overridden. */
  it('leaves a loopback host alone on the desktop', async () => {
    const { HOST, hostOverrideNote } = await envWith({ ALPHA_MODE: 'desktop', HOST: '127.0.0.1' });
    expect(HOST).toBe('127.0.0.1');
    expect(hostOverrideNote()).toBe('');
  });
});
