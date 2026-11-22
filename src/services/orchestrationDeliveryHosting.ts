import { renderClient, vercelClient } from './hosting/hostingService.js';
import { sameRepository } from '../utils/repositoryName.js';
import type { DeliveryRepository } from './orchestrationDelivery.js';
import { DeliveryError } from './orchestrationDelivery.js';

/** Provider-issued URLs only. No renderer/model supplied fetch target or redirects. */
export function deliverySmokeUrl(raw: string, backend: boolean): URL {
  const url = new URL(raw.startsWith('https://') ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(backend ? url.hostname.endsWith('.onrender.com') : url.hostname.endsWith('.vercel.app'))) {
    throw new DeliveryError('UAT verification requires a provider-issued HTTPS deployment URL.');
  }
  url.pathname = backend ? '/health' : '/'; url.search = ''; url.hash = '';
  return url;
}

export async function verifyDeliveryDeployment(target: DeliveryRepository,
  fetcher: typeof fetch = fetch): Promise<NonNullable<DeliveryRepository['deployment']>> {
  const name = target.repository.split('/')[1];
  const render = renderClient();
  const vercel = vercelClient();
  const service = await render?.findServiceByName(`${name}-uat`);
  let sha = ''; let status = 'pending'; let rawUrl = ''; let backend = false;
  if (service) {
    if (!service.repo || !sameRepository(service.repo, target.repository) || service.branch !== 'uat') {
      throw new DeliveryError('The Render service does not match this repository and UAT branch.');
    }
    const latest = (await render!.listDeploys(service.id, 1))[0];
    sha = latest?.commit?.id ?? ''; status = latest?.status ?? 'pending';
    rawUrl = service.serviceDetails?.url ?? ''; backend = true;
  } else {
    const project = await vercel?.findProjectByName(name);
    if (!project || !vercel) throw new DeliveryError(`${target.repository}: UAT hosting evidence is unavailable.`);
    const linked = project.link?.repo?.includes('/') ? project.link.repo : `${project.link?.org}/${project.link?.repo}`;
    if (linked.toLowerCase() !== target.repository.toLowerCase()) throw new DeliveryError('The Vercel project belongs to a different repository.');
    const latest = (await vercel.listDeployments(project.id, { branch: 'uat' }, 1))[0];
    if (latest?.meta?.githubCommitRef !== 'uat') throw new DeliveryError('The deployment has no verified UAT branch identity.');
    sha = latest.meta.githubCommitSha ?? ''; status = latest.readyState ?? latest.state ?? 'pending';
    rawUrl = latest.url ?? '';
  }
  if (sha !== target.uatHead) throw new DeliveryError(`${target.repository}: the latest deployment does not match the expected UAT commit.`);
  if (['build_failed', 'update_failed', 'pre_deploy_failed', 'deactivated', 'ERROR', 'CANCELED', 'canceled'].includes(status)) {
    throw new DeliveryError(`${target.repository}: the UAT deployment failed.`);
  }
  if (!['live', 'READY'].includes(status)) return { sha, status, url: '' };
  const url = deliverySmokeUrl(rawUrl, backend);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: backend ? 'application/json' : 'text/html' } });
  try {
    if (!response.ok) throw new DeliveryError(`${target.repository}: UAT HTTP smoke check failed (${response.status}).`);
    if (!backend && !response.headers.get('content-type')?.includes('text/html')) {
      throw new DeliveryError(`${target.repository}: the frontend did not return an HTML page.`);
    }
  } finally { await response.body?.cancel(); }
  return { sha, status, url: url.toString(), verifiedAt: new Date().toISOString() };
}
