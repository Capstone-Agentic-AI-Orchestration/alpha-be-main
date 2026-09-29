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
  dashboardUrl?: string;
  serviceDetails?: RenderServiceDetails;
}

export interface RenderDeploy {
  id: string;
  status: string;
  createdAt?: string;
  finishedAt?: string;
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
  /**
   * Documented only for Blueprints and the dashboard, not this endpoint --
   * worth asking for anyway, since a service that redeploys once checks pass
   * is the better default. `createService` retries without it when Render
   * rejects the field, and reports whether it actually stuck.
   */
  autoDeployTrigger?: 'checksPass';
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
  deleteService(serviceId: string): Promise<void>;
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
        autoDeploy: 'yes',
        ...(input.autoDeployTrigger ? { autoDeployTrigger: input.autoDeployTrigger } : {}),
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
        // autoDeployTrigger is undocumented for this endpoint; some accounts
        // refuse it outright rather than ignoring it. Retry once without it
        // so the field being experimental never blocks provisioning.
        if (input.autoDeployTrigger && err instanceof RenderApiError && (err.status === 400 || err.status === 422)) {
          const { autoDeployTrigger: _drop, ...withoutTrigger } = body as typeof body & { autoDeployTrigger?: string };
          return call<{ service: RenderServiceRecord; deployId?: string }>('POST', '/services', withoutTrigger);
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
