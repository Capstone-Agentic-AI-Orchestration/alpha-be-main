import { validateEnvironmentScope } from './envScope.js';
import { recordHostingChange, type HostingActor } from './hostingAudit.js';
import {
  getHostingStatus,
  hostedNameFor,
  isAlphaManagedKey,
  platformForStack,
  renderClient,
  renderServiceNames,
  resolveStack,
  roleForStack,
  vercelClient,
  type HostingBranch,
  type HostingContext,
  type HostingRole,
  type HostingTarget
} from './hostingService.js';

/**
 * A hosted repository's environment variables, set by people and agents.
 *
 * Values are write-only end to end: accepted here, handed to the platform
 * (Vercel stores them as `sensitive`), and never returned, logged or kept --
 * the audit records keys only. Variables Alpha derives itself (URLs,
 * NODE_ENV) cannot be changed here: the pairing owns them, and a hand edit
 * would be overwritten or break the pair.
 */

export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const MAX_ENV_VALUE_LENGTH = 16_384;
/** Names the platforms set themselves; a value written over one would be ignored or break the service. */
const RESERVED_PREFIXES = ['VERCEL_', 'RENDER_'];

export interface EnvVarWrite {
  key: string;
  value: string;
}

export interface EnvWriteRequest {
  environment: HostingBranch;
  vars: EnvVarWrite[];
  /** Rebuild the environment so the change takes effect now. Default true. */
  redeploy?: boolean;
}

export interface EnvChangeResult {
  environment: HostingBranch;
  /** Keys the platform accepted. */
  changed: string[];
  failed: Array<{ key: string; error: string }>;
  redeployed: boolean;
  redeployError?: string;
}

export interface HostingEnvVar {
  key: string;
  /** `all-previews` is a Vercel preview variable not scoped to one branch. */
  environment: HostingBranch | 'all-previews';
  managedByAlpha: boolean;
  /** Only Alpha's own derived values are ever readable. */
  value: string | null;
}

export interface HostingEnvList {
  repo: string;
  role: HostingRole | null;
  state: string;
  error?: string;
  /** The environments this repository is hosted in, and so can hold variables. */
  environments: HostingBranch[];
  vars: HostingEnvVar[];
}

export class EnvRequestError extends Error {}

/** Which environments a repository with this role is hosted in. */
export function hostedEnvironments(role: HostingRole): HostingBranch[] {
  return role === 'backend' ? ['main', 'uat'] : ['main', 'uat', 'dev'];
}

/** Why a key may not be written, or null when it may. */
export function keyProblem(key: string): string | null {
  if (!ENV_KEY_PATTERN.test(key)) return `${key || '(empty)'} is not a valid name: use A-Z, 0-9 and _, not starting with a digit.`;
  if (isAlphaManagedKey(key)) return `${key} is set by Alpha from the paired repository and cannot be changed here.`;
  if (RESERVED_PREFIXES.some(prefix => key.startsWith(prefix))) return `${key} is reserved by the hosting platform.`;
  return null;
}

export function validateEnvWrite(role: HostingRole, request: EnvWriteRequest): void {
  if (!hostedEnvironments(role).includes(request.environment)) {
    throw new EnvRequestError(`This repository is not hosted in ${request.environment}.`);
  }
  if (!Array.isArray(request.vars) || request.vars.length === 0) throw new EnvRequestError('Give at least one variable.');
  const seen = new Set<string>();
  for (const v of request.vars) {
    const problem = keyProblem(v?.key);
    if (problem) throw new EnvRequestError(problem);
    if (seen.has(v.key)) throw new EnvRequestError(`${v.key} is given twice.`);
    seen.add(v.key);
    if (typeof v.value !== 'string') throw new EnvRequestError(`${v.key} needs a value.`);
    if (v.value.length > MAX_ENV_VALUE_LENGTH) throw new EnvRequestError(`${v.key} is longer than ${MAX_ENV_VALUE_LENGTH} characters.`);
  }
}

function roleOf(ctx: HostingContext): HostingRole {
  const stack = resolveStack(ctx);
  if (!stack) {
    throw new EnvRequestError(
      ctx.app ? `Could not tell what the ${ctx.app} app of ${ctx.repo} is.` : `Could not tell whether ${ctx.repo} is a backend or a frontend.`
    );
  }
  return roleForStack(stack);
}

