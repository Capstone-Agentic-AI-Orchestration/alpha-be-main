import { UrlEmbeddabilityProbe, type EmbeddabilityVerdict } from './embeddability.js';
import type { HostingBranch, HostingStatus } from './hostingService.js';

/**
 * What each branch of a hosted repository can show a person: a frontend's
 * page, inline when the site allows it, or -- for a backend, which has no
 * page -- its health.
 *
 * Embeddability is decided here, on the server, before anything is framed: a
 * browser fires no error when a site refuses to be framed, so a frame shown
 * on anything less than a positive answer would be an unexplained blank box.
 */

/** `page` renders the site; `health` offers a health check (and, later, logs) instead. */
export type PreviewSurface = 'page' | 'health';

export interface BranchPreview {
  branch: HostingBranch;
  /** The branch's stable address; never a single deploy's own hostname. */
  url: string | null;
  surface: PreviewSurface;
  /** The platform's own word for the latest deploy (`READY`, `live`, `BUILDING`...), or null. */
  deployStatus: string | null;
  /** Whether that latest deploy is live and serving. */
  ready: boolean;
  /** true: safe to frame; false: must not be framed (`reason` says why); null: unknown. */
  embeddable: boolean | null;
  reason: string | null;
}

export interface HostingPreviews {
  repo: string;
  role: HostingStatus['role'];
  platform: HostingStatus['platform'];
  state: HostingStatus['state'];
  error?: string;
  previews: BranchPreview[];
}

/** One probe for the process, so its five-minute verdict cache is shared by every caller. */
const sharedProbe = new UrlEmbeddabilityProbe();

/** Render says `live`, Vercel says `READY`; anything else is not serving this deploy yet. */
export function isDeployReady(status: string | null | undefined): boolean {
  return Boolean(status && /^(ready|live)$/i.test(status));
}

async function frontendVerdict(
  url: string | null,
  ready: boolean,
  probe: Pick<UrlEmbeddabilityProbe, 'check'>
): Promise<EmbeddabilityVerdict> {
  if (!url) return { embeddable: false, reason: 'This branch has no stable address yet.' };
  if (!ready) return { embeddable: null, reason: 'The latest deploy is not live yet.' };
  return probe.check(url);
}

export async function previewsFor(
  status: HostingStatus,
  probe: Pick<UrlEmbeddabilityProbe, 'check'> = sharedProbe
): Promise<HostingPreviews> {
  const surface: PreviewSurface = status.role === 'backend' ? 'health' : 'page';

  const previews = await Promise.all(
    status.environments.map(async (env): Promise<BranchPreview> => {
      const deployStatus = env.latestDeploy?.status ?? null;
      const ready = isDeployReady(deployStatus);
      // A backend is never probed here: a request would wake a sleeping
      // free-tier service just because someone opened the panel.
      const verdict: EmbeddabilityVerdict =
        surface === 'health' ? { embeddable: false, reason: null } : await frontendVerdict(env.url, ready, probe);
      return { branch: env.branch, url: env.url, surface, deployStatus, ready, ...verdict };
    })
  );

  return {
    repo: status.repo,
    role: status.role,
    platform: status.platform,
    state: status.state,
    ...(status.error ? { error: status.error } : {}),
    previews
  };
}
