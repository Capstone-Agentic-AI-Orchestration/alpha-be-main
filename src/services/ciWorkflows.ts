import { ALPHAORCH_WORKFLOW_REF, ALPHAORCH_WORKFLOW_REPO } from '../config/env.js';
import type { RepoFile } from './githubRepoProvisioning.js';
import type { CanonicalStack } from './scaffoldBuilder.js';

/**
 * CI for a provisioned repository, from the workflow library.
 *
 * Each stack gets the library's Alpha-hosted caller as its
 * `.github/workflows/ci.yml` -- unit tests, lint and a security scan on every
 * push and PR to dev/uat/main -- and `post-deploy-verify.yml`, which checks a
 * deployment answers once the platform reports it. Both are read from
 * `workflow-templates/product/` at provisioning time rather than copied into
 * Alpha, so there is one version of them, the one their reusable workflows
 * are tested against.
 *
 * Those callers have no deploy job, by design: Render and Vercel deploy a
 * repository themselves, through their own GitHub apps, once Alpha sets it
 * up on their side (see `services/hosting`). A workflow that pushed to them
 * too would be a second deploy path with its own secrets and its own way to
 * drift from what is live. The library keeps the deploy-less callers under
 * test (`workflow-validation.yml`), so nothing here edits a template's YAML.
 * `deployTarget` survives as which platform a stack hosts on, because the
 * scaffold's README and `hostingService` still need to say so.
 */

export type DeployTarget = 'render' | 'vercel';

interface StackPipeline {
  template: string;
  deployTarget: DeployTarget;
  requiredChecks: readonly string[];
}

/**
 * The checks a pull request into `uat` or `main` has to pass, by the names
 * GitHub gives the template's jobs: `<caller job> / <reusable workflow job>`,
 * or the caller job alone when it runs its own steps. Jobs that only run when
 * configured (Docker, integration tests) are left out, because a required
 * check that never reports blocks every merge.
 */
const SHARED_CHECKS = ['lint / Lint & Style Check', 'security / Dependency Audit', 'security / License Compliance'];
const BACKEND_CHECKS = ['unit-tests / Backend Unit Tests', ...SHARED_CHECKS];
const FRONTEND_CHECKS = ['unit-tests / Frontend Unit Tests', ...SHARED_CHECKS, 'build'];

const PIPELINES: Record<CanonicalStack, StackPipeline> = {
  nodejs: { template: 'be-nodejs.yml', deployTarget: 'render', requiredChecks: BACKEND_CHECKS },
  nestjs: { template: 'be-nestjs.yml', deployTarget: 'render', requiredChecks: BACKEND_CHECKS },
  nextjs: { template: 'fe-nextjs.yml', deployTarget: 'vercel', requiredChecks: FRONTEND_CHECKS },
  react: { template: 'fe-react.yml', deployTarget: 'vercel', requiredChecks: FRONTEND_CHECKS }
};

const TEMPLATE_DIR = 'workflow-templates/product';
const VERIFY_TEMPLATE = 'post-deploy-verify.yml';

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
  /** CI checks a pull request into a protected pipeline branch must pass. */
  requiredChecks: string[];
  /** Always empty: hosting deploys through the platform's own GitHub App, not a repository secret. */
  requiredSecrets: string[];
  /** Always null, for the same reason. */
  deployVariable: string | null;
  /** Where the CI template came from, for the README and for debugging. */
  source: string;
}

async function readTemplate(name: string, fetchImpl: typeof fetch): Promise<{ yaml: string; source: string }> {
  const source = `${ALPHAORCH_WORKFLOW_REPO}@${ALPHAORCH_WORKFLOW_REF}:${TEMPLATE_DIR}/${name}`;
  const url = `https://raw.githubusercontent.com/${ALPHAORCH_WORKFLOW_REPO}/${ALPHAORCH_WORKFLOW_REF}/${TEMPLATE_DIR}/${name}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': 'Alpha' } });
  } catch (err) {
    throw new Error(`Could not read the CI template ${source}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Could not read the CI template ${source} (HTTP ${res.status}).`);
  // The library's reusable workflows are called from the same repository the
  // templates were read from -- which also makes a fork call its own, with no
  // library name written into Alpha.
  const yaml = (await res.text()).replace(/\r\n/g, '\n').replace(LIBRARY_CALL, `$1${ALPHAORCH_WORKFLOW_REPO}$2`);
  return { yaml, source };
}

/**
 * The CI workflow files for a new repository of `stack`.
 *
 * Throws, before anything is created on GitHub, when a template cannot be
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
  const [ci, verify] = await Promise.all([readTemplate(pipeline.template, fetchImpl), readTemplate(VERIFY_TEMPLATE, fetchImpl)]);
  const platform = pipeline.deployTarget === 'render' ? 'Render' : 'Vercel';

  const header = (source: string) => [`# Generated by Alpha from ${source}.`, `# Hosting is set up separately by Alpha, on ${platform}.`, ''].join('\n');

  return {
    files: [
      { path: '.github/workflows/ci.yml', content: `${header(ci.source)}${ci.yaml}` },
      { path: '.github/workflows/post-deploy-verify.yml', content: `${header(verify.source)}${verify.yaml}` }
    ],
    deployTarget: pipeline.deployTarget,
    requiredChecks: [...pipeline.requiredChecks],
    requiredSecrets: [],
    deployVariable: null,
    source: ci.source
  };
}
