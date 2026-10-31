/**
 * The environment for anything the daemon spawns.
 *
 * Children run project code: an agent's shell, npm ci for verification, an MCP
 * server, a CLI version probe. None of them needs the secrets that make the
 * daemon the daemon, and any of them can print or post its environment. The
 * desktop keeps its local token out of process.env altogether; this is the
 * second line for source runs, where it comes from .env.
 *
 * Removed outright rather than blanked: nothing downstream should be able to
 * tell these existed.
 */
export const DAEMON_ONLY_ENV = [
  'ALPHA_LOCAL_TOKEN',
  'ALPHA_SESSION_SECRET',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GITHUB_CLIENT_SECRET'
] as const;

export function childProcessEnv(
  overlay: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, ...overlay };
  for (const key of DAEMON_ONLY_ENV) delete env[key];
  return env;
}
