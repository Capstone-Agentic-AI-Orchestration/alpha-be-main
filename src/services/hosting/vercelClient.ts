/**
 * Vercel's REST API (`https://api.vercel.com`), as a thin client.
 *
 * Same shape as `renderClient`: one method per endpoint, no opinion about
 * what Alpha is using it for. `hostingService` decides what a 409 (a project
 * of that name already exists) or a 400 (the Vercel GitHub integration is not
 * installed) actually means and what to do about it -- this layer only ever
 * throws `VercelApiError` with Vercel's own status and message attached.
 */

const VERCEL_API_BASE = 'https://api.vercel.com';

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
}

export type VercelEnvTarget = 'production' | 'preview' | 'development';

export interface VercelEnvVarInput {
  key: string;
  value: string;
  target: VercelEnvTarget[];
  /** Restricts a `preview` target to one branch; omit for every preview. */
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
  listEnvVars(projectId: string): Promise<Array<{ key: string; value?: string; target: string[]; gitBranch?: string }>>;
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
  /**
   * Every alias Vercel assigned a deployment, including the automatic
   * per-branch one (`<project>-git-<branch>-<scope>.vercel.app`), which stays
   * the same across deploys of that branch.
   */
  deploymentAliases(deploymentId: string): Promise<string[]>;
  deleteProject(projectId: string): Promise<void>;
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

  return {
    async findProjectByName(name: string) {
      return call<VercelProject>('GET', `/v9/projects/${encodeURIComponent(name)}`, undefined, true);
    },

    async createProject(input: CreateVercelProjectInput) {
      return (await call<VercelProject>('POST', '/v11/projects', {
        name: input.name,
        framework: input.framework,
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
        vars.map(v => ({ key: v.key, value: v.value, type: 'plain', target: v.target, ...(v.gitBranch ? { gitBranch: v.gitBranch } : {}) }))
      );
    },

    async listEnvVars(projectId: string) {
      const body = await call<{ envs: Array<{ key: string; value?: string; target: string[]; gitBranch?: string }> }>(
        'GET',
        `/v10/projects/${projectId}/env`
      );
      return body?.envs ?? [];
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

    async latestDeployment(projectId: string, scope: VercelDeploymentScope) {
      const filter =
        'production' in scope ? 'target=production' : `branch=${encodeURIComponent(scope.branch)}`;
      const body = await call<{ deployments: VercelDeployment[] }>(
        'GET',
        `/v7/deployments?projectId=${encodeURIComponent(projectId)}&limit=1&${filter}`
      );
      return body?.deployments?.[0] ?? null;
    },

    async deploymentAliases(deploymentId: string) {
      const body = await call<{ alias?: string[] }>('GET', `/v13/deployments/${encodeURIComponent(deploymentId)}`);
      return body?.alias ?? [];
    },

    async deleteProject(projectId: string) {
      await call<void>('DELETE', `/v9/projects/${projectId}`);
    }
  };
}
