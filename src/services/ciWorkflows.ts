import { ALPHAORCH_WORKFLOW_REF, ALPHAORCH_WORKFLOW_REPO } from '../config/env.js';
import type { RepoFile } from './githubRepoProvisioning.js';
import type { CanonicalStack } from './scaffoldBuilder.js';

/**
 * CI/CD for a provisioned repository, from alphaorch-workflow.
 *
 * Each stack gets that repository's customer template as its
 * `.github/workflows/ci.yml`: unit tests, lint and a security scan on every
 * push and PR to dev/uat/main, then a deploy -- Render for a backend, Vercel
 * for a frontend. The templates are read from the workflow repository at
 * provisioning time rather than copied into Alpha, so there is one version of
 * them, the one their reusable workflows are tested against.
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

/** What the deploy job needs set on the repository before it can run. */
const DEPLOY_SECRETS: Record<DeployTarget, string[]> = {
  render: ['RENDER_DEPLOY_HOOK_URL_DEV', 'RENDER_DEPLOY_HOOK_URL_UAT', 'RENDER_DEPLOY_HOOK_URL_MAIN'],
  vercel: ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']
};

/**
 * The repository variable that turns deploys on.
 *
 * A new repository has none of the deploy secrets, and the Vercel workflow
 * declares its secrets required -- so an ungated deploy job would fail the
 * very first push. Gated, the job is skipped (and its secrets never checked)
 * until someone has set the secrets and this variable to `true`.
 */
export const DEPLOY_VARIABLE = 'ALPHAORCH_DEPLOY';

const TEMPLATE_REPO = 'Capstone-Agentic-AI-Orchestration/alphaorch-workflow';

export interface CiWorkflowPlan {
  files: RepoFile[];
  /** Null when the deploy job was left out. */
  deployTarget: DeployTarget | null;
  /** Secrets to set on the repository for the deploy job. */
  requiredSecrets: string[];
  /** Set to `true` on the repository once the secrets are in place. */
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

/** Add `&& vars.<name> == 'true'` to a job's `if:` expression. */
export function gateJob(yaml: string, job: string, variable: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex(line => line.replace(/\r$/, '') === `  ${job}:`);
  if (start < 0) throw new Error(`The CI template has no "${job}" job to gate.`);
  for (let i = start + 1; i < lines.length && /^ {3,}|^\s*$/.test(lines[i]); i++) {
    const match = /^(\s+if: \$\{\{ )(.*)( \}\}\s*)$/.exec(lines[i].replace(/\r$/, ''));
    if (match) {
      lines[i] = `${match[1]}(${match[2]}) && vars.${variable} == 'true'${match[3].trimEnd()}`;
      return lines.join('\n');
    }
  }
  // No condition yet: add one straight under the job key.
  lines.splice(start + 1, 0, `    if: \${{ vars.${variable} == 'true' }}`);
  return lines.join('\n');
}

/**
 * The CI workflow files for a new repository of `stack`.
 *
 * Throws, before anything is created on GitHub, when the template cannot be
 * read: a repository provisioned without its CI is the thing this exists to
 * prevent.
 */
export async function buildCiWorkflows(
  options: { stack: CanonicalStack; deploy?: boolean },
  fetchImpl: typeof fetch = fetch
): Promise<CiWorkflowPlan> {
  const pipeline = PIPELINES[options.stack];
  const deploy = options.deploy !== false;
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
  // A fork of the workflow repository: call its reusable workflows, not ours.
  if (ALPHAORCH_WORKFLOW_REPO !== TEMPLATE_REPO) {
    yaml = yaml.split(`${TEMPLATE_REPO}/`).join(`${ALPHAORCH_WORKFLOW_REPO}/`);
  }
  yaml = deploy ? gateJob(yaml, pipeline.deployJob, DEPLOY_VARIABLE) : withoutJob(yaml, pipeline.deployJob);

  const header = [
    `# Generated by Alpha from ${source}.`,
    deploy
      ? `# Deploys to ${pipeline.deployTarget === 'render' ? 'Render' : 'Vercel'} once the repository has ` +
        `${DEPLOY_SECRETS[pipeline.deployTarget].join(', ')} and the variable ${DEPLOY_VARIABLE}=true.`
      : '# Deploys were not requested for this repository.',
    ''
  ].join('\n');

  return {
    files: [{ path: '.github/workflows/ci.yml', content: `${header}${yaml}` }],
    deployTarget: deploy ? pipeline.deployTarget : null,
    requiredSecrets: deploy ? DEPLOY_SECRETS[pipeline.deployTarget] : [],
    deployVariable: deploy ? DEPLOY_VARIABLE : null,
    source
  };
}
