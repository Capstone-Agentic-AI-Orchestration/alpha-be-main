import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Project } from '../models/index.js';
import { database } from '../store/database.js';
import { projectStore } from '../store/stores.js';
import { getHostingStatus, renderClient, vercelClient } from './hosting/hostingService.js';
import { hostedName, hostedTargetsFor } from './monorepoApps.js';
import { parseRepoRef } from './githubIssueMapping.js';
import { logError, logInfo } from '../utils/logger.js';
import { IS_CLOUD } from '../config/env.js';
import { incidentTransition, isDeploymentInImportWindow } from './operationsLogic.js';

const INTERVAL_MS = 60_000;
const DISCOVERY_MS = 10 * 60_000;
const IMPORT_MS = 6 * 60 * 60_000;

interface Target {
  id: string; workspace_id: string; project_id: string; repository: string; environment: 'production' | 'staging';
  kind: 'service' | 'domain'; provider: 'render' | 'vercel'; url: string; check_path: string; availability_target: number | null;
}

function targetId(workspaceId: string, projectId: string, repo: string, environment: string, kind: string, url: string): string {
  const digest = createHash('sha256').update([workspaceId, projectId, repo, environment, kind, url].join('\n')).digest('hex').slice(0, 32);
  return `target-${digest}`;
}

function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

async function upsertTarget(input: Omit<Target, 'availability_target'>, productionTarget: number): Promise<void> {
  await database().query(`insert into alpha_private.ops_monitored_targets
      (id,workspace_id,project_id,repository,environment,kind,provider,url,check_path,availability_target,enabled,last_seen_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,now(),now())
    on conflict(workspace_id,project_id,repository,environment,kind,url) do update set
      check_path=excluded.check_path,availability_target=case when excluded.environment='production'
        then coalesce(alpha_private.ops_monitored_targets.availability_target,excluded.availability_target) else null end,
      enabled=true,last_seen_at=now(),updated_at=now()`,
  [input.id,input.workspace_id,input.project_id,input.repository,input.environment,input.kind,input.provider,input.url,input.check_path,
    input.environment === 'production' ? productionTarget : null]);
}

async function discoverWorkspace(workspaceId: string, projects: Project[]): Promise<void> {
  const sql = database();
  const settingsResult = await sql.query<any>(`insert into alpha_private.ops_workspace_settings(workspace_id)
    values($1) on conflict(workspace_id) do update set updated_at=now()
    returning production_availability_target,last_deployment_import_at`, [workspaceId]);
  const targetPercent = Number(settingsResult.rows[0]?.production_availability_target ?? 99.9);
  const discovered = new Set<string>();

  for (const project of projects.filter(item => item.status === 'in_progress')) {
    for (const resource of project.resources ?? []) {
      if (resource.type !== 'github_repo') continue;
      const parsed = parseRepoRef(resource.pathOrUrl);
      if (!parsed) continue;
      const repository = `${parsed.owner}/${parsed.repo}`;
      // One hosted target per app: a single-app repository has one, a monorepo two.
      for (const target of hostedTargetsFor(project, repository)) {
      try {
      const status = await getHostingStatus({
        repo: repository, project, ...(target.stack ? { stackHint: target.stack } : {}), ...(target.app ? { app: target.app } : {})
      });
      if (status.state !== 'ready' && status.state !== 'partial') continue;
      const platform = status.platform;
      if (!platform) continue;
      const environmentFor = (branch: string) => branch === 'main' ? 'production' : branch === 'uat' ? 'staging' : null;
      for (const environment of status.environments) {
        const mapped = environmentFor(environment.branch);
        const url = httpsUrl(environment.url);
        if (!mapped || !url) continue;
        const kind = platform === 'render' ? 'service' : 'domain';
        const path = kind === 'service' ? '/health' : '/';
        const id = targetId(workspaceId, project.id, repository, mapped, kind, url);
        await upsertTarget({ id, workspace_id: workspaceId, project_id: project.id, repository, environment: mapped,
          kind, provider: platform, url, check_path: path }, targetPercent);
        discovered.add(id);
      }

      // Provider assigned custom and default domains only. A name mentioned in
      // project copy is never made a check target; z.com appears only here.
      if (platform === 'vercel') {
        const client = vercelClient();
        const vercelProject = await client?.findProjectByName(hostedName(repository, target.app));
        if (!client || !vercelProject) continue;
        const [domains, productionDomain] = await Promise.all([
          client.listDomains(vercelProject.id), client.productionDomain(vercelProject.id)
        ]);
        const allDomains = [...domains.map(domain => ({ name: domain.name, branch: domain.gitBranch ?? null }))];
        if (productionDomain && !allDomains.some(domain => domain.name === productionDomain)) allDomains.push({ name: productionDomain, branch: null });
        for (const domain of allDomains) {
          const mapped = domain.branch == null ? 'production' : domain.branch === 'uat' ? 'staging' : null;
          if (!mapped) continue;
          const url = httpsUrl(domain.name);
          if (!url) continue;
          const id = targetId(workspaceId, project.id, repository, mapped, 'domain', url);
          await upsertTarget({ id, workspace_id: workspaceId, project_id: project.id, repository, environment: mapped,
            kind: 'domain', provider: 'vercel', url, check_path: '/' }, targetPercent);
          discovered.add(id);
        }
      }
      } catch (error) {
        logError(`Operations target discovery failed for ${repository} (${workspaceId}):`, error);
      }
      }
    }
  }
  // An unavailable provider is not evidence that its previously configured
  // target was removed. Stale targets age out after seven days without a
  // successful discovery instead of being dropped on a transient API error.
  await sql.query(`update alpha_private.ops_monitored_targets set enabled=false,updated_at=now()
    where workspace_id=$1 and enabled and last_seen_at < now()-interval '7 days'`, [workspaceId]);
  if (discovered.size > 0) logInfo(`Operations discovery found ${discovered.size} service/domain targets for ${workspaceId}.`);
  await sql.query(`update alpha_private.ops_workspace_settings set last_target_discovery_at=now(),updated_at=now() where workspace_id=$1`, [workspaceId]);
}

