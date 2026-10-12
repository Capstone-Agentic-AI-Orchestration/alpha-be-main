/**
 * Resolve the browser app origin from the existing exact CORS allowlist.
 *
 * The exact CORS allowlist is the deployment-owned source of browser origins.
 * ALPHA_CLOUD_API is an optional hint: the cloud does not need its desktop
 * relay setting, and an API proxy can share the website's origin on Vercel.
 * Never infer the destination from a request header or a wildcard origin.
 */
export function resolveClientWebOrigin(corsOrigins: string, cloudApi = ''): string | null {
  let apiOrigin: string | undefined;
  if (cloudApi.trim()) {
    try {
      const api = new URL(cloudApi);
      if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash
        || api.pathname.replace(/\/$/, '') !== '/api') return null;
      apiOrigin = api.origin;
    } catch { return null; }
  }

  const candidates = new Set<string>();
  for (const entry of corsOrigins.split(',').map(value => value.trim()).filter(Boolean)) {
    if (entry.includes('*')) continue;
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' || url.origin !== entry || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) continue;
      candidates.add(url.origin);
    } catch { /* Wildcard and malformed patterns are not canonical browser origins. */ }
  }

  // A single exact browser origin remains valid when it also proxies /api.
  if (candidates.size === 1) return [...candidates][0];
  // Preserve deployments that explicitly allow both a separate API host and
  // one browser host. Multiple browser candidates must still fail closed.
  if (apiOrigin) candidates.delete(apiOrigin);
  return candidates.size === 1 ? [...candidates][0] : null;
}

/** Server-log diagnostics only: never return credentials or expose this through a public API. */
export function clientAccessConfigurationProblems(config: {
  webOrigin: string | null;
  originAllowed: boolean;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  sessionSecret: string;
  emailConfigured: boolean;
}): string[] {
  const problems: string[] = [];
  if (!config.webOrigin || !config.originAllowed) problems.push('one exact HTTPS browser origin in CORS_ORIGIN');
  try {
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { problems.push('valid HTTPS SUPABASE_URL'); }
  if (!config.supabaseAnonKey.trim()) problems.push('SUPABASE_ANON_KEY');
  if (!config.supabaseServiceRoleKey.trim()) problems.push('server-only SUPABASE_SERVICE_ROLE_KEY');
  if (config.sessionSecret.length < 32) problems.push('existing ALPHA_SESSION_SECRET of at least 32 characters (do not rotate it to troubleshoot)');
  if (!config.emailConfigured) problems.push('valid server-side Resend sender settings');
  return problems;
}
