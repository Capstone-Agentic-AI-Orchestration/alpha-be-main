/**
 * Render's REST API (`https://api.render.com/v1`), as a thin client.
 *
 * Every call here is a direct translation of one Render endpoint -- no
 * business logic, no knowledge of Alpha's naming conventions or of what a
 * "backend" or "uat" service is. That belongs in `hostingService`, which is
 * also the only caller with an opinion about what a failure *means* (a 404
 * here could be "no such service" or "the Render GitHub App cannot see this
 * repository", and only the caller knows which request it made). Keeping this
 * layer dumb is what makes it mockable with a single `fetchImpl` in tests --
 * nothing here reaches the network unless a caller hands it a real `fetch`.
 */

import { logError } from '../../utils/logger.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import { buildRenderLogsQueryParams, mapRenderLogsPage, type RenderLogsPage, type RenderLogsPayload, type RenderLogsQueryInput } from './renderLogs.js';

const RENDER_API_BASE = 'https://api.render.com/v1';

export class RenderApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Present on a 429; seconds to wait before the next attempt. */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'RenderApiError';
  }
}

export interface RenderOwner {
  id: string;
  type: string;
  name?: string;
  email?: string;
}

export interface RenderServiceDetails {
  url?: string;
  region?: string;
  plan?: string;
  healthCheckPath?: string;
  buildCommand?: string;
  startCommand?: string;
}

export interface RenderServiceRecord {
  id: string;
  name: string;
  type?: string;
  ownerId?: string;
  repo?: string;
  branch?: string;
  autoDeploy?: string;
  /** Present only when the create/update request asked for it and Render accepted it. */
  autoDeployTrigger?: string;
  /** The project environment the service belongs to; absent for an ungrouped service. */
  environmentId?: string;
  dashboardUrl?: string;
  serviceDetails?: RenderServiceDetails;
}

export interface RenderProject {
  id: string;
  name: string;
}

export interface RenderEnvironment {
  id: string;
  name: string;
  projectId?: string;
  /** What the environment holds -- absent when Render leaves a kind out. */
  serviceIds?: string[];
  databasesIds?: string[];
  redisIds?: string[];
  envGroupIds?: string[];
}

export interface RenderDeploy {
  id: string;
  status: string;
  createdAt?: string;
  finishedAt?: string;
  commit?: { id?: string; message?: string; author?: string };
}

export interface CreateRenderServiceInput {
  name: string;
  ownerId: string;
  /** `https://github.com/<owner>/<repo>` */
  repo: string;
  branch: string;
  /** Omitted from the request when absent, so Render applies its own default. */
  region?: string;
  healthCheckPath: string;
  buildCommand: string;
  startCommand: string;
  envVars?: Array<{ key: string; value: string }>;
  /** Creates the service inside this project environment; ungrouped when absent. */
  environmentId?: string;
  /**
   * Documented only for Blueprints and the dashboard, not this endpoint --
   * worth asking for anyway, since a service that redeploys once checks pass
   * is the better default. `createService` retries without it when Render
   * rejects the field, and reports whether it actually stuck.
   */
  autoDeployTrigger?: 'checksPass';
}

export interface RenderServiceSettings {
  buildCommand?: string;
  startCommand?: string;
  autoDeployTrigger?: 'checksPass' | 'commit' | 'off';
}

