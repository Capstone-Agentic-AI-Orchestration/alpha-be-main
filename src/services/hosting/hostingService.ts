import {
  RENDER_API_KEY,
  RENDER_OWNER_ID,
  RENDER_REGION,
  VERCEL_TOKEN,
  VERCEL_TEAM_ID
} from '../../config/env.js';
import type { CanonicalStack } from '../scaffoldBuilder.js';
import { normalizeProjectStack } from '../scaffoldBuilder.js';
import type { Project, ProjectResource, ProjectResourceHosting } from '../../models/index.js';
import { parseRepoRef, reposForProject } from '../githubIssueMapping.js';
import { githubApi, GitHubApiError } from '../githubApi.js';
import { logError, logInfo } from '../../utils/logger.js';
import { assertSafeBranchName } from '../../utils/gitUtils.js';
import {
  createRenderClient,
  RenderApiError,
  type RenderClient,
  type RenderServiceRecord
} from './renderClient.js';
import { createVercelClient, VercelApiError, type VercelClient, type VercelProject } from './vercelClient.js';

/**
 * Automatic Render + Vercel hosting for repositories Alpha provisions.
 *
 * Everything here is keyed by naming convention, not by a database row:
 * a backend repo `owner/name` hosts as Render services literally named
 * `name` (branch `main`) and `name-uat` (branch `uat`); a frontend repo hosts
 * as one Vercel project literally named `name`. That is what lets the
 * repo-keyed hosting routes (used by a desktop, which has no cloud project to
 * read) do exactly what the project-scoped ones do -- both end up calling the
 * same functions below, which never require a `Project` to already know
 * what to look for. Where a `Project` *is* available, its `github_repo`
 * resource's cached `hosting` field is only a shortcut past the name search;
 * every write path re-confirms against Render/Vercel before trusting it.
 */

export type HostingPlatform = 'render' | 'vercel';
export type HostingRole = 'backend' | 'frontend';
export type HostingBranch = 'main' | 'uat' | 'dev';

export interface HostingStatus {
  repo: string;
  role: HostingRole | null;
  platform: HostingPlatform | null;
  /** Whether the server holds credentials for this repo's platform. */
  configured: boolean;
  state: 'not_set_up' | 'ready' | 'partial' | 'failed' | 'unavailable';
  error?: string;
  partner?: string | null;
  /** Present after a set-up that had a partner to wire into. */
  partnerWiring?: PartnerWiring;
  /** Present after a set-up: whether the ALPHA_URL_* repository variables were written. */
  urlVariables?: { ok: boolean; error?: string };
  environments: Array<{
    branch: HostingBranch;
    url: string | null;
    dashboardUrl: string | null;
    latestDeploy: { status: string; createdAt: string | null; url: string | null } | null;
    /**
     * Whether this environment deploys only after the repository's CI checks pass.
     * false: it deploys on every push, whatever CI says. null: the platform does not
     * say (Vercel -- see its Deployment Checks setting).
     */
    waitsForCi?: boolean | null;
  }>;
  envVars: Array<{ key: string; value: string | null; scope: string; managedByAlpha: boolean }>;
  github: { secrets: string[]; variables: Array<{ name: string; value: string }> };
}

/** Latest preview deployment for the exact branch produced by a build. */
export interface BuildBranchPreview {
  repo: string;
  branch: string;
  platform: HostingPlatform | null;
  state: 'ready' | 'building' | 'failed' | 'waiting' | 'unsupported' | 'unavailable';
  url: string | null;
  deployStatus: string | null;
  ci: {
    state: 'not_run' | 'running' | 'passed' | 'failed' | 'unknown';
    commitSha: string | null;
    checksUrl: string | null;
    checks: Array<{
      name: string;
      state: 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'unknown';
      url: string | null;
    }>;
    error?: string;
  };
  error?: string;
}

export interface HostingContext {
  /** `owner/name`. */
  repo: string;
  /**
   * The project this repo is attached to, when the caller has one -- the
   * browser/cloud-native path. `null`/absent on the repo-keyed routes, which
   * a desktop forwards to precisely because it cannot assume its local
   * project id means anything to the cloud's own project store.
   */
  project?: Project | null;
  /**
   * The exact stack this repo was scaffolded from ('react', 'nextjs',
   * 'nodejs', 'nestjs'), when it is not derivable from `project`. Required to
   * set up hosting for a repo with no project context; without it there is no
   * way to know Render from Vercel, or Vite's env prefix from Next's.
   */
  stackHint?: string;
  /** `owner/name` of the paired repo, when it is not derivable from `project`. */
  partnerHint?: string;
}

/** Which platforms this server holds credentials for. Booleans only -- never the values themselves. */
export function hostingConfigured(): { render: boolean; vercel: boolean } {
  return { render: Boolean(RENDER_API_KEY), vercel: Boolean(VERCEL_TOKEN) };
}

export function renderClient(): RenderClient | null {
  return RENDER_API_KEY ? createRenderClient(RENDER_API_KEY) : null;
}

export function vercelClient(): VercelClient | null {
  return VERCEL_TOKEN ? createVercelClient(VERCEL_TOKEN, VERCEL_TEAM_ID) : null;
}

/** Exported for callers that need to describe a repo's hosting before any API call is made -- see `unavailableHostingStatus`. */
export function roleForStack(stack: CanonicalStack): HostingRole {
  return stack === 'nodejs' || stack === 'nestjs' ? 'backend' : 'frontend';
}

export function platformForStack(stack: CanonicalStack): HostingPlatform {
  return roleForStack(stack) === 'backend' ? 'render' : 'vercel';
}

function vercelFrameworkFor(stack: CanonicalStack): 'vite' | 'nextjs' {
  return stack === 'react' ? 'vite' : 'nextjs';
}

/** `VITE_API_URL` for a Vite app, `NEXT_PUBLIC_API_URL` for Next -- see scaffoldBuilder's `.env.example`. */
function apiUrlKeyFor(stack: CanonicalStack): string {
  return stack === 'react' ? 'VITE_API_URL' : 'NEXT_PUBLIC_API_URL';
}

const RENDER_MANAGED_KEYS = new Set(['NODE_ENV', 'CORS_ORIGINS', 'FRONTEND_URL']);
const VERCEL_MANAGED_KEYS = new Set(['VITE_API_URL', 'NEXT_PUBLIC_API_URL']);

/** Whether Alpha itself sets key (a URL or NODE_ENV), as opposed to a person or an agent. */
export function isAlphaManagedKey(key: string): boolean {
  return RENDER_MANAGED_KEYS.has(key) || VERCEL_MANAGED_KEYS.has(key);
}

