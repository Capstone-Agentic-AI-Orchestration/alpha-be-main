/**
 * Vercel's REST API (`https://api.vercel.com`), as a thin client.
 *
 * Same shape as `renderClient`: one method per endpoint, no opinion about
 * what Alpha is using it for. `hostingService` decides what a 409 (a project
 * of that name already exists) or a 400 (the Vercel GitHub integration is not
 * installed) actually means and what to do about it -- this layer only ever
 * throws `VercelApiError` with Vercel's own status and message attached.
 */

import type { DeploymentLogLine } from './deploymentLogs.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import {
  filterVercelLogLines,
  mapVercelBuildEventLine,
  mapVercelRuntimeLogLine,
  type VercelBuildEventEntry,
  type VercelRuntimeLogEntry
} from './vercelLogs.js';

const VERCEL_API_BASE = 'https://api.vercel.com';

/** A page of Vercel logs: one bounded read, no cursor -- Vercel's log endpoints offer none. */
export interface VercelLogsPage {
  logs: DeploymentLogLine[];
  hasMore: false;
  next: null;
}

export interface VercelLogsQuery {
  /** `['build']` reads the build output; anything else reads runtime logs. */
  type?: readonly string[];
  level?: readonly string[];
  text?: string;
}

/** The runtime-logs endpoint streams and may stay open; read what arrives within this long. */
const RUNTIME_LOG_READ_MS = 4_000;
const LOG_PAGE_LINES = 100;

export class VercelApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'VercelApiError';
  }
}

export interface VercelProjectLink {
  type?: string;
  org?: string;
  repo?: string;
}

export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  link?: VercelProjectLink;
}

export interface CreateVercelProjectInput {
  name: string;
  framework: 'vite' | 'nextjs';
  org: string;
  repo: string;
  /** Build from this folder of the repository -- a monorepo's `apps/web`. Root when absent. */
  rootDirectory?: string;
}

export type VercelEnvTarget = 'production' | 'preview' | 'development';

export interface VercelEnvVarInput {
  key: string;
  value: string;
  target: VercelEnvTarget[];
  /** Restricts a `preview` target to one branch; omit for every preview. */
  gitBranch?: string;
  /**
   * `sensitive`: write-only, never readable again through Vercel's API or dashboard --
   * what anything a person or agent sets is. `plain` only for the URLs Alpha derives.
   */
  type?: 'plain' | 'sensitive';
}

export interface VercelEnvVar {
  id?: string;
  key: string;
  value?: string;
  type?: string;
  target: string[];
  gitBranch?: string;
}

export interface VercelDomain {
  name: string;
  gitBranch?: string | null;
}

export interface VercelDeployment {
  uid: string;
  /** This one deployment's own hostname -- it changes on every deploy, so it is never a stable address. */
  url?: string;
  state?: string;
  readyState?: string;
  createdAt?: number;
  target?: string;
  meta?: { githubCommitSha?: string; githubCommitMessage?: string; githubCommitRef?: string; githubCommitAuthorLogin?: string };
}

/** Which deployment `latestDeployment` answers for: production, or the newest one from a branch. */
export type VercelDeploymentScope = { production: true } | { branch: string };

export interface CreateDeploymentInput {
  name: string;
  projectId: string;
  org: string;
  repo: string;
  ref: string;
  /** Production when set; a preview deployment otherwise. */
  target?: 'production';
}

export interface VercelClient {
  /** `null` when Vercel has no project of that name. */
  findProjectByName(name: string): Promise<VercelProject | null>;
  createProject(input: CreateVercelProjectInput): Promise<VercelProject>;
  getProject(projectId: string): Promise<VercelProject>;
  /** Vercel's password/SSO gate, which would otherwise block every preview and health check. */
  disableSsoProtection(projectId: string): Promise<void>;
  upsertEnvVars(projectId: string, vars: VercelEnvVarInput[]): Promise<void>;
  /** `value` is absent for a `sensitive`/`encrypted` variable; Alpha only ever writes `plain` ones. */
  listEnvVars(projectId: string): Promise<VercelEnvVar[]>;
  /** Remove one variable record, by the id `listEnvVars` reports for it. */
  deleteEnvVar(projectId: string, envId: string): Promise<void>;
  /** `false` when Vercel refused a branch domain (some plans do not allow it); caller falls back to the git alias. */
  addBranchDomain(projectId: string, domainName: string, gitBranch: string): Promise<boolean>;
  listDomains(projectId: string): Promise<VercelDomain[]>;
  /**
   * The production domain, straight from Vercel rather than inferred by
   * filtering the full domain list for "the one with no git branch" --
   * Vercel assigns `<project>.vercel.app` to production automatically the
   * moment the project is linked, and this is the endpoint that says so.
   */
  productionDomain(projectId: string): Promise<string | null>;
  createDeployment(input: CreateDeploymentInput): Promise<{ id: string; url?: string }>;
  /**
   * The newest production deployment, or the newest one built from a branch.
   * Filtered by Vercel itself, never by picking through a page of mixed
   * results -- that is how a preview once read as the production deploy.
   * `null` when there is none yet.
   */
  latestDeployment(projectId: string, scope: VercelDeploymentScope): Promise<VercelDeployment | null>;
  /** Recent deployments for one environment, newest first. */
  listDeployments(projectId: string, scope: VercelDeploymentScope, limit?: number): Promise<VercelDeployment[]>;
  /**
   * Every alias Vercel assigned a deployment, including the automatic
   * per-branch one (`<project>-git-<branch>-<scope>.vercel.app`), which stays
   * the same across deploys of that branch.
   */
  deploymentAliases(deploymentId: string): Promise<string[]>;
  deleteProject(projectId: string): Promise<void>;
  /**
   * Logs of the newest deployment in `scope` -- production, or one branch --
   * oldest to newest. Build output when only `build` is asked for, runtime
   * logs otherwise. Filtered here by level and text, which Vercel's endpoints
   * do not take.
   */
  queryLogs(projectId: string, scope: VercelDeploymentScope, query: VercelLogsQuery): Promise<VercelLogsPage>;
}