export interface RenderClient {
  listOwners(): Promise<RenderOwner[]>;
  /** `null` when Render has no service of that name (a fresh setup, or one deleted by hand). */
  findServiceByName(name: string): Promise<RenderServiceRecord | null>;
  getService(id: string): Promise<RenderServiceRecord>;
  /** Creates the service, retrying once without `autoDeployTrigger` if Render rejects it. */
  createService(input: CreateRenderServiceInput): Promise<{ service: RenderServiceRecord; deployId?: string }>;
  /** Does not trigger a deploy; call `triggerDeploy` after setting every variable. */
  setEnvVar(serviceId: string, key: string, value: string): Promise<void>;
  listEnvVars(serviceId: string): Promise<Array<{ key: string; value: string }>>;
  /** Remove one variable. Does not trigger a deploy. */
  deleteEnvVar(serviceId: string, key: string): Promise<void>;
  triggerDeploy(serviceId: string): Promise<{ id: string }>;
  /** `null` when the service has never deployed. */
  latestDeploy(serviceId: string): Promise<RenderDeploy | null>;
  /** Recent service deployments, newest first. */
  listDeploys(serviceId: string, limit?: number): Promise<RenderDeploy[]>;
  deleteService(serviceId: string): Promise<void>;
  /** Change a service's build/start commands or deploy trigger. Does not trigger a deploy. */
  updateService(serviceId: string, patch: RenderServiceSettings): Promise<RenderServiceRecord>;
  /** `null` when the owner has no project of exactly that name. */
  findProjectByName(ownerId: string, name: string): Promise<RenderProject | null>;
  /** Creates the project together with its environments. */
  createProject(ownerId: string, name: string, environments: string[]): Promise<RenderProject>;
  listEnvironments(projectId: string): Promise<RenderEnvironment[]>;
  createEnvironment(projectId: string, name: string): Promise<RenderEnvironment>;
  /** Moves existing services into an environment. */
  addToEnvironment(environmentId: string, resourceIds: string[]): Promise<void>;
  /** Deletes the project and everything still in it -- callers check it is empty first. */
  deleteProject(projectId: string): Promise<void>;
  /**
   * One page of a service's logs (build, runtime and request), always oldest
   * to newest. Render's logs API is scoped by owner as well as service, so
   * the service's own `ownerId` is required. Retried on a 429, since a log
   * view polls this.
   */
  queryLogs(ownerId: string, serviceId: string, query: RenderLogsQueryInput): Promise<RenderLogsPage>;
}

/** Render wraps list items as `{ cursor, <resource> }`; unwrap either that or a bare item. */
function unwrap<T>(item: unknown, key: string): T {
  if (item && typeof item === 'object' && key in (item as Record<string, unknown>)) {
    return (item as Record<string, unknown>)[key] as T;
  }
  return item as T;
}

async function parseError(res: Response): Promise<RenderApiError> {
  const text = await res.text().catch(() => '');
  let message = text || res.statusText;
  try {
    const body = JSON.parse(text) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    /* not JSON */
  }
  const retryAfter = res.headers.get('retry-after');
  return new RenderApiError(
    `Render ${res.status}: ${message}`,
    res.status,
    retryAfter ? Number(retryAfter) || undefined : undefined
  );
}

