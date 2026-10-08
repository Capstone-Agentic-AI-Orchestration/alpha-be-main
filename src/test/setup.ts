import { vi } from 'vitest';

/**
 * Configuration is a test fixture, never the workstation's .env.
 *
 * Tests deliberately delete ALPHA_MODE and reload env.ts to exercise defaults.
 * Empty values in vitest.config.ts alone cannot protect that path: dotenv
 * would refill a deleted variable with the real deployment setting. Mock the
 * file loader before application imports, including after vi.resetModules().
 * Tests can still set individual process.env values to exercise cloud mode.
 * This setup is never imported by the application entry point.
 */
vi.mock('dotenv', () => ({
  default: {
    config: vi.fn(() => ({ parsed: {} })),
  },
}));