async function importDeployments(workspaceId: string, projects: Project[]): Promise<void> {
  const sql = database();
  const settings = await sql.query<any>(`select last_deployment_import_at from alpha_private.ops_workspace_settings where workspace_id=$1`, [workspaceId]);
  const lastImport = settings.rows[0]?.last_deployment_import_at ? Date.parse(settings.rows[0].last_deployment_import_at) : 0;
  if (Date.now() - lastImport < IMPORT_MS) return;
  const now = Date.now();
  let importComplete = true;

  for (const project of projects.filter(item => item.status === 'in_progress')) {
    for (const resource of project.resources ?? []) {
      if (resource.type !== 'github_repo') continue;
      const parsed = parseRepoRef(resource.pathOrUrl);
      if (!parsed) continue;
      const repo = `${parsed.owner}/${parsed.repo}`;
      for (const target of hostedTargetsFor(project, repo)) {
      try {
      const status = await getHostingStatus({
        repo, project, ...(target.stack ? { stackHint: target.stack } : {}), ...(target.app ? { app: target.app } : {})
      });
      if (status.state !== 'ready' && status.state !== 'partial') {
        if (status.state === 'failed' || status.state === 'unavailable') importComplete = false;
        continue;
      }

      if (status.platform === 'render') {
        const client = renderClient();
        if (!client) continue;
        const name = hostedName(repo, target.app);
        for (const [environment, serviceName] of [['production', name], ['staging', `${name}-uat`]] as const) {
          const service = await client.findServiceByName(serviceName);
          if (!service) continue;
          const deployments = await client.listDeploys(service.id, 100);
          for (const deployment of deployments) {
            const startedAt = deployment.createdAt ?? new Date().toISOString();
            if (!isDeploymentInImportWindow(startedAt, now)) continue;
            await storeDeployment({ workspaceId, project, repo, provider: 'render', providerId: deployment.id, environment,
              status: deployment.status, branch: environment === 'production' ? 'main' : 'uat', sha: deployment.commit?.id,
              message: deployment.commit?.message, url: service.serviceDetails?.url, startedAt, finishedAt: deployment.finishedAt });
          }
        }
      } else if (status.platform === 'vercel') {
        const client = vercelClient();
        const hostedProject = await client?.findProjectByName(hostedName(repo, target.app));
        if (!client || !hostedProject) continue;
        for (const [environment, scope] of [['production', { production: true }], ['staging', { branch: 'uat' }]] as const) {
          const deployments = await client.listDeployments(hostedProject.id, scope, 100);
          for (const deployment of deployments) {
            const startedAt = deployment.createdAt ? new Date(deployment.createdAt).toISOString() : new Date().toISOString();
            if (!isDeploymentInImportWindow(startedAt, now)) continue;
            await storeDeployment({ workspaceId, project, repo, provider: 'vercel', providerId: deployment.uid, environment,
              status: deployment.readyState ?? deployment.state ?? 'unknown', branch: deployment.meta?.githubCommitRef ?? (environment === 'production' ? 'main' : 'uat'),
              sha: deployment.meta?.githubCommitSha, message: deployment.meta?.githubCommitMessage,
              url: httpsUrl(deployment.url), createdBy: deployment.meta?.githubCommitAuthorLogin, startedAt });
          }
        }
      }
      } catch (error) {
        importComplete = false;
        logError(`Operations deployment import failed for ${repo} (${workspaceId}):`, error);
      }
      }
    }
  }
  if (importComplete) {
    await sql.query(`insert into alpha_private.ops_workspace_settings(workspace_id,last_deployment_import_at)
      values($1,now()) on conflict(workspace_id) do update set last_deployment_import_at=now(),updated_at=now()`, [workspaceId]);
  }
}