/**
 * The value a status may carry for an environment variable: only the ones
 * Alpha itself derived (public URLs and NODE_ENV), never anything a person
 * or an agent set.
 *
 * Render hands back every value in plaintext, and a status goes to anyone who
 * can view the project -- and from there into agent context and run logs,
 * which sync to the cloud. So a value is withheld here, at the one place
 * every status is built, rather than trusted to each screen that shows one.
 */
function readableValue(key: string, value: string | null, managed: ReadonlySet<string>): string | null {
  return managed.has(key) ? value : null;
}

export function renderServiceNames(repoName: string): { main: string; uat: string } {
  return { main: repoName, uat: `${repoName}-uat` };
}

/** The resource on `project` that is this exact `owner/name`, if any. */
function resourceForRepo(project: Project | null | undefined, repo: string): ProjectResource | undefined {
  if (!project) return undefined;
  const wanted = repo.toLowerCase();
  return project.resources?.find(resource => {
    if (resource.type !== 'github_repo') return false;
    const ref = parseRepoRef(resource.pathOrUrl);
    return ref ? `${ref.owner}/${ref.repo}`.toLowerCase() === wanted : false;
  });
}

/**
 * The exact stack this repo was scaffolded from.
 *
 * From the project's own record when there is one; otherwise the hint a
 * caller supplied (the repo-keyed routes' only source of truth for this).
 * Never guessed from GitHub content -- a wrong guess would set up the wrong
 * platform entirely, which is worse than reporting the repo as unhostable
 * until the caller says what it is.
 */
export function resolveStack(ctx: HostingContext): CanonicalStack | null {
  const resource = resourceForRepo(ctx.project, ctx.repo);
  if (resource?.stack) return normalizeProjectStack(resource.stack);
  if (ctx.stackHint) return normalizeProjectStack(ctx.stackHint);
  return null;
}

/**
 * The paired repo's `owner/name`, if this one has a pair.
 *
 * From the project's attached resources when there is one -- the authoritative
 * answer, since that is what "paired" means. Otherwise the `-be`/`-fe`
 * naming convention every paired scaffold uses, confirmed against GitHub
 * rather than assumed: a standalone repo that happens to end in `-be` has no
 * partner, and guessing one would set up hosting for a repository that does
 * not exist.
 */
/**
 * The partner, when it is free to know: already on the project's own
 * resource list, or handed to us directly as a hint. No network call either
 * way -- this is also what an "unavailable" answer (no platform credentials,
 * so nothing will actually be looked up) reports, since a caller asking about
 * a repo it already knows the pairing for should not be told `partner: null`
 * just because hosting itself is unconfigured.
 */
function resolvePartnerFromHint(ctx: HostingContext): string | null {
  const [, name] = ctx.repo.split('/');
  if (ctx.project) {
    const siblings = reposForProject(ctx.project).filter(r => r.toLowerCase() !== ctx.repo.toLowerCase());
    const base = name.replace(/-(be|fe)$/, '');
    const match = siblings.find(sibling => {
      const siblingName = sibling.split('/')[1] ?? '';
      return siblingName.replace(/-(be|fe)$/, '') === base && siblingName !== name;
    });
    return match ?? null;
  }
  return ctx.partnerHint ?? null;
}

/**
 * What a caller holding the project knows about one of its repositories'
 * hosting, as the hints a repo-keyed request carries -- for when the project
 * itself cannot travel (a desktop's project id means nothing to the cloud).
 */
export function hostingHintsFor(project: Project, repo: string): { stack?: string; partner?: string } {
  const stack = resourceForRepo(project, repo)?.stack;
  const partner = resolvePartnerFromHint({ repo, project });
  return { ...(stack ? { stack } : {}), ...(partner ? { partner } : {}) };
}

/**
 * The partner, falling back to the `-be`/`-fe` naming convention confirmed
 * against GitHub when neither a project nor a hint already answered it. Only
 * called once hosting is known to be configured, so a repo nobody will act on
 * never costs a GitHub call.
 */
async function resolvePartner(ctx: HostingContext): Promise<string | null> {
  const fromHint = resolvePartnerFromHint(ctx);
  if (fromHint || ctx.project) return fromHint;

  const [owner, name] = ctx.repo.split('/');
  let candidate: string | null = null;
  if (name.endsWith('-be')) candidate = `${name.slice(0, -3)}-fe`;
  else if (name.endsWith('-fe')) candidate = `${name.slice(0, -3)}-be`;
  if (!candidate) return null;

  try {
    await githubApi().get(`/repos/${owner}/${candidate}`);
    return `${owner}/${candidate}`;
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    // Any other failure (rate limit, network) -- treat as "no partner known"
    // rather than failing the whole setup over a discovery step.
    logError(`Could not check for a partner of ${ctx.repo}:`, (err as Error).message);
    return null;
  }
}

/** Names only for secrets (GitHub never returns their values); variables are plain, so their values come along. */
async function readGithubSecretsAndVariables(repo: string): Promise<HostingStatus['github']> {
  try {
    const [secrets, variables] = await Promise.all([
      githubApi().get<{ secrets: Array<{ name: string }> }>(`/repos/${repo}/actions/secrets`),
      githubApi().get<{ variables: Array<{ name: string; value: string }> }>(`/repos/${repo}/actions/variables`)
    ]);
    return {
      secrets: secrets.secrets.map(s => s.name),
      variables: variables.variables.map(v => ({ name: v.name, value: v.value }))
    };
  } catch (err) {
    logError(`Could not read GitHub Actions secrets/variables for ${repo}:`, (err as Error).message);
    return { secrets: [], variables: [] };
  }
}

/** `GET /v1/owners`: the first team owner, or the first owner of any kind. */
async function resolveRenderOwnerId(client: RenderClient): Promise<string> {
  if (RENDER_OWNER_ID) return RENDER_OWNER_ID;
  const owners = await client.listOwners();
  const owner = owners.find(o => o.type === 'team') ?? owners[0];
  if (!owner) throw new Error('This Render account has no owner to create services under.');
  return owner.id;
}

/** Render's own error for "the GitHub App cannot see this repository" -- reworded into something actionable. */
function friendlyRenderRepoError(err: unknown, repo: string): Error {
  if (err instanceof RenderApiError && (err.status === 404 || err.status === 400 || err.status === 403)) {
    return new Error(
      `Render cannot reach ${repo}. Install the Render GitHub app on the organization with access to all repositories.`
    );
  }
  return err as Error;
}

/**
 * Vercel links a repository through the GitHub login of the account that owns
 * `VERCEL_TOKEN`, not only through the app on the organization -- so either
 * one missing gives this 400. Vercel's own reason is kept, since it is the
 * only thing that says which.
 */
