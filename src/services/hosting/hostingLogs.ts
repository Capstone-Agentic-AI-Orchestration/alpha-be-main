import type { DeploymentLogsQuery, DeploymentLogsResponse, LogFilterKey } from './deploymentLogs.js';
import {
  isAlphaManagedKey,
  platformForStack,
  renderClient,
  renderServiceNames,
  resolveStack,
  vercelClient,
  type HostingBranch,
  type HostingContext
} from './hostingService.js';
import { redactLogLines } from './redactLogs.js';
import { assertSafeBranchName } from '../../utils/gitUtils.js';

/**
 * One page of a hosted branch's logs: a backend's Render service, or the
 * newest deployment of a frontend's branch on Vercel.
 *
 * The answer always says where it came from: `live` with the lines, or
 * `unavailable` with the reason -- never an empty `live` standing in for a
 * platform that could not be read, which would read as "nothing happened".
 */

/** The filters each platform can apply; the view offers only these. */
const RENDER_FILTERS: LogFilterKey[] = ['level', 'type', 'text', 'instance'];
const VERCEL_FILTERS: LogFilterKey[] = ['level', 'type', 'text'];

const PIPELINE_BRANCHES: readonly HostingBranch[] = ['main', 'uat', 'dev'];

function unavailable(reason: string, filters: LogFilterKey[] = []): DeploymentLogsResponse {
  return { source: 'unavailable', reason, logs: [], hasMore: false, next: null, filters };
}

export async function getHostingLogs(
  ctx: HostingContext,
  branch: string | undefined,
  query: DeploymentLogsQuery
): Promise<DeploymentLogsResponse> {
  if (!branch) {
    return unavailable('Choose a branch: main, uat or dev.');
  }
  const stack = resolveStack(ctx);
  if (!stack) return unavailable(`Could not tell whether ${ctx.repo} is a backend or a frontend.`);
  const repoName = ctx.repo.split('/')[1];

  if (platformForStack(stack) === 'render') {
    if (!PIPELINE_BRANCHES.includes(branch as HostingBranch)) {
      return unavailable('Run-branch logs are not available for Render previews.', RENDER_FILTERS);
    }
    const client = renderClient();
    if (!client) return unavailable('Render is not configured on this server.', RENDER_FILTERS);
    if (branch === 'dev') return unavailable('Backends are hosted for main and uat only.', RENDER_FILTERS);
    try {
      const names = renderServiceNames(repoName);
      const service = await client.findServiceByName(branch === 'main' ? names.main : names.uat);
      if (!service) return unavailable(`${branch} is not hosted yet.`, RENDER_FILTERS);
      // Render's logs API is scoped by owner; a listing may leave it out.
      const ownerId = service.ownerId ?? (await client.getService(service.id)).ownerId;
      if (!ownerId) return unavailable('Render did not say which workspace owns this service.', RENDER_FILTERS);

      const [page, vars] = await Promise.all([
        client.queryLogs(ownerId, service.id, query),
        client.listEnvVars(service.id).catch(() => [])
      ]);
      const secrets = vars.filter(v => !isAlphaManagedKey(v.key)).map(v => v.value);
      return { source: 'live', logs: redactLogLines(page.logs, secrets), hasMore: page.hasMore, next: page.next, filters: RENDER_FILTERS };
    } catch (err) {
      return unavailable(`Could not read Render logs: ${(err as Error).message}`, RENDER_FILTERS);
    }
  }

  const client = vercelClient();
  if (!client) return unavailable('Vercel is not configured on this server.', VERCEL_FILTERS);
  try {
    assertSafeBranchName(branch);
  } catch {
    return unavailable('The requested branch name is not valid.', VERCEL_FILTERS);
  }
  try {
    const project = await client.findProjectByName(repoName);
    if (!project) return unavailable(`${ctx.repo} is not hosted yet.`, VERCEL_FILTERS);
    const linkedRepo = project.link?.repo?.includes('/') || !project.link?.org
      ? project.link?.repo ?? ''
      : `${project.link.org}/${project.link.repo}`;
    if (!linkedRepo || linkedRepo.toLowerCase() !== ctx.repo.toLowerCase()) {
      return unavailable('The Vercel project with this name is linked to a different repository.', VERCEL_FILTERS);
    }
    const [page, vars] = await Promise.all([
      client.queryLogs(project.id, branch === 'main' ? { production: true } : { branch }, {
        type: query.type,
        level: query.level,
        text: query.text
      }),
      client.listEnvVars(project.id).catch(() => [])
    ]);
    // Only `plain` variables come back with a value; `sensitive` ones never leave Vercel.
    const secrets = vars.filter(v => !isAlphaManagedKey(v.key)).map(v => v.value);
    return { source: 'live', logs: redactLogLines(page.logs, secrets), hasMore: false, next: null, filters: VERCEL_FILTERS };
  } catch (err) {
    return unavailable(`Could not read Vercel logs: ${(err as Error).message}`, VERCEL_FILTERS);
  }
}
