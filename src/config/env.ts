import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';

dotenv.config();

export const PORT = Number(process.env.PORT || 3001);
// Loopback by default. 0.0.0.0 exposes an API that spawns shell commands to
// every device on the network; opt in explicitly if you really want that.
export const HOST = process.env.HOST || '127.0.0.1';

export const ALPHA_DIR = path.join(os.homedir(), '.alpha');
export const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ALPHA_DIR, 'alpha.db');
export const LOGS_DIR = path.join(ALPHA_DIR, 'logs');
export const AUDIT_LOG_PATH = path.join(LOGS_DIR, 'audit.log');
export const MEMORY_DIR = path.join(ALPHA_DIR, 'memory');
export const RUNS_DIR = path.join(ALPHA_DIR, 'runs');

export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:5173';

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
