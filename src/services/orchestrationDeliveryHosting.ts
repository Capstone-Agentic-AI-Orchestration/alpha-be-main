import { renderClient, vercelClient } from './hosting/hostingService.js';
import { sameRepository } from '../utils/repositoryName.js';
import type { DeliveryRepository } from './orchestrationDelivery.js';
import { DeliveryError } from './orchestrationDelivery.js';
import { hostedName } from './monorepoApps.js';

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

/** What a platform says is deployed from `uat`, before it is checked against the expected commit. */
interface DeploymentEvidence { sha: string; status: string; rawUrl: string; backend: boolean }

/** The Render service `serviceName`'s latest deploy; null when there is no such service. */
async function renderEvidence(target: DeliveryRepository, serviceName: string): Promise<DeploymentEvidence | null> {
  const render = renderClient();
  const service = await render?.findServiceByName(serviceName);
  if (!service) return null;
  if (!service.repo || !sameRepository(service.repo, target.repository) || service.branch !== 'uat') {
    throw new DeliveryError('The Render service does not match this repository and UAT branch.');
  }
  const latest = (await render!.listDeploys(service.id, 1))[0];
  return { sha: latest?.commit?.id ?? '', status: latest?.status ?? 'pending', rawUrl: service.serviceDetails?.url ?? '', backend: true };
}

/** The Vercel project `projectName`'s latest uat deployment; null when there is no such project. */
async function vercelEvidence(target: DeliveryRepository, projectName: string): Promise<DeploymentEvidence | null> {
  const vercel = vercelClient();
  const project = await vercel?.findProjectByName(projectName);
  if (!project || !vercel) return null;
  const linked = project.link?.repo?.includes('/') ? project.link.repo : `${project.link?.org}/${project.link?.repo}`;
  if (linked.toLowerCase() !== target.repository.toLowerCase()) throw new DeliveryError('The Vercel project belongs to a different repository.');
  const latest = (await vercel.listDeployments(project.id, { branch: 'uat' }, 1))[0];
  if (latest?.meta?.githubCommitRef !== 'uat') throw new DeliveryError('The deployment has no verified UAT branch identity.');
  return { sha: latest.meta.githubCommitSha ?? '', status: latest.readyState ?? latest.state ?? 'pending', rawUrl: latest.url ?? '', backend: false };
}

/**
 * The repository's UAT deployment, verified: on the expected commit, live, and answering.
 *
 * A single-app repository has one deployment, found by its own name. A
 * monorepo has two -- `name-api-uat` on Render and `name-web` on Vercel -- and
 * both must run the UAT commit; the API is checked first, and the frontend's
 * address is the one reported once both pass.
 */
export async function verifyDeliveryDeployment(target: DeliveryRepository,
  fetcher: typeof fetch = fetch): Promise<NonNullable<DeliveryRepository['deployment']>> {
  const name = target.repository.split('/')[1];
  const single = (await renderEvidence(target, `${name}-uat`)) ?? (await vercelEvidence(target, name));
  if (single) return checkDeployment(target, single, fetcher);

  const api = await renderEvidence(target, `${hostedName(target.repository, 'api')}-uat`);
  const web = await vercelEvidence(target, hostedName(target.repository, 'web'));
  if (!api || !web) throw new DeliveryError(`${target.repository}: UAT hosting evidence is unavailable.`);
  const apiResult = await checkDeployment(target, api, fetcher);
  // Still deploying: report the API's progress until it is verified.
  if (!apiResult.verifiedAt) return apiResult;
  return checkDeployment(target, web, fetcher);
}

async function checkDeployment(target: DeliveryRepository, evidence: DeploymentEvidence,
  fetcher: typeof fetch): Promise<NonNullable<DeliveryRepository['deployment']>> {
  const { sha, status, rawUrl, backend } = evidence;
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