function friendlyVercelRepoError(err: unknown, repo: string): Error {
  if (err instanceof VercelApiError && err.status === 400 && /github|login connection/i.test(err.message)) {
    const reason = err.message.replace(/^Vercel 400:\s*/, '');
    return new Error(
      `Vercel cannot link ${repo} (${reason}). The Vercel account that owns VERCEL_TOKEN needs GitHub connected ` +
        `(Vercel Account Settings, Authentication), and the Vercel GitHub app needs access to this repository.`
    );
  }
  return err as Error;
}

interface BackendUrls {
  main: string | null;
  uat: string | null;
}

interface FrontendUrls {
  production: string | null;
  uat: string | null;
  dev: string | null;
}

/**
 * `https://` on whatever a platform handed back, whether that was already a
 * full URL (Render) or a bare hostname (Vercel's domain list). Idempotent, so
 * it is safe to apply to a value that might already have a scheme.
 */
function httpsUrl(host: string | null | undefined): string | null {
  if (!host) return null;
  return host.startsWith('http') ? host : `https://${host}`;
}

/** The partner's current URLs, read live from the platform -- never from a cache that could be stale. */
async function readPartnerBackendUrls(repo: string): Promise<BackendUrls> {
  const client = renderClient();
  if (!client) return { main: null, uat: null };
  const names = renderServiceNames(repo.split('/')[1]);
  const [main, uat] = await Promise.all([client.findServiceByName(names.main), client.findServiceByName(names.uat)]);
  return { main: httpsUrl(main?.serviceDetails?.url), uat: httpsUrl(uat?.serviceDetails?.url) };
}