export function createRenderClient(apiKey: string, fetchImpl: typeof fetch = fetch): RenderClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${RENDER_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    async listOwners() {
      const items = await call<unknown[]>('GET', '/owners?limit=100');
      return items.map(item => unwrap<RenderOwner>(item, 'owner'));
    },

    async findServiceByName(name: string) {
      const items = await call<unknown[]>('GET', `/services?name=${encodeURIComponent(name)}&limit=20`);
      const services = items.map(item => unwrap<RenderServiceRecord>(item, 'service'));
      // Render's `name` filter matches by prefix; an exact match is what "rediscover by name" means.
      return services.find(service => service.name === name) ?? null;
    },

    async getService(id: string) {
      return call<RenderServiceRecord>('GET', `/services/${id}`);
    },

    async createService(input: CreateRenderServiceInput) {
      const body = {
        type: 'web_service',
        name: input.name,
        ownerId: input.ownerId,
        repo: input.repo,
        branch: input.branch,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        // `autoDeployTrigger` supersedes the older yes/no `autoDeploy`; sending
        // both can be refused, so the trigger goes alone when there is one.
        ...(input.autoDeployTrigger ? { autoDeployTrigger: input.autoDeployTrigger } : { autoDeploy: 'yes' }),
        envVars: input.envVars ?? [],
        serviceDetails: {
          runtime: 'node',
          // Always sent: Render's own default is a paid plan, and a scaffold
          // that silently started billing the organization is worse than one
          // that asks again after the free plan's limits are outgrown.
          plan: 'free',
          ...(input.region ? { region: input.region } : {}),
          healthCheckPath: input.healthCheckPath,
          previews: { generation: 'off' },
          envSpecificDetails: {
            buildCommand: input.buildCommand,
            startCommand: input.startCommand
          }
        }
      };

      try {
        return await call<{ service: RenderServiceRecord; deployId?: string }>('POST', '/services', body);
      } catch (err) {
        // An account that refuses the trigger on create still gets a service:
        // retried with plain auto-deploy, and the refusal said out loud --
        // the caller then tries the trigger again with an update, and the
        // hosting status reports whether the service waits for CI.
        if (input.autoDeployTrigger && err instanceof RenderApiError && (err.status === 400 || err.status === 422)) {
          logError(`Render refused autoDeployTrigger=${input.autoDeployTrigger} creating ${input.name}; creating it with auto-deploy on push:`, err.message);
          const { autoDeployTrigger: _drop, ...withoutTrigger } = body as typeof body & { autoDeployTrigger?: string };
          return call<{ service: RenderServiceRecord; deployId?: string }>('POST', '/services', { ...withoutTrigger, autoDeploy: 'yes' });
        }
        throw err;
      }
    },

    async setEnvVar(serviceId: string, key: string, value: string) {
      await call<void>('PUT', `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, { value });
    },

    async deleteEnvVar(serviceId: string, key: string) {
      await call<void>('DELETE', `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`);
    },

    async listEnvVars(serviceId: string) {
      const items = await call<unknown[]>('GET', `/services/${serviceId}/env-vars?limit=100`);
      return items.map(item => unwrap<{ key: string; value: string }>(item, 'envVar'));
    },

    async triggerDeploy(serviceId: string) {
      return call<{ id: string }>('POST', `/services/${serviceId}/deploys`, {});
    },

    async latestDeploy(serviceId: string) {
      const items = await call<unknown[]>('GET', `/services/${serviceId}/deploys?limit=1`);
      const [first] = items;
      return first ? unwrap<RenderDeploy>(first, 'deploy') : null;
    },

    async listDeploys(serviceId: string, limit = 20) {
      const items = await call<unknown[]>('GET', `/services/${serviceId}/deploys?limit=${Math.max(1, Math.min(100, limit))}`);
      return items.map(item => unwrap<RenderDeploy>(item, 'deploy'));
    },

    async updateService(serviceId: string, patch: RenderServiceSettings) {
      const envSpecificDetails = {
        ...(patch.buildCommand ? { buildCommand: patch.buildCommand } : {}),
        ...(patch.startCommand ? { startCommand: patch.startCommand } : {})
      };
      return call<RenderServiceRecord>('PATCH', `/services/${serviceId}`, {
        ...(patch.autoDeployTrigger ? { autoDeployTrigger: patch.autoDeployTrigger } : {}),
        ...(Object.keys(envSpecificDetails).length ? { serviceDetails: { envSpecificDetails } } : {})
      });
    },

    async findProjectByName(ownerId: string, name: string) {
      const items = await call<unknown[]>(
        'GET',
        `/projects?ownerId=${encodeURIComponent(ownerId)}&name=${encodeURIComponent(name)}&limit=20`
      );
      const projects = items.map(item => unwrap<RenderProject>(item, 'project'));
      return projects.find(project => project.name === name) ?? null;
    },

    async createProject(ownerId: string, name: string, environments: string[]) {
      return call<RenderProject>('POST', '/projects', {
        name,
        ownerId,
        environments: environments.map(environment => ({ name: environment }))
      });
    },

    async listEnvironments(projectId: string) {
      const items = await call<unknown[]>('GET', `/environments?projectId=${encodeURIComponent(projectId)}&limit=20`);
      return items.map(item => unwrap<RenderEnvironment>(item, 'environment'));
    },

    async createEnvironment(projectId: string, name: string) {
      return call<RenderEnvironment>('POST', '/environments', { name, projectId });
    },

    async addToEnvironment(environmentId: string, resourceIds: string[]) {
      await call<unknown>('POST', `/environments/${environmentId}/resources`, { resourceIds });
    },

    async deleteProject(projectId: string) {
      await call<void>('DELETE', `/projects/${projectId}`);
    },

    async deleteService(serviceId: string) {
      await call<void>('DELETE', `/services/${serviceId}`);
    },

    async queryLogs(ownerId: string, serviceId: string, query: RenderLogsQueryInput) {
      const params = buildRenderLogsQueryParams(ownerId, serviceId, query);
      const res = await fetchWithRetry(
        `${RENDER_API_BASE}/logs?${params.toString()}`,
        { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
        'Render',
        fetchImpl
      );
      if (!res.ok) throw await parseError(res);
      return mapRenderLogsPage((await res.json()) as RenderLogsPayload, query.direction ?? 'backward');
    }
  };
}