async function storeDeployment(input: {
  workspaceId: string; project: Project; repo: string; provider: 'render' | 'vercel'; providerId: string;
  environment: 'production' | 'staging'; status: string; branch?: string; sha?: string; message?: string;
  url?: string | null; createdBy?: string; startedAt: string; finishedAt?: string;
}): Promise<void> {
  const id = `${input.provider}-${createHash('sha256').update(input.providerId).digest('hex').slice(0, 24)}`;
  await database().query(`insert into alpha_private.ops_deployments
    (id,workspace_id,project_id,repository,provider,provider_deployment_id,environment,status,branch,commit_sha,commit_message,deployment_url,created_by,started_at,finished_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    on conflict(workspace_id,provider,provider_deployment_id) do update set status=excluded.status,
      commit_sha=coalesce(excluded.commit_sha,alpha_private.ops_deployments.commit_sha),
      commit_message=coalesce(excluded.commit_message,alpha_private.ops_deployments.commit_message),
      deployment_url=coalesce(excluded.deployment_url,alpha_private.ops_deployments.deployment_url),
      finished_at=coalesce(excluded.finished_at,alpha_private.ops_deployments.finished_at)`,
  [id,input.workspaceId,input.project.id,input.repo,input.provider,input.providerId,input.environment,input.status,input.branch ?? null,
    input.sha ?? null,input.message ?? null,input.url ?? null,input.createdBy ?? null,input.startedAt,input.finishedAt ?? null]);
}

async function probeTarget(target: Target): Promise<void> {
  const started = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  let ok = false;
  try {
    const response = await fetch(new URL(target.check_path, target.url), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Alpha-Operations-Monitor/1.0' } });
    statusCode = response.status;
    ok = response.status >= 200 && response.status < 400;
    if (!ok) error = `HTTP ${response.status}`;
    void response.body?.cancel().catch(() => undefined);
  } catch (cause) {
    error = cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500);
  }
  const checkedAt = new Date().toISOString();
  const latency = Math.max(0, Date.now() - started);
  const sql = database();
  await sql.query(`insert into alpha_private.ops_probe_samples(workspace_id,target_id,checked_at,ok,status_code,latency_ms,error)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(target_id,checked_at) do nothing`,
  [target.workspace_id,target.id,checkedAt,ok,statusCode,latency,error]);

  const recent = await sql.query<any>(`select ok from alpha_private.ops_probe_samples where workspace_id=$1 and target_id=$2 order by checked_at desc limit 2`, [target.workspace_id,target.id]);
  if (recent.rows.length < 2) return;
  const openRows = await sql.query<any>(`select id from alpha_private.ops_incidents where workspace_id=$1 and target_id=$2 and resolved_at is null limit 1`, [target.workspace_id,target.id]);
  const action = incidentTransition(recent.rows, openRows.rows.length > 0);
  if (action === 'open') {
    const incident = await sql.query<any>(`insert into alpha_private.ops_incidents(id,workspace_id,target_id,started_at,last_error)
      select $1,$2,$3,$4,$5 where not exists(select 1 from alpha_private.ops_incidents where target_id=$3 and resolved_at is null)
      returning id`, [`incident-${randomUUID()}`,target.workspace_id,target.id,checkedAt,error]);
    if (incident.rows[0]) await createIncidentNotifications(target, incident.rows[0].id, false);
  } else if (openRows.rows.length && !ok && !recent.rows.every(row => row.ok === true)) {
    await sql.query(`update alpha_private.ops_incidents set last_error=$2 where workspace_id=$1 and target_id=$3 and resolved_at is null`,
      [target.workspace_id,error,target.id]);
  } else if (action === 'resolve') {
    const resolved = await sql.query<any>(`update alpha_private.ops_incidents set resolved_at=$3,last_error=null
      where workspace_id=$1 and target_id=$2 and resolved_at is null returning id`, [target.workspace_id,target.id,checkedAt]);
    for (const row of resolved.rows) await createIncidentNotifications(target, row.id, true);
  }
}

