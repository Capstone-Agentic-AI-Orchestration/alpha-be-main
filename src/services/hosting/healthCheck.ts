/**
 * A backend's health, checked on request -- the one thing a backend preview
 * can show, since it has no page.
 *
 * Only ever run because a person asked: a free Render service sleeps, and
 * this request is what wakes it (which is also why the timeout is long enough
 * for a cold start). Only the platforms' own hosts are ever requested, so a
 * status that somehow carried another address cannot turn this server into
 * a proxy to it.
 */

const CHECKABLE_HOST_SUFFIXES = ['.onrender.com', '.vercel.app'];

/** A Render free instance can take most of a minute to wake. */
const HEALTH_TIMEOUT_MS = 75_000;

export interface HealthResult {
  url: string;
  ok: boolean;
  /** HTTP status, when the service answered at all. */
  status: number | null;
  latencyMs: number;
  error?: string;
}

export function isCheckableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && CHECKABLE_HOST_SUFFIXES.some(suffix => parsed.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

export async function checkHealth(
  baseUrl: string,
  path = '/health',
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<HealthResult> {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  if (!isCheckableUrl(url)) {
    return { url, ok: false, status: null, latencyMs: 0, error: 'Only Render and Vercel addresses are checked.' };
  }

  const started = Date.now();
  try {
    // No redirects followed: a health endpoint that redirects is not healthy,
    // and following one could leave the allowlisted host.
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { url, ok: res.status >= 200 && res.status < 300, status: res.status, latencyMs: Date.now() - started };
  } catch (err) {
    const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
    return {
      url,
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      error: timedOut ? `No answer within ${Math.round(timeoutMs / 1000)}s.` : `Could not reach the service: ${(err as Error).message}`
    };
  }
}
