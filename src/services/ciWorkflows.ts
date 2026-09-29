import { ALPHAORCH_WORKFLOW_REF, ALPHAORCH_WORKFLOW_REPO } from '../config/env.js';
import type { RepoFile } from './githubRepoProvisioning.js';
import type { CanonicalStack } from './scaffoldBuilder.js';

/**
 * CI/CD for a provisioned repository, from alphaorch-workflow.
 *
 * Each stack gets that repository's customer template as its
 * `.github/workflows/ci.yml`: unit tests, lint and a security scan on every
 * push and PR to dev/uat/main. The templates are read from the workflow
 * repository at provisioning time rather than copied into Alpha, so there is
 * one version of them, the one their reusable workflows are tested against.
 *
 * There is no deploy job in it, for either stack, ever. That used to be a
 * gated GitHub Actions job waiting on repository secrets nobody had set yet
 * (`RENDER_DEPLOY_HOOK_URL_*`, `VERCEL_TOKEN`, ...). Render and Vercel now
 * deploy a repository themselves, through their own GitHub Apps, the moment
 * Alpha sets it up on their side (see `services/hosting`) -- so a workflow
 * job that pushes to them would be a second, redundant deploy path with its
 * own secrets to provision and its own way to drift from what is actually
 * live. `deployTarget` survives as which platform a stack hosts on, because
 * the scaffold's README and `hostingService` still need to say so.
 */

export type DeployTarget = 'render' | 'vercel';

interface StackPipeline {
  template: string;
  deployTarget: DeployTarget;
  deployJob: string;
}

const PIPELINES: Record<CanonicalStack, StackPipeline> = {
  nodejs: { template: 'be-nodejs.yml', deployTarget: 'render', deployJob: 'deploy-render' },
  nestjs: { template: 'be-nestjs.yml', deployTarget: 'render', deployJob: 'deploy-render' },
  nextjs: { template: 'fe-nextjs.yml', deployTarget: 'vercel', deployJob: 'deploy-vercel' },
  react: { template: 'fe-react.yml', deployTarget: 'vercel', deployJob: 'deploy-vercel' }
};

/**
 * `uses: <owner>/<repo>/.github/workflows/...` -- a call into the workflow
 * library itself. Third-party actions (`actions/checkout@v6`) have no
 * `.github/workflows/` segment and are never matched.
 */
const LIBRARY_CALL = /(uses:\s*)[\w.-]+\/[\w.-]+(\/\.github\/(?:workflows|actions)\/)/g;

export interface CiWorkflowPlan {
  files: RepoFile[];
  /** Which platform Alpha hosts this stack on -- informational; nothing here gates on it. */
  deployTarget: DeployTarget;
  /** Always empty: hosting deploys through the platform's own GitHub App, not a repository secret. */
  requiredSecrets: string[];
  /** Always null, for the same reason. */
  deployVariable: string | null;
  /** Where the template came from, for the README and for debugging. */
  source: string;
}

/** Remove one top-level job (two-space key under `jobs:`) and everything indented under it. */
export function withoutJob(yaml: string, job: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex(line => line === `  ${job}:` || line === `  ${job}:\r`);
  if (start < 0) throw new Error(`The CI template has no "${job}" job to remove.`);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^ {3,}/.test(lines[end]))) end++;
  // Keep the blank line that separated it from what follows, if any.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * The CI workflow files for a new repository of `stack`.
 *
 * Throws, before anything is created on GitHub, when the template cannot be
 * read: a repository provisioned without its CI is the thing this exists to
 * prevent.
 */
export async function buildCiWorkflows(
  options: { stack: CanonicalStack },
  fetchImpl: typeof fetch = fetch
): Promise<CiWorkflowPlan> {
  if (!ALPHAORCH_WORKFLOW_REPO || !ALPHAORCH_WORKFLOW_REF) {
    throw new Error(
      'This Alpha server has no CI template repository configured. Set ALPHAORCH_WORKFLOW_REPO and ' +
        'ALPHAORCH_WORKFLOW_REF; no repository was created.'
    );
  }
  const pipeline = PIPELINES[options.stack];
  const source = `${ALPHAORCH_WORKFLOW_REPO}@${ALPHAORCH_WORKFLOW_REF}:workflow-templates/customer/${pipeline.template}`;
  const url = `https://raw.githubusercontent.com/${ALPHAORCH_WORKFLOW_REPO}/${ALPHAORCH_WORKFLOW_REF}/workflow-templates/customer/${pipeline.template}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': 'Alpha' } });
  } catch (err) {
    throw new Error(`Could not read the CI template ${source}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Could not read the CI template ${source} (HTTP ${res.status}).`);

  let yaml = (await res.text()).replace(/\r\n/g, '\n');
  // The library's reusable workflows are called from the same repository the
  // templates were read from -- which also makes a fork call its own, with no
  // library name written into Alpha.
  yaml = yaml.replace(LIBRARY_CALL, `$1${ALPHAORCH_WORKFLOW_REPO}$2`);
  // Render and Vercel deploy through their own GitHub App, not this workflow.
  yaml = withoutJob(yaml, pipeline.deployJob);

  const header = [
    `# Generated by Alpha from ${source}.`,
    `# Hosting is set up separately by Alpha, on ${pipeline.deployTarget === 'render' ? 'Render' : 'Vercel'}.`,
    ''
  ].join('\n');

  return {
    files: [{ path: '.github/workflows/ci.yml', content: `${header}${yaml}` }],
    deployTarget: pipeline.deployTarget,
    requiredSecrets: [],
    deployVariable: null,
    source
  };
}