async function parseError(res: Response): Promise<VercelApiError> {
  const text = await res.text().catch(() => '');
  let message = text || res.statusText;
  try {
    const body = JSON.parse(text) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    /* not JSON */
  }
  return new VercelApiError(`Vercel ${res.status}: ${message}`, res.status);
}

/**
 * Runtime-log entries from a response that may be one JSON document or a
 * stream of newline-delimited ones, and that may never end on its own:
 * whatever arrives within `RUNTIME_LOG_READ_MS` is read, then the stream is
 * let go. A partial last line is dropped.
 */
async function readRuntimeLogEntries(res: Response): Promise<VercelRuntimeLogEntry[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ done: true; value?: undefined }>(resolve => {
    timer = setTimeout(() => resolve({ done: true }), RUNTIME_LOG_READ_MS);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }

  const trimmed = text.trim();
  if (!trimmed) return [];
  // One document: an array, or `{ logs: [...] }`.
  try {
    const parsed = JSON.parse(trimmed) as VercelRuntimeLogEntry[] | { logs?: VercelRuntimeLogEntry[] };
    return Array.isArray(parsed) ? parsed : parsed.logs ?? [];
  } catch {
    // A stream: one JSON object per line.
  }
  const entries: VercelRuntimeLogEntry[] = [];
  for (const line of trimmed.split('\n')) {
    try {
      entries.push(JSON.parse(line) as VercelRuntimeLogEntry);
    } catch {
      /* the unfinished last line, or noise */
    }
  }
  return entries;
}