function vercelEnvironmentOf(target: string[], gitBranch: string | undefined): HostingEnvVar['environment'] {
  if (target.includes('production')) return 'main';
  if (gitBranch === 'uat' || gitBranch === 'dev' || gitBranch === 'main') return gitBranch;
  return 'all-previews';
}

// ─── Listing ────────────────────────────────────────────────────────────────

export async function listHostingEnv(ctx: HostingContext): Promise<HostingEnvList> {
  const status = await getHostingStatus(ctx);
  const environments = status.role ? hostedEnvironments(status.role) : [];
  const base = { repo: status.repo, role: status.role, state: status.state, ...(status.error ? { error: status.error } : {}), environments };
  if (status.state === 'unavailable' || status.state === 'not_set_up') return { ...base, vars: [] };

  // A status already reads every variable (values withheld); only the
  // Vercel scoping needs re-reading, which the status flattens to a string.
  if (status.platform === 'render') {
    return {
      ...base,
      vars: status.envVars.map(v => ({
        key: v.key,
        environment: v.scope as HostingBranch,
        managedByAlpha: v.managedByAlpha,
        value: v.value
      }))
    };
  }
  const client = vercelClient();
  const project = client ? await client.findProjectByName(hostedNameFor(ctx)) : null;
  const vars = project && client ? await client.listEnvVars(project.id) : [];
  return {
    ...base,
    vars: vars.map(v => ({
      key: v.key,
      environment: vercelEnvironmentOf(v.target, v.gitBranch),
      managedByAlpha: isAlphaManagedKey(v.key),
      value: isAlphaManagedKey(v.key) ? v.value ?? null : null
    }))
  };
}

// ─── Writing ────────────────────────────────────────────────────────────────

function resultOf(changed: string[], failed: EnvChangeResult['failed']): 'ok' | 'partial' | 'failed' {
  if (failed.length === 0) return 'ok';
  return changed.length ? 'partial' : 'failed';
}

async function renderServiceFor(target: HostingTarget, environment: HostingBranch) {
  const client = renderClient();
  if (!client) throw new EnvRequestError('Render is not configured on this server.');
  const names = renderServiceNames(hostedNameFor(target));
  const service = await client.findServiceByName(environment === 'main' ? names.main : names.uat);
  if (!service) throw new EnvRequestError(`${hostedNameFor(target)} has no ${environment} service yet. Set up hosting first.`);
  return { client, service };
}

async function vercelProjectFor(target: HostingTarget) {
  const client = vercelClient();
  if (!client) throw new EnvRequestError('Vercel is not configured on this server.');
  const project = await client.findProjectByName(hostedNameFor(target));
  if (!project) throw new EnvRequestError(`${hostedNameFor(target)} has no Vercel project yet. Set up hosting first.`);
  return { client, project };
}

/** Vercel's scope for an environment: production has no branch, a preview always has one. */
function vercelScope(environment: HostingBranch) {
  return validateEnvironmentScope(
    environment === 'main' ? { lane: 'production', gitBranch: null } : { lane: 'preview', gitBranch: environment }
  );
}

async function redeploy(ctx: HostingContext, environment: HostingBranch): Promise<void> {
  const [owner, name] = ctx.repo.split('/');
  if (platformForStack(resolveStack(ctx)!) === 'render') {
    const { client, service } = await renderServiceFor(ctx, environment);
    await client.triggerDeploy(service.id);
    return;
  }
  const { client, project } = await vercelProjectFor(ctx);
  await client.createDeployment({
    name: hostedNameFor(ctx),
    projectId: project.id,
    org: owner,
    repo: name,
    ref: environment,
    ...(environment === 'main' ? { target: 'production' as const } : {})
  });
}

