import { vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

/**
 * Project folders default to Documents\AlphaProjects, and cloning or starting
 * a desktop creates them. A test run must never write there, so every test
 * gets a scratch projects folder unless it sets its own.
 */
process.env.ALPHA_CODE_FOLDER ||= path.join(os.tmpdir(), `alpha-test-projects-${process.pid}`);

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