export function createVercelClient(token: string, teamId: string, fetchImpl: typeof fetch = fetch): VercelClient {
  /** `?teamId=` on every call, as Vercel requires once a token belongs to a team. */
  function url(path: string): string {
    if (!teamId) return `${VERCEL_API_BASE}${path}`;
    const sep = path.includes('?') ? '&' : '?';
    return `${VERCEL_API_BASE}${path}${sep}teamId=${encodeURIComponent(teamId)}`;
  }

  async function call<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const res = await fetchImpl(url(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function latestDeployment(projectId: string, scope: VercelDeploymentScope): Promise<VercelDeployment | null> {
    const filter = 'production' in scope ? 'target=production' : `branch=${encodeURIComponent(scope.branch)}`;
    const body = await call<{ deployments: VercelDeployment[] }>(
      'GET',
      `/v7/deployments?projectId=${encodeURIComponent(projectId)}&limit=1&${filter}`
    );
    return body?.deployments?.[0] ?? null;
  }

  async function listDeployments(projectId: string, scope: VercelDeploymentScope, limit = 20): Promise<VercelDeployment[]> {
    const filter = 'production' in scope ? 'target=production' : `branch=${encodeURIComponent(scope.branch)}`;
    const body = await call<{ deployments: VercelDeployment[] }>(
      'GET',
      `/v7/deployments?projectId=${encodeURIComponent(projectId)}&limit=${Math.max(1, Math.min(100, limit))}&${filter}`
    );
    return body?.deployments ?? [];
  }

  return {
    async findProjectByName(name: string) {
      return call<VercelProject>('GET', `/v9/projects/${encodeURIComponent(name)}`, undefined, true);
    },

    async createProject(input: CreateVercelProjectInput) {
      return (await call<VercelProject>('POST', '/v11/projects', {
        name: input.name,
        framework: input.framework,
        ...(input.rootDirectory ? { rootDirectory: input.rootDirectory } : {}),
        gitRepository: { type: 'github', repo: `${input.org}/${input.repo}` },
        // Applied here too so a project with none created is never briefly
        // gated before `disableSsoProtection` gets to it.
        ssoProtection: null
      }))!;
    },

    async getProject(projectId: string) {
      return (await call<VercelProject>('GET', `/v9/projects/${projectId}`))!;
    },

    async disableSsoProtection(projectId: string) {
      await call<VercelProject>('PATCH', `/v9/projects/${projectId}`, { ssoProtection: null });
    },

    async upsertEnvVars(projectId: string, vars: VercelEnvVarInput[]) {
      await call<unknown>(
        'POST',
        `/v10/projects/${projectId}/env?upsert=true`,
        vars.map(v => ({ key: v.key, value: v.value, type: v.type ?? 'plain', target: v.target, ...(v.gitBranch ? { gitBranch: v.gitBranch } : {}) }))
      );
    },

    async listEnvVars(projectId: string) {
      const body = await call<{ envs: VercelEnvVar[] }>(
        'GET',
        `/v10/projects/${projectId}/env`
      );
      return body?.envs ?? [];
    },

    async deleteEnvVar(projectId: string, envId: string) {
      await call<void>('DELETE', `/v9/projects/${projectId}/env/${encodeURIComponent(envId)}`);
    },

    async addBranchDomain(projectId: string, domainName: string, gitBranch: string) {
      try {
        await call<unknown>('POST', `/v10/projects/${projectId}/domains`, { name: domainName, gitBranch });
        return true;
      } catch (err) {
        // Not every plan allows a custom branch alias; the caller reads the
        // platform's own git alias instead when this comes back false.
        if (err instanceof VercelApiError && (err.status === 400 || err.status === 403 || err.status === 409)) {
          return false;
        }
        throw err;
      }
    },

    async listDomains(projectId: string) {
      const body = await call<{ domains: VercelDomain[] }>('GET', `/v9/projects/${projectId}/domains`);
      return body?.domains ?? [];
    },

    async productionDomain(projectId: string) {
      const body = await call<{ domains: VercelDomain[] }>('GET', `/v9/projects/${projectId}/domains?production=true`);
      return body?.domains?.[0]?.name ?? null;
    },

    async createDeployment(input: CreateDeploymentInput) {
      const body = await call<{ id: string; url?: string }>('POST', '/v13/deployments', {
        name: input.name,
        project: input.projectId,
        ...(input.target ? { target: input.target } : {}),
        gitSource: { type: 'github', org: input.org, repo: input.repo, ref: input.ref }
      });
      return body!;
    },

    latestDeployment,

    listDeployments,

    async deploymentAliases(deploymentId: string) {
      const body = await call<{ alias?: string[] }>('GET', `/v13/deployments/${encodeURIComponent(deploymentId)}`);
      return body?.alias ?? [];
    },

    async deleteProject(projectId: string) {
      await call<void>('DELETE', `/v9/projects/${projectId}`);
    },

    async queryLogs(projectId: string, scope: VercelDeploymentScope, query: VercelLogsQuery) {
      const empty: VercelLogsPage = { logs: [], hasMore: false, next: null };
      const deployment = await latestDeployment(projectId, scope);
      if (!deployment?.uid) return empty;

      const buildOnly = Boolean(query.type?.length) && query.type!.every(type => type === 'build');
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      let lines: DeploymentLogLine[];

      if (buildOnly) {
        const res = await fetchWithRetry(
          url(`/v3/deployments/${encodeURIComponent(deployment.uid)}/events?limit=${LOG_PAGE_LINES}`),
          { method: 'GET', headers },
          'Vercel',
          fetchImpl
        );
        if (!res.ok) throw await parseError(res);
        const events = (await res.json()) as VercelBuildEventEntry[];
        lines = (Array.isArray(events) ? events : [])
          .map((event, index) => mapVercelBuildEventLine(event, index))
          .filter((line): line is DeploymentLogLine => line !== null);
      } else {
        const res = await fetchWithRetry(
          url(`/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deployment.uid)}/runtime-logs`),
          { method: 'GET', headers, signal: AbortSignal.timeout(RUNTIME_LOG_READ_MS + 2_000) },
          'Vercel',
          fetchImpl
        );
        if (!res.ok) throw await parseError(res);
        const entries = await readRuntimeLogEntries(res);
        lines = entries.slice(-LOG_PAGE_LINES).map((entry, index) => mapVercelRuntimeLogLine(entry, index));
      }

      const filtered = filterVercelLogLines(lines, { level: query.level, text: query.text });
      filtered.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      return { logs: filtered, hasMore: false, next: null };
    }
  };
}