/** How Vercel spells a branch inside its automatic alias: lowercase, anything else a hyphen. */
function vercelBranchSlug(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The addresses a frontend is reached at, one per pipeline branch -- stable
 * ones only, because they end up in a backend's exact-match CORS_ORIGINS.
 *
 * A branch's address is the branch domain Alpha claimed for it when that
 * claim succeeded, otherwise Vercel's own automatic branch alias read off
 * that branch's newest deployment. Never the deployment's own hostname: it
 * changes on every deploy, so a CORS entry built from it would break the next
 * time the branch was pushed. `null` when there is no stable address yet (the
 * branch has never been deployed); status then reports `partial`.
 */
async function stableFrontendUrls(client: VercelClient, projectId: string): Promise<FrontendUrls> {
  const [production, domains] = await Promise.all([
    client.productionDomain(projectId).catch(() => null),
    client.listDomains(projectId).catch(() => [])
  ]);

  const branchUrl = async (branch: 'uat' | 'dev'): Promise<string | null> => {
    const claimed = domains.find(d => d.gitBranch === branch)?.name;
    if (claimed) return httpsUrl(claimed);
    const deployment = await client.latestDeployment(projectId, { branch }).catch(() => null);
    if (!deployment) return null;
    const aliases = await client.deploymentAliases(deployment.uid).catch(() => []);
    return httpsUrl(aliases.find(alias => alias.includes(`-git-${vercelBranchSlug(branch)}-`)));
  };

  const [uat, dev] = await Promise.all([branchUrl('uat'), branchUrl('dev')]);
  return { production: httpsUrl(production), uat, dev };
}

async function readPartnerFrontendUrls(repo: string): Promise<FrontendUrls> {
  const client = vercelClient();
  if (!client) return { production: null, uat: null, dev: null };
  const project = await client.findProjectByName(repo.split('/')[1]);
  if (!project) return { production: null, uat: null, dev: null };
  return stableFrontendUrls(client, project.id);
}

// ─── Backend (Render) ───────────────────────────────────────────────────────

/**
 * How a scaffolded backend is built and started on Render.
 *
 * `--include=dev` because Alpha sets `NODE_ENV=production` on the service,
 * Render passes a service's variables to its build, and `npm install` under
 * that NODE_ENV skips devDependencies -- TypeScript and the `@types`
 * packages the build needs. The first build (before the variable existed)
 * passed and every build after it failed; this keeps them all the same.
 */
const RENDER_SETTINGS = {
  buildCommand: 'npm install --include=dev && npm run build',
  startCommand: 'npm run start',
  autoDeployTrigger: 'checksPass'
} as const;

/**
 * Bring a service's build, start and deploy-trigger settings to what Alpha
 * expects -- for a service created before a fix to them, or one whose
 * trigger Render refused on create. Best-effort: a service that cannot be
 * updated keeps working as it was, and its status says whether it waits
 * for CI.
 */
async function ensureRenderSettings(client: RenderClient, service: RenderServiceRecord): Promise<RenderServiceRecord> {
  const details = service.serviceDetails as (RenderServiceRecord['serviceDetails'] & { envSpecificDetails?: { buildCommand?: string; startCommand?: string } }) | undefined;
  const build = details?.envSpecificDetails?.buildCommand ?? details?.buildCommand;
  const start = details?.envSpecificDetails?.startCommand ?? details?.startCommand;
  const stale =
    build !== RENDER_SETTINGS.buildCommand ||
    start !== RENDER_SETTINGS.startCommand ||
    service.autoDeployTrigger !== RENDER_SETTINGS.autoDeployTrigger;
  if (!stale) return service;
  try {
    await client.updateService(service.id, RENDER_SETTINGS);
    return await client.getService(service.id);
  } catch (err) {
    logError(`Could not update the build or deploy settings of Render service ${service.name}:`, (err as Error).message);
    return service;
  }
}

/**
 * The Render environment each branch's service lives in. Two, because a
 * Hobby workspace allows at most two environments per project.
 */
const RENDER_ENVIRONMENTS = { main: 'production', uat: 'uat' } as const;

type RenderEnvironmentIds = Partial<Record<keyof typeof RENDER_ENVIRONMENTS, string>>;

/**
 * The Render project a backend's services are grouped under -- named after
 * the repository, with a `production` and a `uat` environment -- found or
 * created. Best-effort: a workspace that refuses projects still gets working
 * services, only ungrouped, and a retry tries the grouping again.
 */
async function ensureRenderProject(client: RenderClient, ownerId: string, projectName: string): Promise<RenderEnvironmentIds> {
  const wanted = Object.values(RENDER_ENVIRONMENTS);
  try {
    let project = await client.findProjectByName(ownerId, projectName);
    if (!project) project = await client.createProject(ownerId, projectName, wanted);

    const environments = await client.listEnvironments(project.id);
    for (const name of wanted) {
      if (!environments.some(e => e.name === name)) environments.push(await client.createEnvironment(project.id, name));
    }
    const idOf = (name: string) => environments.find(e => e.name === name)?.id;
    return { main: idOf(RENDER_ENVIRONMENTS.main), uat: idOf(RENDER_ENVIRONMENTS.uat) };
  } catch (err) {
    logError(`Could not group the Render services of ${projectName} into a project; they stay ungrouped:`, (err as Error).message);
    return {};
  }
}

async function findOrCreateRenderService(
  client: RenderClient,
  ownerId: string,
  name: string,
  repoUrl: string,
  branch: string,
  healthCheckPath: string,
  environmentId: string | undefined,
  created: Array<() => Promise<void>>
): Promise<RenderServiceRecord> {
  const existing = await client.findServiceByName(name);
  if (existing) {
    // An ungrouped service -- one made before grouping existed -- moves into
    // the project. One already in some environment stays where it is, since
    // that is where someone put it.
    if (environmentId && !existing.environmentId) {
      await client
        .addToEnvironment(environmentId, [existing.id])
        .catch(err => logError(`Could not move Render service ${name} into its project:`, (err as Error).message));
    }
    return ensureRenderSettings(client, existing);
  }

  let result;
  try {
    result = await client.createService({
      name,
      ownerId,
      repo: repoUrl,
      branch,
      ...(environmentId ? { environmentId } : {}),
      ...(RENDER_REGION ? { region: RENDER_REGION } : {}),
      healthCheckPath,
      ...RENDER_SETTINGS
    });
  } catch (err) {
    throw friendlyRenderRepoError(err, repoUrl);
  }
  created.push(async () => {
    await client.deleteService(result.service.id);
  });
  // Read back the service Render actually created -- the real url and
  // dashboard link -- and put the deploy trigger on it if create refused it.
  return ensureRenderSettings(client, await client.getService(result.service.id));
}

async function setRenderEnvAndDeploy(
  client: RenderClient,
  serviceId: string,
  vars: Record<string, string>
): Promise<void> {
  for (const [key, value] of Object.entries(vars)) {
    await client.setEnvVar(serviceId, key, value);
  }
  await client.triggerDeploy(serviceId);
}

async function setUpBackend(
  ctx: HostingContext,
  partner: string | null
): Promise<{ status: HostingStatus; record: ProjectResourceHosting }> {
  const client = renderClient()!;
  const [owner, name] = ctx.repo.split('/');
  const names = renderServiceNames(name);
  const repoUrl = `https://github.com/${owner}/${name}`;
  const created: Array<() => Promise<void>> = [];

  // A partner whose platform cannot be read right now leaves these unwired,
  // not this repository unhosted -- the wiring step reports it.
  const partnerUrls = partner
    ? await readPartnerFrontendUrls(partner).catch(() => ({ production: null, uat: null, dev: null }))
    : { production: null, uat: null, dev: null };
  const ownerId = await resolveRenderOwnerId(client);
  const environments = await ensureRenderProject(client, ownerId, name);

  try {
    const main = await findOrCreateRenderService(client, ownerId, names.main, repoUrl, 'main', '/health', environments.main, created);
    const uat = await findOrCreateRenderService(client, ownerId, names.uat, repoUrl, 'uat', '/health', environments.uat, created);

    const corsForMain = partnerUrls.production ? [partnerUrls.production] : [];
    const corsForUat = [partnerUrls.uat, partnerUrls.dev].filter((v): v is string => Boolean(v));

    await setRenderEnvAndDeploy(client, main.id, {
      NODE_ENV: 'production',
      ...(corsForMain.length ? { CORS_ORIGINS: corsForMain.join(','), FRONTEND_URL: corsForMain[0] } : {})
    });
    await setRenderEnvAndDeploy(client, uat.id, {
      NODE_ENV: 'production',
      ...(corsForUat.length ? { CORS_ORIGINS: corsForUat.join(','), FRONTEND_URL: corsForUat[0] } : {})
    });

    const record: ProjectResourceHosting = {
      platform: 'render',
      render: {
        main: { id: main.id, url: main.serviceDetails?.url ?? null, dashboardUrl: main.dashboardUrl ?? null, autoDeployTrigger: main.autoDeployTrigger ?? null },
        uat: { id: uat.id, url: uat.serviceDetails?.url ?? null, dashboardUrl: uat.dashboardUrl ?? null, autoDeployTrigger: uat.autoDeployTrigger ?? null }
      }
    };

    const status = await statusFromRenderRecord(ctx.repo, 'backend', record, partner, client);
    return { status, record };
  } catch (err) {
    await rollback(created, `setting up Render hosting for ${ctx.repo}`);
    throw err;
  }
}

async function statusFromRenderRecord(
  repo: string,
  role: HostingRole,
  record: ProjectResourceHosting,
  partner: string | null,
  client: RenderClient
): Promise<HostingStatus> {
  const render = record.render!;
  const environments: HostingStatus['environments'] = [];
  const envVars: HostingStatus['envVars'] = [];

  for (const [branch, service] of [
    ['main', render.main],
    ['uat', render.uat]
  ] as const) {
    if (!service) {
      environments.push({ branch, url: null, dashboardUrl: null, latestDeploy: null });
      continue;
    }
    const deploy = await client.latestDeploy(service.id).catch(() => null);
    environments.push({
      branch,
      url: service.url ? (service.url.startsWith('http') ? service.url : `https://${service.url}`) : null,
      dashboardUrl: service.dashboardUrl,
      latestDeploy: deploy
        ? { status: deploy.status, createdAt: deploy.createdAt ?? null, url: service.url ?? null }
        : null,
      // Set up to wait for CI; when Render refused that setting, it deploys on every push.
      waitsForCi: service.autoDeployTrigger ? service.autoDeployTrigger === 'checksPass' : null
    });
    const vars = await client.listEnvVars(service.id).catch(() => []);
    for (const v of vars) {
      envVars.push({
        key: v.key,
        value: readableValue(v.key, v.value, RENDER_MANAGED_KEYS),
        scope: branch,
        managedByAlpha: RENDER_MANAGED_KEYS.has(v.key)
      });
    }
  }

  const github = await readGithubSecretsAndVariables(repo);
  const ready = environments.every(e => e.url !== null);
  const some = environments.some(e => e.url !== null);

  return {
    repo,
    role,
    platform: 'render',
    configured: true,
    state: ready ? 'ready' : some ? 'partial' : 'not_set_up',
    partner,
    environments,
    envVars,
    github
  };
}

// ─── Frontend (Vercel) ──────────────────────────────────────────────────────

/** `owner/name` of the repository a Vercel project is linked to -- Vercel reports the two parts separately. */
function linkedRepo(project: VercelProject): string {
  const repo = project.link?.repo ?? '';
  return repo.includes('/') || !project.link?.org ? repo : `${project.link.org}/${repo}`;
}

async function findOrCreateVercelProject(
  client: VercelClient,
  name: string,
  org: string,
  repo: string,
  framework: 'vite' | 'nextjs',
  created: Array<() => Promise<void>>
): Promise<VercelProject> {
  const existing = await client.findProjectByName(name);
  if (existing) {
    // A 409 on create means "reuse only if it is the same repository" --
    // applied here too, on the fast path, so a name collision with someone
    // else's project is refused instead of quietly adopted.
    if (existing.link?.repo && linkedRepo(existing).toLowerCase() !== `${org}/${repo}`.toLowerCase()) {
      throw new Error(
        `A Vercel project named "${name}" already exists and is linked to a different repository (${linkedRepo(existing)}).`
      );
    }
    return existing;
  }

  try {
    const project = await client.createProject({ name, framework, org, repo });
    created.push(async () => {
      await client.deleteProject(project.id);
    });
    return project;
  } catch (err) {
    if (err instanceof VercelApiError && err.status === 409) {
      const reused = await client.findProjectByName(name);
      if (reused?.link?.repo && linkedRepo(reused).toLowerCase() === `${org}/${repo}`.toLowerCase()) return reused;
      throw new Error(`A Vercel project named "${name}" already exists and is not linked to ${org}/${repo}.`);
    }
    throw friendlyVercelRepoError(err, `${org}/${repo}`);
  }
}

async function setUpFrontend(
  ctx: HostingContext,
  stack: CanonicalStack,
  partner: string | null
): Promise<{ status: HostingStatus; record: ProjectResourceHosting }> {
  const client = vercelClient()!;
  const [owner, name] = ctx.repo.split('/');
  const created: Array<() => Promise<void>> = [];
  const apiUrlKey = apiUrlKeyFor(stack);

  // See setUpBackend: an unreadable partner is reported by the wiring step, not fatal here.
  const partnerUrls = partner ? await readPartnerBackendUrls(partner).catch(() => ({ main: null, uat: null })) : { main: null, uat: null };

  try {
    const project = await findOrCreateVercelProject(client, name, owner, name, vercelFrameworkFor(stack), created);
    await client.disableSsoProtection(project.id);

    const envVars = [];
    if (partnerUrls.main) envVars.push({ key: apiUrlKey, value: partnerUrls.main, target: ['production' as const] });
    if (partnerUrls.uat) envVars.push({ key: apiUrlKey, value: partnerUrls.uat, target: ['preview' as const] });
    if (envVars.length) await client.upsertEnvVars(project.id, envVars);

    for (const branch of ['uat', 'dev']) {
      await client.addBranchDomain(project.id, `${name}-${branch}.vercel.app`, branch);
    }

    // Linking a repository does not deploy its existing branches -- each one
    // needs an explicit deployment, or `main` would sit un-hosted until the
    // next push even though the project now exists.
    await client.createDeployment({ name, projectId: project.id, org: owner, repo: name, ref: 'main', target: 'production' });
    await client.createDeployment({ name, projectId: project.id, org: owner, repo: name, ref: 'uat' });
    await client.createDeployment({ name, projectId: project.id, org: owner, repo: name, ref: 'dev' });

    const record: ProjectResourceHosting = { platform: 'vercel', vercel: { projectId: project.id } };
    const status = await statusFromVercelRecord(ctx.repo, record, partner, client, name);
    return { status, record };
  } catch (err) {
    await rollback(created, `setting up Vercel hosting for ${ctx.repo}`);
    throw err;
  }
}

async function statusFromVercelRecord(
  repo: string,
  record: ProjectResourceHosting,
  partner: string | null,
  client: VercelClient,
  repoName: string
): Promise<HostingStatus> {
  const projectId = record.vercel!.projectId;
  const stable = await stableFrontendUrls(client, projectId);
  const environments: HostingStatus['environments'] = [];

  for (const branch of ['main', 'uat', 'dev'] as const) {
    const deploy = await client
      .latestDeployment(projectId, branch === 'main' ? { production: true } : { branch })
      .catch(() => null);
    // The deploy's own hostname is shown as *that deploy's* link, never as
    // the environment's address -- see `stableFrontendUrls`.
    const deployUrl = httpsUrl(deploy?.url);
    environments.push({
      branch,
      url: branch === 'main' ? stable.production : stable[branch],
      // Resolving a real dashboard link needs the team/user slug, which is
      // another API call this feature does not otherwise need; left null
      // rather than guessed.
      dashboardUrl: null,
      latestDeploy: deploy
        ? {
            status: deploy.state ?? deploy.readyState ?? 'unknown',
            createdAt: deploy.createdAt ? new Date(deploy.createdAt).toISOString() : null,
            url: deployUrl
          }
        : null
    });
  }

  const vercelEnvVars = await client.listEnvVars(projectId).catch(() => []);
  const envVars: HostingStatus['envVars'] = vercelEnvVars.map(v => ({
    key: v.key,
    value: readableValue(v.key, v.value ?? null, VERCEL_MANAGED_KEYS),
    scope: v.target.includes('production') ? 'production' : `preview${v.gitBranch ? `:${v.gitBranch}` : ''}`,
    managedByAlpha: VERCEL_MANAGED_KEYS.has(v.key)
  }));

  const github = await readGithubSecretsAndVariables(repo);
  const ready = environments.every(e => e.url !== null);
  const some = environments.some(e => e.url !== null);

  return {
    repo,
    role: 'frontend',
    platform: 'vercel',
    configured: true,
    state: ready ? 'ready' : some ? 'partial' : 'not_set_up',
    partner,
    environments,
    envVars,
    github
  };
}

async function rollback(created: Array<() => Promise<void>>, action: string): Promise<void> {
  for (const undo of created.reverse()) {
    try {
      await undo();
    } catch (cleanupErr) {
      logError(`Cleanup after a failure ${action} also failed; remove it by hand:`, (cleanupErr as Error).message);
    }
  }
}

/** The GitHub Actions variable that holds each environment's stable URL. */
const URL_VARIABLES: Record<HostingBranch, string> = { main: 'ALPHA_URL_MAIN', uat: 'ALPHA_URL_UAT', dev: 'ALPHA_URL_DEV' };

/**
 * Put each environment's stable URL on the repository as a GitHub Actions
 * variable (not a secret: these are public URLs), for workflows that need an
 * address without a deployment event -- e2e and API tests against uat.
 *
 * Best-effort, and reported: the hosting is up whether or not these were
 * written, so a failure (the caller lacks access to the repository's
 * variables) is said rather than thrown.
 */
async function writeUrlVariables(repo: string, status: HostingStatus): Promise<{ ok: boolean; error?: string }> {
  const failures: string[] = [];
  for (const env of status.environments) {
    if (!env.url) continue;
    const name = URL_VARIABLES[env.branch];
    try {
      await githubApi().patch(`/repos/${repo}/actions/variables/${name}`, { name, value: env.url });
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        try {
          await githubApi().post(`/repos/${repo}/actions/variables`, { name, value: env.url });
          continue;
        } catch (createErr) {
          failures.push(`${name}: ${(createErr as Error).message}`);
          continue;
        }
      }
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (failures.length) logError(`Could not write URL variables on ${repo}:`, failures.join('; '));
  return failures.length ? { ok: false, error: failures.join('; ') } : { ok: true };
}

/** How wiring this repository into its partner went -- part of the status, so a failure is never silent. */
export interface PartnerWiring {
  ok: boolean;
  /** Why the partner could not be updated; the partner keeps what it had, and its own status shows `partial`. */
  error?: string;
}

/**
 * Put the URLs that only just became available onto the partner, and
 * redeploy it: the frontend's stable addresses into the backend's CORS, or
 * the backend's URLs into the frontend's API variable.
 *
 * Awaited, not fired and forgotten -- a partner left unwired is the one
 * failure a person would otherwise only discover from a browser's CORS error.
 */
async function refreshPartner(partner: string, role: HostingRole, ownRepo: string): Promise<PartnerWiring> {
  const [partnerOwner, partnerName] = partner.split('/');
  try {
    if (role === 'frontend') {
      // We are the frontend; the partner is a backend whose CORS needs us.
      const client = renderClient();
      if (!client) return { ok: false, error: 'Render is not configured on this server.' };
      const names = renderServiceNames(partnerName);
      const urls = await readPartnerFrontendUrls(ownRepo);
      const [main, uat] = await Promise.all([client.findServiceByName(names.main), client.findServiceByName(names.uat)]);
      if (main && urls.production) {
        await setRenderEnvAndDeploy(client, main.id, { CORS_ORIGINS: urls.production, FRONTEND_URL: urls.production });
      }
      const uatOrigins = [urls.uat, urls.dev].filter((v): v is string => Boolean(v));
      if (uat && uatOrigins.length) {
        await setRenderEnvAndDeploy(client, uat.id, { CORS_ORIGINS: uatOrigins.join(','), FRONTEND_URL: uatOrigins[0] });
      }
      return { ok: true };
    }

    // We are the backend; the partner is a frontend whose API URL needs us.
    const client = vercelClient();
    if (!client) return { ok: false, error: 'Vercel is not configured on this server.' };
    const project = await client.findProjectByName(partnerName);
    if (!project) return { ok: true };
    const apiUrlKey = apiUrlKeyFor(project.framework === 'nextjs' ? 'nextjs' : 'react');
    const urls = await readPartnerBackendUrls(ownRepo);
    const envVars = [];
    if (urls.main) envVars.push({ key: apiUrlKey, value: urls.main, target: ['production' as const] });
    if (urls.uat) envVars.push({ key: apiUrlKey, value: urls.uat, target: ['preview' as const] });
    if (envVars.length) {
      await client.upsertEnvVars(project.id, envVars);
      // The API URL is compiled into a frontend build, so every branch that
      // reads it needs a new build -- not just production.
      await client.createDeployment({ name: partnerName, projectId: project.id, org: partnerOwner, repo: partnerName, ref: 'main', target: 'production' });
      for (const ref of ['uat', 'dev']) {
        await client.createDeployment({ name: partnerName, projectId: project.id, org: partnerOwner, repo: partnerName, ref });
      }
    }
    return { ok: true };
  } catch (err) {
    logError(`Could not refresh hosting for ${partner} after ${ownRepo} changed:`, (err as Error).message);
    return { ok: false, error: `Could not update ${partner}: ${(err as Error).message}` };
  }
}
// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * A `HostingStatus` for when nothing can even be attempted -- the stack is
 * unknown, or this server holds no credentials for the platform it needs.
 * Exported so callers that short-circuit before reaching this module at all
 * (a desktop with no cloud configured, in `repoScaffoldService`) can still
 * hand back the same shape everything else here returns.
 */
export function unavailableHostingStatus(
  repo: string,
  role: HostingRole | null,
  platform: HostingPlatform | null,
  error: string,
  partner: string | null = null
): HostingStatus {
  return { repo, role, platform, configured: false, state: 'unavailable', error, partner, environments: [], envVars: [], github: { secrets: [], variables: [] } };
}

const unavailable = unavailableHostingStatus;

/** Read-only status: never creates or changes anything. */
export async function getHostingStatus(ctx: HostingContext): Promise<HostingStatus> {
  const stack = resolveStack(ctx);
  if (!stack) {
    return unavailable(ctx.repo, null, null, `Could not tell whether ${ctx.repo} is a backend or a frontend.`);
  }
  const role = roleForStack(stack);
  const platform = platformForStack(stack);
  const configured = hostingConfigured();

  // Before any GitHub or platform call, not after: a status check for a
  // repository nobody can act on should cost nothing beyond what was already
  // free to know (the hint, or the project's own resource list).
  if (platform === 'render' && !configured.render) {
    return unavailable(ctx.repo, role, platform, 'Render is not configured on this server.', resolvePartnerFromHint(ctx));
  }
  if (platform === 'vercel' && !configured.vercel) {
    return unavailable(ctx.repo, role, platform, 'Vercel is not configured on this server.', resolvePartnerFromHint(ctx));
  }

  const partner = await resolvePartner(ctx);

  try {
    if (platform === 'render') {
      const client = renderClient()!;
      const names = renderServiceNames(ctx.repo.split('/')[1]);
      const [main, uat] = await Promise.all([client.findServiceByName(names.main), client.findServiceByName(names.uat)]);
      if (!main && !uat) {
        const github = await readGithubSecretsAndVariables(ctx.repo);
        return { repo: ctx.repo, role, platform, configured: true, state: 'not_set_up', partner, environments: [], envVars: [], github };
      }
      const record: ProjectResourceHosting = {
        platform: 'render',
        render: {
          main: main ? { id: main.id, url: main.serviceDetails?.url ?? null, dashboardUrl: main.dashboardUrl ?? null, autoDeployTrigger: main.autoDeployTrigger ?? null } : null,
          uat: uat ? { id: uat.id, url: uat.serviceDetails?.url ?? null, dashboardUrl: uat.dashboardUrl ?? null, autoDeployTrigger: uat.autoDeployTrigger ?? null } : null
        }
      };
      return statusFromRenderRecord(ctx.repo, role, record, partner, client);
    }

    const client = vercelClient()!;
    const project = await client.findProjectByName(ctx.repo.split('/')[1]);
    if (!project) {
      const github = await readGithubSecretsAndVariables(ctx.repo);
      return { repo: ctx.repo, role, platform, configured: true, state: 'not_set_up', partner, environments: [], envVars: [], github };
    }
    return statusFromVercelRecord(ctx.repo, { platform: 'vercel', vercel: { projectId: project.id } }, partner, client, ctx.repo.split('/')[1]);
  } catch (err: any) {
    return { repo: ctx.repo, role, platform, configured: true, state: 'failed', error: err?.message ?? String(err), partner, environments: [], envVars: [], github: { secrets: [], variables: [] } };
  }
}

function emptyBranchCi(repo: string, branch: string): BuildBranchPreview['ci'] {
  return {
    state: 'not_run',
    commitSha: null,
    checksUrl: `https://github.com/${repo}/actions?query=${encodeURIComponent(`branch:${branch}`)}`,
    checks: []
  };
}

/** Read CI checks attached to the exact commit at a build branch. */
async function branchCiStatus(repo: string, branch: string): Promise<BuildBranchPreview['ci']> {
  const empty = emptyBranchCi(repo, branch);
  try {
    const commit = await githubApi().get<{ sha?: string }>(
      `/repos/${repo}/commits/${encodeURIComponent(branch)}`
    );
    if (!commit.sha) {
      return { ...empty, state: 'unknown', error: 'GitHub did not return a commit for this branch.' };
    }

    const [runsResult, statusesResult] = await Promise.allSettled([
      githubApi().get<{ check_runs?: Array<Record<string, any>> }>(
        `/repos/${repo}/commits/${commit.sha}/check-runs?per_page=100`
      ),
      githubApi().get<{ statuses?: Array<Record<string, any>> }>(
        `/repos/${repo}/commits/${commit.sha}/status`
      )
    ]);
    const available = runsResult.status === 'fulfilled' || statusesResult.status === 'fulfilled';
    if (!available) {
      const error = runsResult.status === 'rejected' ? runsResult.reason :
        statusesResult.status === 'rejected' ? statusesResult.reason : undefined;
      return {
        ...empty,
        state: 'unknown',
        commitSha: commit.sha,
        error: error instanceof Error ? error.message : 'GitHub checks could not be read.'
      };
    }

    const checks: BuildBranchPreview['ci']['checks'] = [];
    if (runsResult.status === 'fulfilled') {
      for (const item of runsResult.value.check_runs ?? []) {
        const status = String(item.status ?? '').toLowerCase();
        const conclusion = String(item.conclusion ?? '').toLowerCase();
        const state: BuildBranchPreview['ci']['checks'][number]['state'] =
          ['queued', 'waiting', 'pending', 'requested'].includes(status) ? 'queued' :
            status === 'in_progress' ? 'running' :
              status === 'completed' && ['success', 'neutral', 'skipped'].includes(conclusion) ? 'passed' :
                status === 'completed' && ['failure', 'cancelled', 'timed_out', 'action_required', 'stale'].includes(conclusion) ? 'failed' : 'unknown';
        checks.push({
          name: String(item.name ?? 'GitHub check'),
          state,
          url: httpsUrl(item.html_url ?? item.details_url)
        });
      }
    }
    if (statusesResult.status === 'fulfilled') {
      for (const item of statusesResult.value.statuses ?? []) {
        const state = String(item.state ?? '').toLowerCase();
        checks.push({
          name: String(item.context ?? 'Commit status'),
          state: state === 'pending' ? 'queued' : state === 'success' ? 'passed' :
            ['failure', 'error'].includes(state) ? 'failed' : 'unknown',
          url: httpsUrl(item.target_url)
        });
      }
    }

    const state: BuildBranchPreview['ci']['state'] = checks.length === 0 ? 'not_run' :
      checks.some(check => check.state === 'queued' || check.state === 'running') ? 'running' :
        checks.some(check => check.state === 'failed') ? 'failed' :
          checks.some(check => check.state === 'unknown') ? 'unknown' : 'passed';
    return { ...empty, state, commitSha: commit.sha, checks };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return empty;
    return {
      ...empty,
      state: 'unknown',
      error: error instanceof Error ? error.message : 'GitHub checks could not be read.'
    };
  }
}

/**
 * Read the provider's latest preview for a build branch.
 *
 * Vercel creates preview deployments for Git branches. Render's configured
 * services currently track only the project's dev/uat/main environments, so
 * Alpha reports that boundary instead of presenting an unrelated environment
 * URL as this build's preview.
 */
export async function getBuildBranchPreview(ctx: HostingContext, branch: string): Promise<BuildBranchPreview> {
  let platform: HostingPlatform | null = null;
  let ci = emptyBranchCi(ctx.repo, branch);
  const unavailable = (state: BuildBranchPreview['state'], error?: string): BuildBranchPreview => ({
    repo: ctx.repo,
    branch,
    platform,
    state,
    url: null,
    deployStatus: null,
    ci,
    ...(error ? { error } : {})
  });

  try {
    assertSafeBranchName(branch);
  } catch {
    return unavailable('unavailable', 'The build branch name is not valid.');
  }
  ci = await branchCiStatus(ctx.repo, branch);
  const stack = resolveStack(ctx);
  if (!stack) return unavailable('unavailable', `Could not identify the hosting provider for ${ctx.repo}.`);
  platform = platformForStack(stack);
  if (platform !== 'vercel') {
    return unavailable('unsupported', 'Run-branch previews are not available for this hosting provider yet.');
  }
  if (!hostingConfigured().vercel) {
    return unavailable('unavailable', 'Vercel is not configured on the Alpha server.');
  }

  try {
    const client = vercelClient();
    if (!client) return unavailable('unavailable', 'Vercel is not configured on the Alpha server.');
    const project = await client.findProjectByName(ctx.repo.split('/')[1]);
    if (!project) {
      return unavailable('waiting', 'Set up preview hosting for this repository to publish a build preview.');
    }
    if (!project.link?.repo || linkedRepo(project).toLowerCase() !== ctx.repo.toLowerCase()) {
      return unavailable('unavailable', 'The Vercel project with this name is linked to a different repository.');
    }
    const deployment = await client.latestDeployment(project.id, { branch });
    if (!deployment) return unavailable('waiting', `Vercel has not created a preview for ${branch} yet.`);
    const deployStatus = deployment.readyState ?? deployment.state ?? null;
    const ready = Boolean(deployStatus && /^(ready|live)$/i.test(deployStatus));
    const failed = Boolean(deployStatus && /^(error|failed|canceled|cancelled)$/i.test(deployStatus));
    return {
      repo: ctx.repo,
      branch,
      platform: 'vercel',
      state: ready ? 'ready' : failed ? 'failed' : 'building',
      url: httpsUrl(deployment.url),
      deployStatus,
      ci
    };
  } catch (error) {
    return unavailable('unavailable', error instanceof Error ? error.message : 'Could not read the Vercel preview.');
  }
}

/**
 * Set up hosting for `ctx.repo`, or bring it up to date if it already exists.
 *
 * Idempotent: an existing Render service or Vercel project of the expected
 * name is reused rather than recreated, whether this is the first call or a
 * retry after a partial failure. Never touches the GitHub repository itself
 * -- a failure here rolls back only what this call created on Render/Vercel.
 */
export async function setUpHosting(ctx: HostingContext): Promise<HostingStatus> {
  const stack = resolveStack(ctx);
  if (!stack) {
    return unavailable(ctx.repo, null, null, `Could not tell whether ${ctx.repo} is a backend or a frontend. Pass its stack.`);
  }
  const role = roleForStack(stack);
  const platform = platformForStack(stack);
  const configured = hostingConfigured();

  if (platform === 'render' && !configured.render) {
    return unavailable(ctx.repo, role, platform, 'Render is not configured on this server.', resolvePartnerFromHint(ctx));
  }
  if (platform === 'vercel' && !configured.vercel) {
    return unavailable(ctx.repo, role, platform, 'Vercel is not configured on this server.', resolvePartnerFromHint(ctx));
  }

  const partner = await resolvePartner(ctx);

  try {
    const { status } = role === 'backend' ? await setUpBackend(ctx, partner) : await setUpFrontend(ctx, stack, partner);

    const partnerWiring = partner ? await refreshPartner(partner, role, ctx.repo) : undefined;
    const urlVariables = await writeUrlVariables(ctx.repo, status);

    logInfo(`Hosting set up for ${ctx.repo} on ${platform} (${status.state}).`);
    return { ...status, ...(partnerWiring ? { partnerWiring } : {}), urlVariables };
  } catch (err: any) {
    logError(`Hosting setup failed for ${ctx.repo}:`, err?.message ?? err);
    return { repo: ctx.repo, role, platform, configured: true, state: 'failed', error: err?.message ?? String(err), partner, environments: [], envVars: [], github: { secrets: [], variables: [] } };
  }
}

// ─── Removing hosting ───────────────────────────────────────────────────────

/** What removing a repository's hosting did, one readable line per platform resource. */
export interface HostingTeardown {
  repo: string;
  removed: string[];
  /** Found but not Alpha's to remove -- linked to another repository, or still holding something else. */
  kept: string[];
  /** Could not be removed; the repository should not be deleted until these are. */
  failed: string[];
}

/** `https://github.com/<owner>/<name>` in any casing, with or without `.git`. */
function sameRepoUrl(url: string | undefined, repo: string): boolean {
  const ref = parseRepoRef(url ?? '');
  return Boolean(ref) && `${ref!.owner}/${ref!.repo}`.toLowerCase() === repo.toLowerCase();
}

/**
 * Remove everything Alpha set up to host `owner/name`: the Render services
 * and the Render project grouping them, and the Vercel project.
 *
 * Found by the same names setup uses, and removed only when the platform
 * says it is linked to this repository -- a same-named service of another
 * repository is reported as kept, never deleted. The Render project goes
 * only once nothing but this repository's services was in it, since
 * deleting a Render project deletes whatever it still holds.
 *
 * Idempotent: anything already gone is simply not listed, so a teardown
 * that failed half-way is finished by running it again.
 */
export async function tearDownHosting(repo: string): Promise<HostingTeardown> {
  const name = repo.split('/')[1];
  const result: HostingTeardown = { repo, removed: [], kept: [], failed: [] };

  const render = renderClient();
  if (render) {
    const deletedIds: string[] = [];
    for (const serviceName of Object.values(renderServiceNames(name))) {
      try {
        const service = await render.findServiceByName(serviceName);
        if (!service) continue;
        if (!sameRepoUrl(service.repo, repo)) {
          result.kept.push(`Render service ${serviceName} (linked to ${service.repo ?? 'no repository'})`);
          continue;
        }
        await render.deleteService(service.id);
        deletedIds.push(service.id);
        result.removed.push(`Render service ${serviceName}`);
      } catch (err) {
        result.failed.push(`Render service ${serviceName}: ${(err as Error).message}`);
      }
    }

    try {
      const ownerId = await resolveRenderOwnerId(render);
      const project = await render.findProjectByName(ownerId, name);
      if (project) {
        const environments = await render.listEnvironments(project.id);
        // Render may still list a service it has just deleted; those do not count.
        const remaining = environments.flatMap(e => [
          ...(e.serviceIds ?? []).filter(id => !deletedIds.includes(id)),
          ...(e.databasesIds ?? []),
          ...(e.redisIds ?? []),
          ...(e.envGroupIds ?? [])
        ]);
        if (remaining.length) {
          result.kept.push(`Render project ${name} (still holds ${remaining.length} other resource${remaining.length === 1 ? '' : 's'})`);
        } else {
          await render.deleteProject(project.id);
          result.removed.push(`Render project ${name}`);
        }
      }
    } catch (err) {
      result.failed.push(`Render project ${name}: ${(err as Error).message}`);
    }
  }

  const vercel = vercelClient();
  if (vercel) {
    try {
      const project = await vercel.findProjectByName(name);
      if (project) {
        if (project.link?.repo && linkedRepo(project).toLowerCase() === repo.toLowerCase()) {
          await vercel.deleteProject(project.id);
          result.removed.push(`Vercel project ${name}`);
        } else {
          result.kept.push(`Vercel project ${name} (linked to ${project.link?.repo ? linkedRepo(project) : 'no repository'})`);
        }
      }
    } catch (err) {
      result.failed.push(`Vercel project ${name}: ${(err as Error).message}`);
    }
  }

  logInfo(
    `Hosting teardown for ${repo}: removed [${result.removed.join(', ')}]` +
      (result.kept.length ? `; kept [${result.kept.join(', ')}]` : '') +
      (result.failed.length ? `; failed [${result.failed.join(', ')}]` : '')
  );
  return result;
}
