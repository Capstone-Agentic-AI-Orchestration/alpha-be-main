import { githubApi, GitHubApiError, type GitHubApi } from './githubApi.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * The branches every provisioned repository starts with, in promotion order.
 *
 * Work lands on `dev`, is promoted to `uat` for acceptance, and reaches `main`
 * for production. All three start at the same commit, so the first promotion
 * PR has nothing but real changes in it.
 */
export const PIPELINE_BRANCHES = ['dev', 'uat', 'main'] as const;

/** Branches only a pull request should change: promotion targets. */
export const PROTECTED_PIPELINE_BRANCHES = ['uat', 'main'] as const;

/**
 * The GitHub Actions app. Required checks are pinned to it, so a status some
 * other integration posts under the same name cannot satisfy them.
 */
const GITHUB_ACTIONS_APP_ID = 15368;

export interface RepoFile {
  path: string;
  content: string;
  /** Written with mode 100755 (a script). */
  executable?: boolean;
}

export interface ProvisionRepositoryInput {
  org: string;
  name: string;
  visibility?: 'private' | 'public';
  description?: string;
  files: RepoFile[];
  message: string;
  /**
   * CI check names a pull request into `uat` or `main` must pass. Empty
   * means the branches are PR-only with no check required.
   */
  requiredChecks?: string[];
}

export interface ProvisionedRepository {
  url: string;
  nameWithOwner: string;
  commitSha: string;
  branches: string[];
  /** Branches GitHub now enforces PR-only changes on. */
  protectedBranches: string[];
  /**
   * Why GitHub would not protect them, when it would not -- typically a
   * private repository on the free plan. Alpha then enforces promotion itself:
   * its agents never push to pipeline branches, and promotion is by PR.
   */
  protectionUnavailable?: string;
}

interface CreatedRepo {
  html_url: string;
  full_name: string;
  default_branch?: string;
}

/** A just-created repository's first ref can lag its creation by a moment. */
async function refSha(api: GitHubApi, repo: string, branch: string, attempts = 6): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const ref = await api.get<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${branch}`);
      return ref.object.sha;
    } catch (err) {
      const retriable = err instanceof GitHubApiError && (err.status === 404 || err.status === 409);
      if (!retriable || attempt >= attempts) throw err;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
}

/**
 * Create an organization repository whose whole history is one commit holding
 * `files`, on `dev`, `uat` and `main` alike.
 *
 * Through the Git Data API rather than a local push, so it works the same from
 * the cloud (which has no checkout to push) as from a desktop, and rather than
 * one Contents API write per file -- 30 files would be 30 commits, 30 webhook
 * deliveries and a rate-limit risk. GitHub refuses Git Data writes to an empty
 * repository, so it is created with GitHub's own first commit and then that
 * history is replaced wholesale: the tree is built in one request, committed
 * with no parent, and `main` is moved onto it.
 *
 * If anything after creation fails, the repository is deleted again, so a
 * failure never leaves a half-provisioned repository behind to trip the next
 * attempt with "name already exists".
 */
export async function provisionRepository(
  input: ProvisionRepositoryInput,
  api: GitHubApi = githubApi()
): Promise<ProvisionedRepository> {
  const org = input.org.trim();
  if (!org) throw new Error('An organization is required. Alpha does not create personal repositories.');
  if (input.files.length === 0) throw new Error('A repository needs at least one file.');

  const created = await api.post<CreatedRepo>(`/orgs/${org}/repos`, {
    name: input.name,
    private: (input.visibility ?? 'private') === 'private',
    ...(input.description ? { description: input.description } : {}),
    auto_init: true
  });
  const repo = created.full_name;

  try {
    const initialBranch = created.default_branch || 'main';
    await refSha(api, repo, initialBranch);

    const tree = await api.post<{ sha: string }>(`/repos/${repo}/git/trees`, {
      tree: input.files.map(file => ({
        path: file.path,
        mode: file.executable ? '100755' : '100644',
        type: 'blob',
        content: file.content
      }))
    });

    const commit = await api.post<{ sha: string }>(`/repos/${repo}/git/commits`, {
      message: input.message,
      tree: tree.sha,
      parents: []
    });

    if (initialBranch === 'main') {
      await api.patch(`/repos/${repo}/git/refs/heads/main`, { sha: commit.sha, force: true });
    } else {
      // An organization whose default branch is something else: make `main`
      // the default, then drop the placeholder branch GitHub initialized.
      await api.post(`/repos/${repo}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha });
      await api.patch(`/repos/${repo}`, { default_branch: 'main' });
      await api.delete(`/repos/${repo}/git/refs/heads/${initialBranch}`);
    }

    for (const branch of PIPELINE_BRANCHES) {
      if (branch === 'main') continue;
      await api.post(`/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    }

    const { protectedBranches, protectionUnavailable } = await protectPipelineBranches(api, repo, input.requiredChecks ?? []);

    logInfo(
      `Provisioned ${repo}: ${input.files.length} files in one commit on ${PIPELINE_BRANCHES.join('/')}` +
        (protectionUnavailable ? `; unprotected (${protectionUnavailable})` : '')
    );

    return {
      url: created.html_url,
      nameWithOwner: repo,
      commitSha: commit.sha,
      branches: [...PIPELINE_BRANCHES],
      protectedBranches,
      ...(protectionUnavailable ? { protectionUnavailable } : {})
    };
  } catch (err) {
    try {
      await api.delete(`/repos/${repo}`);
    } catch (cleanup) {
      logError(`Could not delete half-provisioned ${repo}; remove it by hand:`, (cleanup as Error).message);
    }
    throw err;
  }
}

/**
 * Ask GitHub to make `uat` and `main` pull-request only, and to hold a pull
 * request until `requiredChecks` pass, so a red CI cannot be promoted.
 *
 * Not fatal when GitHub declines. A private repository on an organization's
 * free plan cannot be protected at all, and the answer then is Alpha's own
 * rule rather than no repository.
 */
async function protectPipelineBranches(
  api: GitHubApi,
  repo: string,
  requiredChecks: string[]
): Promise<{ protectedBranches: string[]; protectionUnavailable?: string }> {
  const protectedBranches: string[] = [];
  for (const branch of PROTECTED_PIPELINE_BRANCHES) {
    try {
      await api.put(`/repos/${repo}/branches/${branch}/protection`, {
        // strict stays off: a promotion PR's head is the branch below, and
        // requiring it to be up to date with the target would block promotion.
        required_status_checks: requiredChecks.length
          ? { strict: false, checks: requiredChecks.map(context => ({ context, app_id: GITHUB_ACTIONS_APP_ID })) }
          : null,
        // Administrators included. Agents act with a developer's GitHub
        // account, often an administrator's; without this, a red check could
        // be merged past by anyone, or any agent, holding admin rights.
        enforce_admins: true,
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false
      });
      protectedBranches.push(branch);
    } catch (err) {
      if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
        return { protectedBranches, protectionUnavailable: err.message.replace(/^GitHub \d+ on \S+ \S+: /, '') };
      }
      throw err;
    }
  }
  return { protectedBranches };
}
