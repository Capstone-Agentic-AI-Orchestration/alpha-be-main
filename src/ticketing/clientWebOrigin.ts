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
