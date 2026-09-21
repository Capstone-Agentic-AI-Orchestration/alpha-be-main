/**
 * The desktop's database token, fetched from the cloud rather than minted here.
 *
 * The desktop proves who it is with the machine's `gh` token and the cloud
 * decides what goes into the database token -- see `databaseTokenExchange.ts`
 * for why the desktop must not sign its own.
 *
 * Returns `null` on any failure. The caller then presents the anon key, and the
 * write fails at the database with a policy denial: a clear, safe outcome, and
 * the same one an unconfigured desktop has always had.
 */

export interface DatabaseTokenClientOptions {
  /** Base URL of the cloud API, e.g. `https://alpha-fe-main.vercel.app/api`. */
  cloudApi: string;
  /** The machine's GitHub token, or null when `gh` is missing or signed out. */
  githubToken: () => Promise<string | null>;
  /** The workspace the next request is for. */
  workspaceId: () => string;
  /** Reported once per failure burst by the caller's own throttle. */
  onFailure: (what: string, err: unknown) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Refresh this long before the token expires.
 *
 * The cloud is on Render's free tier and can take most of a minute to wake, so
 * a margin shorter than that would let the token lapse mid-refresh and a write
 * would go out anonymous. Two minutes of a ten-minute token is the price.
 */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** Long enough to outlast a cold start; short enough that a dead cloud is noticed. */
const EXCHANGE_TIMEOUT_MS = 90 * 1000;

interface Cached {
  token: string;
  expiresAt: number;
  workspaceId: string;
}

export class DatabaseTokenClient {
  private cached: Cached | null = null;
  /** One exchange per workspace at a time, however many requests are waiting. */
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly opts: DatabaseTokenClientOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async token(): Promise<string | null> {
    const workspaceId = this.opts.workspaceId();
    const cached = this.cached;
    if (
      cached &&
      cached.workspaceId === workspaceId &&
      this.now() < cached.expiresAt - REFRESH_MARGIN_MS
    ) {
      return cached.token;
    }

    let pending = this.inFlight.get(workspaceId);
    if (!pending) {
      pending = this.exchange(workspaceId).finally(() => this.inFlight.delete(workspaceId));
      this.inFlight.set(workspaceId, pending);
    }
    return pending;
  }

  private async exchange(workspaceId: string): Promise<string | null> {
    if (!this.opts.cloudApi) {
      this.opts.onFailure(
        'database token',
        new Error('ALPHA_CLOUD_API is not set, so the desktop cannot ask the cloud for a database token.')
      );
      return null;
    }

    const githubToken = await this.opts.githubToken();
    if (!githubToken) {
      this.opts.onFailure('database token', new Error('gh is not signed in, so there is no identity to present.'));
      return null;
    }

    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.cloudApi}/database/token/exchange`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${githubToken}`, 'X-Workspace-Id': workspaceId },
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(`cloud answered ${res.status}: ${detail}`);
      }

      const body = (await res.json()) as { token?: string; expiresAt?: string };
      const expiresAt = Date.parse(body.expiresAt ?? '');
      if (!body.token || Number.isNaN(expiresAt)) {
        throw new Error('cloud answered without a token and expiry.');
      }

      this.cached = { token: body.token, expiresAt, workspaceId };
      return body.token;
    } catch (err) {
      this.opts.onFailure('database token', err);
      return null;
    }
  }
}
