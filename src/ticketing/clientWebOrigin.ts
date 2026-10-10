/**
 * Resolve the browser app origin from the existing exact CORS allowlist.
 *
 * ALPHA_CLOUD_API is the API host (normally Render), not the website host
 * (Vercel). Client activation links must open the website so the SPA can
 * redeem the one-time proof and establish its first-party session.
 */
export function resolveClientWebOrigin(corsOrigins: string, cloudApi: string): string | null {
  let apiOrigin: string;
  try {
    const api = new URL(cloudApi);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash
      || api.pathname.replace(/\/$/, '') !== '/api') return null;
    apiOrigin = api.origin;
  } catch { return null; }

  const candidates = new Set<string>();
  for (const entry of corsOrigins.split(',').map(value => value.trim()).filter(Boolean)) {
    if (entry.includes('*')) continue;
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' || url.origin !== entry || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || url.origin === apiOrigin) continue;
      candidates.add(url.origin);
    } catch { /* Wildcard and malformed patterns are not canonical browser origins. */ }
  }

  return candidates.size === 1 ? [...candidates][0] : null;
}