async function finish(
  ctx: HostingContext,
  environment: HostingBranch,
  action: 'env_set' | 'env_delete',
  changed: string[],
  failed: EnvChangeResult['failed'],
  wantRedeploy: boolean,
  actor: HostingActor,
  workspaceId: string
): Promise<EnvChangeResult> {
  let redeployed = false;
  let redeployError: string | undefined;
  if (wantRedeploy && changed.length) {
    try {
      await redeploy(ctx, environment);
      redeployed = true;
    } catch (err) {
      redeployError = (err as Error).message;
    }
  }
  const allKeys = [...changed, ...failed.map(f => f.key)];
  await recordHostingChange({
    workspaceId,
    repo: ctx.repo,
    environment,
    action,
    keys: allKeys,
    actor,
    result: resultOf(changed, failed),
    ...(failed.length ? { error: failed.map(f => `${f.key}: ${f.error}`).join('; ') } : {})
  });
  if (redeployed || redeployError) {
    await recordHostingChange({
      workspaceId,
      repo: ctx.repo,
      environment,
      action: 'redeploy',
      keys: [],
      actor,
      result: redeployed ? 'ok' : 'failed',
      ...(redeployError ? { error: redeployError } : {})
    });
  }
  return { environment, changed, failed, redeployed, ...(redeployError ? { redeployError } : {}) };
}

export async function setHostingEnv(
  ctx: HostingContext,
  request: EnvWriteRequest,
  actor: HostingActor,
  workspaceId: string
): Promise<EnvChangeResult> {
  const role = roleOf(ctx);
  validateEnvWrite(role, request);
  const { environment } = request;
  const changed: string[] = [];
  const failed: EnvChangeResult['failed'] = [];

  if (role === 'backend') {
    const { client, service } = await renderServiceFor(ctx, environment);
    for (const v of request.vars) {
      try {
        await client.setEnvVar(service.id, v.key, v.value);
        changed.push(v.key);
      } catch (err) {
        failed.push({ key: v.key, error: (err as Error).message });
      }
    }
  } else {
    const { client, project } = await vercelProjectFor(ctx);
    const scope = vercelScope(environment);
    // A branch-scoped variable needs the project linked to its repository.
    if (scope.gitBranch && !project.link?.repo) {
      throw new EnvRequestError(`The Vercel project for ${ctx.repo} is not linked to its repository, so ${environment} variables cannot be set.`);
    }
    for (const v of request.vars) {
      try {
        await client.upsertEnvVars(project.id, [
          { key: v.key, value: v.value, type: 'sensitive', target: [scope.lane], ...(scope.gitBranch ? { gitBranch: scope.gitBranch } : {}) }
        ]);
        changed.push(v.key);
      } catch (err) {
        failed.push({ key: v.key, error: (err as Error).message });
      }
    }
  }

  return finish(ctx, environment, 'env_set', changed, failed, request.redeploy !== false, actor, workspaceId);
}

export async function deleteHostingEnv(
  ctx: HostingContext,
  environment: HostingBranch,
  key: string,
  options: { redeploy?: boolean },
  actor: HostingActor,
  workspaceId: string
): Promise<EnvChangeResult> {
  const role = roleOf(ctx);
  if (!hostedEnvironments(role).includes(environment)) throw new EnvRequestError(`This repository is not hosted in ${environment}.`);
  const problem = keyProblem(key);
  if (problem) throw new EnvRequestError(problem);

  const changed: string[] = [];
  const failed: EnvChangeResult['failed'] = [];
  try {
    if (role === 'backend') {
      const { client, service } = await renderServiceFor(ctx, environment);
      await client.deleteEnvVar(service.id, key);
    } else {
      const { client, project } = await vercelProjectFor(ctx);
      const scope = vercelScope(environment);
      // Matched on the branch too: the same key usually exists once per environment.
      const record = (await client.listEnvVars(project.id)).find(
        v =>
          v.key === key &&
          v.target.includes(scope.lane) &&
          (scope.gitBranch ? v.gitBranch === scope.gitBranch : !v.gitBranch)
      );
      if (!record?.id) throw new EnvRequestError(`${key} is not set in ${environment}.`);
      await client.deleteEnvVar(project.id, record.id);
    }
    changed.push(key);
  } catch (err) {
    if (err instanceof EnvRequestError) throw err;
    failed.push({ key, error: (err as Error).message });
  }

  return finish(ctx, environment, 'env_delete', changed, failed, options.redeploy !== false, actor, workspaceId);
}