async function createIncidentNotifications(target: Target, incidentId: string, resolved: boolean): Promise<void> {
  const label = target.kind === 'domain' ? 'Domain' : 'Service';
  const title = resolved ? `${label} recovered` : `${label} outage detected`;
  const message = resolved ? `${target.url} has passed two consecutive health checks.` : `${target.url} failed two consecutive health checks.`;
  await database().query(`insert into alpha_private.ops_notifications(id,workspace_id,user_id,incident_id,event_type,title,message)
    select 'ops-notice-' || $1 || '-' || m.user_id,$2,m.user_id,$1,$3,$4,$5
    from public.workspace_members m where m.workspace_id=$2 and m.role='admin' and m.status='active'
    on conflict(user_id,incident_id,event_type) do nothing`,
  [incidentId,target.workspace_id,resolved ? 'resolved' : 'opened',title,message]);
}

async function tick(): Promise<void> {
  const sql = database();
  const lease = await sql.query(`insert into alpha_private.ops_worker_leases(name,locked_until,updated_at)
    values('operations-monitor',now()+interval '55 seconds',now())
    on conflict(name) do update set locked_until=now()+interval '55 seconds',updated_at=now()
    where alpha_private.ops_worker_leases.locked_until < now() returning name`);
  if (!lease.rows.length) return;

  const heartbeat = setInterval(() => {
    void sql.query(`update alpha_private.ops_worker_leases set locked_until=now()+interval '55 seconds',updated_at=now()
      where name='operations-monitor'`).catch(error => logError('Could not renew the Operations worker lease:', error));
  }, 15_000);
  try {
    const workspaces = await sql.query<{ id: string }>(`select id from public.workspaces where status='active' order by id`);
    for (const { id: workspaceId } of workspaces.rows) {
      try {
        const projects = await projectStore().list(workspaceId);
        const existing = await sql.query<any>(`select last_target_discovery_at from alpha_private.ops_workspace_settings where workspace_id=$1`, [workspaceId]);
        if (!existing.rows[0]?.last_target_discovery_at || Date.now() - Date.parse(existing.rows[0].last_target_discovery_at) >= DISCOVERY_MS) {
          await discoverWorkspace(workspaceId, projects);
        }
        await importDeployments(workspaceId, projects);
        const targets = await sql.query<Target>(`select * from alpha_private.ops_monitored_targets where workspace_id=$1 and enabled order by id`, [workspaceId]);
        const probes = await Promise.allSettled(targets.rows.map(target => probeTarget(target)));
        probes.forEach((result, index) => {
          if (result.status === 'rejected') {
            logError(`Operations probe persistence failed for ${targets.rows[index].url} (${workspaceId}):`, result.reason);
          }
        });
        await sql.query(`delete from alpha_private.ops_probe_samples where workspace_id=$1 and checked_at < now()-interval '90 days'`, [workspaceId]);
        await sql.query(`delete from alpha_private.ops_incidents where workspace_id=$1 and resolved_at < now()-interval '90 days'`, [workspaceId]);
      } catch (error) {
        logError(`Operations monitoring failed for workspace ${workspaceId}:`, error);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** One cloud instance performs the minute probes; a Postgres lease prevents duplicate probes across replicas. */
export function startOperationsMonitoringWorker(server?: Server): () => void {
  if (!IS_CLOUD) return () => undefined;
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void tick().catch(error => logError('Operations monitoring worker failed:', error));
  };
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); };
  server?.once('close', stop);
  logInfo('Operations monitoring worker scheduled at one-minute intervals.');
  return stop;
}
