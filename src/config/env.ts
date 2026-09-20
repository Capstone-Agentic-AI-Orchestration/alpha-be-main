import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';

dotenv.config();

export const PORT = Number(process.env.PORT || 3001);
// Loopback by default. 0.0.0.0 exposes an API that spawns shell commands to
// every device on the network; opt in explicitly if you really want that.
export const HOST = process.env.HOST || '127.0.0.1';

/**
 * Root for everything Alpha stores on this machine.
 *
 * Overridable because these paths are resolved once at import time, which
 * otherwise leaves any service that touches the filesystem — the persona files
 * and memory tiers especially — with no way to be exercised except against the
 * real `~/.alpha`. Tests point this at a temp directory; it also lets an
 * operator relocate the store off a synced home directory.
 */
export const ALPHA_DIR = process.env.ALPHA_HOME || path.join(os.homedir(), '.alpha');
export const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ALPHA_DIR, 'alpha.db');
export const LOGS_DIR = path.join(ALPHA_DIR, 'logs');
export const AUDIT_LOG_PATH = path.join(LOGS_DIR, 'audit.log');
export const MEMORY_DIR = path.join(ALPHA_DIR, 'memory');
export const RUNS_DIR = path.join(ALPHA_DIR, 'runs');
// Hand-editable persona files, one per agent: `<id>.md`. The SQLite `agents`
// table stays the system of record for structured config; these files own the
// system prompt prose and override the columns they declare. See agentFileService.
export const AGENTS_DIR = path.join(ALPHA_DIR, 'agents');
// Working copies of repositories Alpha created or cloned. One allowlisted root
// keeps every agent-writable path in a single place that is easy to reason about.
export const WORKSPACES_DIR = path.join(ALPHA_DIR, 'workspaces');

export const CORS_ORIGIN = process.env.CORS_ORIGIN || [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].join(',');

// Supabase Configuration (team / cloud mode)
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// GitHub OAuth & Hosted Cloud Configuration
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
export const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3001/api/github/callback';
export const GITHUB_SCOPE = process.env.GITHUB_SCOPE || 'repo,workflow,read:org';

// GitHub App Configuration
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
export const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '';
export const GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET || '';
export const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || 'alpha-agentic-orchestrator';
