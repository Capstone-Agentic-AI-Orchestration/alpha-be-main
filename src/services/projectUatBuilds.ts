import type { TransactionalSql } from '../store/database.js';
import { PostgresProjectStore } from '../store/postgresProjectStore.js';
import { parseRepoRef, reposForProject } from './githubIssueMapping.js';
import { resolveStack, roleForStack, renderClient, vercelClient } from './hosting/hostingService.js';
import { UrlEmbeddabilityProbe } from './hosting/embeddability.js';
import type { ProjectTarget } from './clientProjectPortal.js';
import { uatError, type UatBuild, type UatBuildPart } from '../ticketing/projectUat.js';
import type { Project } from '../models/index.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

export interface ProjectUatBuilds {
  targets(target: ProjectTarget): Promise<Array<{repository: string}>>;
  resolve(target: ProjectTarget, repository: string): Promise<UatBuild>;
}
const probe = new UrlEmbeddabilityProbe();
function verifiedSha(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{40,64}$/i.test(value)) uatError(409,'uat_provenance_missing','This UAT deployment has no verified source commit.');
  return value.toLowerCase();
}
function publicUrl(value: string | undefined, suffix: string): string {
  let url: URL;
  try { url = new URL(value?.startsWith('https://') ? value : `https://${value}`); }
  catch { return uatError(409,'uat_preview_unavailable','The UAT preview address is unavailable.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith(suffix)
    || url.pathname !== '/' || url.search || url.hash) uatError(409,'uat_preview_unavailable','The provider returned an unsupported preview address.');
  return url.origin;
}
export function createProjectUatBuilds(db: TransactionalSql): ProjectUatBuilds {
  async function project(target: ProjectTarget): Promise<Project> {
    const value = await new PostgresProjectStore(db).get(target.workspaceId,target.projectId);
    if (!value) uatError(404,'client_project_unavailable','This project is unavailable.');
    return value;
  }
  function role(value: Project, repo: string) {
    const stack = resolveStack({project:value,repo});
    return stack ? roleForStack(stack) : null;
  }
  return {
    async targets(target) {
      const value = await project(target);
      return reposForProject(value).filter(repo => role(value,repo)==='frontend').map(repository => ({repository}));
    },
    async resolve(target, repository) {
      try {
      const value = await project(target);
      const repositories = reposForProject(value);
      if (!repositories.includes(repository) || role(value,repository)!=='frontend') uatError(404,'uat_target_unavailable','Choose a frontend attached to this project.');
      const client = vercelClient();
      if (!client) uatError(503,'uat_provider_unavailable','Vercel is not configured for UAT verification.');
      const [owner,name] = repository.split('/');
      const host = await client.findProjectByName(name);
      if (!host || host.link?.type!=='github' || host.link.org?.toLowerCase()!==owner.toLowerCase()
        || host.link.repo?.toLowerCase()!==name.toLowerCase()) uatError(409,'uat_repository_mismatch','The frontend deployment is not linked to this project repository.');
      const deploy = await client.latestDeployment(host.id,{branch:'uat'});
      if (!deploy || !/^(ready)$/i.test(deploy.state ?? deploy.readyState ?? '') || deploy.meta?.githubCommitRef!=='uat') {
        uatError(409,'uat_deployment_not_ready','A ready deployment from the uat branch is required.');
      }
      const frontend: UatBuildPart = {repository,branch:'uat',deploymentId:deploy.uid,
        commitSha:verifiedSha(deploy.meta?.githubCommitSha),url:publicUrl(deploy.url,'.vercel.app')};
      const backends: UatBuildPart[] = [];
      for (const repo of repositories.filter(repo => role(value,repo)==='backend')) {
        const render = renderClient();
        if (!render) uatError(503,'uat_provider_unavailable','Render is required to verify this project’s UAT API.');
        const service = await render.findServiceByName(`${repo.split('/')[1]}-uat`);
        const source = service?.repo ? parseRepoRef(service.repo) : null;
        if (!service || service.branch!=='uat' || `${source?.owner}/${source?.repo}`.toLowerCase()!==repo.toLowerCase()) {
          uatError(409,'uat_backend_unverified','The project’s UAT API service could not be verified.');
        }
        const deployment = await render.latestDeploy(service.id);
        if (!deployment || deployment.status!=='live') uatError(409,'uat_backend_not_ready','The project’s UAT API is not ready.');
        backends.push({repository:repo,branch:'uat',deploymentId:deployment.id,commitSha:verifiedSha(deployment.commit?.id),
          url:publicUrl(service.serviceDetails?.url,'.onrender.com')});
      }
      const verdict = await probe.check(frontend.url);
      return {frontend,backends,verifiedAt:new Date().toISOString(),embeddable:verdict.embeddable===true,reason:verdict.reason};
      } catch(error) {
        if(error instanceof TicketWorkflowError)throw error;
        uatError(503,'uat_provider_unavailable','The hosting provider could not verify this project’s UAT build. Try again.');
      }
    },
  };
}
