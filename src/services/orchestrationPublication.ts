import path from 'node:path';
import type { IssueStore } from '../store/issueStore.js';
import { issueStore } from '../store/stores.js';
import { githubService, type IGitHubService } from './githubService.js';
import { findOpenPullRequest, isSafeBranchName, listBranches as listRemoteBranches } from './githubRepoWorkspace.js';
import { getOrchestrationFinalValidationEvidence } from './orchestrationReviewService.js';
import { sqliteService, type SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { synchronizePublishedOrchestrationIssue } from './orchestrationFinalization.js';
import { getCurrentBranch, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import type { OrchestrationPublicationRecord, OrchestrationSnapshot } from './orchestrationStateMachine.js';

type GitHubPublisher = Pick<IGitHubService,
  'checkAuth' | 'inspectLocalRepo' | 'getRepository' | 'listBranches' | 'pushBranch' | 'createPullRequest'>;

export interface OrchestrationPublicationDependencies {
  store?: SQLiteService;
  issues?: Pick<IssueStore, 'get' | 'update' | 'addComment'>;
  github?: GitHubPublisher;
  listRemoteBranches?: typeof listRemoteBranches;
  findOpenPullRequest?: typeof findOpenPullRequest;
  now?: () => string;
}

interface ApprovalEvidence extends Record<string, unknown> {
  decision: 'approved';
  approvedBy: string;
  approvedAt: string;
  resultCommit: string;
  branchName: string;
  publicationBaseBranch: string;
  publicationTargets?: Array<{
    repository: string;
    branchName: string;
    resultCommit: string;
    publicationBaseBranch: string;
  }>;
}

interface PublicationTarget {
  repository: string;
  branchName: string;
  resultCommit: string;
  publicationBaseBranch: string;
}

function canonicalRepo(value: string): string {
  const normalized = value.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(normalized) || normalized.includes('..')) {
    throw new Error('This build is not attached to a publishable GitHub repository. Reconnect the project repository before approval.');
  }
  return normalized;
}

function asApprovalEvidence(value: unknown): ApprovalEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const evidence = value as Record<string, unknown>;
  if (evidence.decision !== 'approved' || typeof evidence.approvedBy !== 'string' ||
      typeof evidence.approvedAt !== 'string' || typeof evidence.resultCommit !== 'string' ||
      typeof evidence.branchName !== 'string' || typeof evidence.publicationBaseBranch !== 'string') return undefined;
  return evidence as ApprovalEvidence;
}

function approvalEvidenceFor(snapshot: OrchestrationSnapshot, store: SQLiteService): ApprovalEvidence {
  const event = runWithWorkspace(snapshot.run.workspaceId, () => store.listOrchestrationEvents(snapshot.run.id, 0, 500))
    .reverse()
    .find(item => item.type === 'run_publishing' && asApprovalEvidence(item.payload.evidence));
  const evidence = asApprovalEvidence(event?.payload.evidence);
  if (!evidence) throw new Error('The durable human approval checkpoint is missing. Reopen the final review before publishing.');
  return evidence;
}

function validationEvidence(snapshot: OrchestrationSnapshot, store: SQLiteService) {
  const evidence = getOrchestrationFinalValidationEvidence(snapshot, store);
  if (snapshot.run.branchName !== evidence.branchName || !snapshot.run.branchName ||
      evidence.resultCommit !== approvalEvidenceFor(snapshot, store).resultCommit) {
    throw new Error('The publication checkpoint no longer matches the validated branch and commit. Re-review the saved build.');
  }
  return evidence;
}

function repositoryWorkspaces(snapshot: OrchestrationSnapshot) {
  return snapshot.run.repositoryWorkspaces?.length
    ? snapshot.run.repositoryWorkspaces
    : snapshot.run.worktreePath && snapshot.run.branchName && snapshot.run.baseCommit
      ? [{ repository: snapshot.run.repository, branchName: snapshot.run.branchName,
          baseRef: snapshot.run.baseRef ?? '', baseCommit: snapshot.run.baseCommit, worktreePath: snapshot.run.worktreePath }]
      : [];
}

function validationForRepository(snapshot: OrchestrationSnapshot, evidence: ReturnType<typeof getOrchestrationFinalValidationEvidence>, repository: string) {
  const item = Array.isArray(evidence.repositories)
    ? evidence.repositories.find(candidate => candidate && typeof candidate === 'object' &&
        (candidate as Record<string, unknown>).repository === repository) as Record<string, unknown> | undefined
    : undefined;
  if (item) return {
    resultCommit: item.resultCommit as string,
    branchName: item.branchName as string
  };
  if (repository === snapshot.run.repository) return { resultCommit: evidence.resultCommit, branchName: evidence.branchName };
  throw new Error(`Final validation evidence for ${repository} is missing. Run checks for every selected codebase before approval.`);
}

async function assertPublishedWorkspace(
  workspace: { repository: string; branchName: string; worktreePath: string },
  store: SQLiteService,
  github: GitHubPublisher,
  resultCommit: string
): Promise<{ cwd: string; repo: string; branchName: string }> {
  const cwd = workspace.worktreePath ? path.resolve(workspace.worktreePath) : '';
  const repo = canonicalRepo(workspace.repository);
  const branchName = workspace.branchName;
  if (!cwd || !store.isPathAllowed(cwd) || !branchName || !isSafeBranchName(branchName)) {
    throw new Error('The validated build workspace is unavailable or outside the approved project folder. Reconcile the saved build before publishing.');
  }
  const inspection = await github.inspectLocalRepo(cwd);
  if (!inspection.isRepo || !inspection.ownerRepo || canonicalRepo(inspection.ownerRepo).toLowerCase() !== repo.toLowerCase()) {
    throw new Error('The build worktree remote does not match the project repository. Reconnect it and review the branch before publishing.');
  }
  const [branch, head, clean] = await Promise.all([
    getCurrentBranch(cwd),
    getHeadCommit(cwd),
    isGitWorkingTreeClean(cwd)
  ]);
  if (branch !== branchName || head !== resultCommit || !clean) {
    throw new Error('The approved branch changed after validation. Re-run final checks before publishing it.');
  }
  return { cwd, repo, branchName };
}

function pullRequestBody(snapshot: OrchestrationSnapshot, repository: string, resultCommit: string, checkCommands: string[]): string {
  const requiredTasks = snapshot.tasks.filter(task => task.required &&
    (task.repository ?? snapshot.run.repository).toLowerCase() === repository.toLowerCase());
  const requirements = snapshot.run.plan.requirements.slice(0, 20)
    .map(requirement => `- **${requirement.id}:** ${requirement.description}`);
  const checks = checkCommands.length ? checkCommands.map(command => `- \`${command}\` — passed`) : ['- Final validation passed in Alpha.'];
  return [
    '## Summary',
    snapshot.run.plan.goal,
    '',
    '## Specialist work',
    ...requiredTasks.map(task => `- **${task.title}** (${task.kind})`),
    '',
    '## Requirements covered',
    ...requirements,
    '',
    '## Final validation',
    ...checks,
    '',
    `Validated commit: \`${resultCommit}\``,
    '',
    `Reviewed and approved in Alpha build \`${snapshot.run.id}\`.`
  ].join('\n').slice(0, 12_000);
}

export class OrchestrationPublicationService {
  private readonly store: SQLiteService;
  private readonly issues: Pick<IssueStore, 'get' | 'update' | 'addComment'>;
  private readonly github: GitHubPublisher;
  private readonly listRemoteBranches: typeof listRemoteBranches;
  private readonly findOpenPullRequest: typeof findOpenPullRequest;
  private readonly now: () => string;

  constructor(dependencies: OrchestrationPublicationDependencies = {}) {
    this.store = dependencies.store ?? sqliteService;
    this.issues = dependencies.issues ?? issueStore();
    this.github = dependencies.github ?? githubService;
    this.listRemoteBranches = dependencies.listRemoteBranches ?? listRemoteBranches;
    this.findOpenPullRequest = dependencies.findOpenPullRequest ?? findOpenPullRequest;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /** Resolve every repository target before approval is committed. */
  async prepare(snapshot: OrchestrationSnapshot): Promise<{ publicationBaseBranch: string; resultCommit: string; publicationTargets: PublicationTarget[] }> {
    if (snapshot.run.status !== 'awaiting_approval') throw new Error('This build is no longer waiting for human approval.');
    const evidence = getOrchestrationFinalValidationEvidence(snapshot, this.store);
    const auth = await this.github.checkAuth();
    if (!auth.authenticated) throw new Error('Sign in to GitHub in Connected Accounts before approving and publishing this build.');
    const workspaces = repositoryWorkspaces(snapshot);
    if (!workspaces.length) throw new Error('The reviewed build workspaces are unavailable. Reconcile the build before approval.');
    const publicationTargets = await Promise.all(workspaces.map(async workspace => {
      const validated = validationForRepository(snapshot, evidence, workspace.repository);
      await assertPublishedWorkspace(workspace, this.store, this.github, validated.resultCommit);
      const repo = canonicalRepo(workspace.repository);
      const [remoteRepo, branches] = await Promise.all([
        this.github.getRepository(repo),
        this.github.listBranches(repo, 200)
      ]);
      if (canonicalRepo(remoteRepo.nameWithOwner).toLowerCase() !== repo.toLowerCase()) {
        throw new Error(`GitHub resolved a different repository than ${repo}.`);
      }
      const baseBranch = branches.some(branch => branch.name === 'dev') ? 'dev' : remoteRepo.defaultBranch;
      if (!baseBranch || !isSafeBranchName(baseBranch) || baseBranch === workspace.branchName) {
        throw new Error(`Alpha could not resolve a safe pull request target for ${repo}.`);
      }
      return { repository: repo, branchName: workspace.branchName, resultCommit: validated.resultCommit, publicationBaseBranch: baseBranch };
    }));
    const primary = publicationTargets.find(target => target.repository.toLowerCase() === canonicalRepo(snapshot.run.repository).toLowerCase()) ?? publicationTargets[0];
    return { publicationBaseBranch: primary.publicationBaseBranch, resultCommit: primary.resultCommit, publicationTargets };
  }

  async publishAll(snapshot: OrchestrationSnapshot): Promise<OrchestrationPublicationRecord[]> {
    if (snapshot.run.status !== 'publishing') throw new Error('This build has no pending publication to reconcile.');
    const approval = approvalEvidenceFor(snapshot, this.store);
    const evidence = validationEvidence(snapshot, this.store);
    const auth = await this.github.checkAuth();
    if (!auth.authenticated) throw new Error('Sign in to GitHub in Connected Accounts, then retry publication.');
    const workspaces = repositoryWorkspaces(snapshot);
    const savedTargets = approval.publicationTargets?.length ? approval.publicationTargets : [{
      repository: snapshot.run.repository, branchName: approval.branchName,
      resultCommit: approval.resultCommit, publicationBaseBranch: approval.publicationBaseBranch
    }];
    if (savedTargets.length !== workspaces.length) throw new Error('The saved approval does not cover every selected codebase. Reopen final review before retrying publication.');
    const targets = savedTargets.map(target => {
      const workspace = workspaces.find(item => canonicalRepo(item.repository).toLowerCase() === canonicalRepo(target.repository).toLowerCase());
      if (!workspace || workspace.branchName !== target.branchName || !isSafeBranchName(target.publicationBaseBranch) ||
          target.publicationBaseBranch === target.branchName) {
        throw new Error(`The saved publication target for ${target.repository} is invalid. Reopen final review and resolve the repository setup.`);
      }
      const validated = validationForRepository(snapshot, evidence, target.repository);
      if (validated.resultCommit !== target.resultCommit || validated.branchName !== target.branchName) {
        throw new Error(`The validated branch for ${target.repository} no longer matches approval. Run final checks again.`);
      }
      return { workspace, target };
    });
    const issue = await this.issues.get(snapshot.run.workspaceId, snapshot.run.issueId);
    if (!issue || issue.projectId !== snapshot.run.projectId) {
      throw new Error('The linked project issue is unavailable. Reconnect it before opening the pull requests.');
    }
    const published: OrchestrationPublicationRecord[] = [];
    for (const { workspace, target } of targets) {
      const { cwd, repo, branchName } = await assertPublishedWorkspace(workspace, this.store, this.github, target.resultCommit);
      await this.github.pushBranch(cwd, branchName, repo);
      const remoteBranches = await this.listRemoteBranches(repo);
      const remoteHead = remoteBranches.find(branch => branch.name === branchName)?.sha;
      if (remoteHead?.toLowerCase() !== target.resultCommit.toLowerCase()) {
        throw new Error(`GitHub does not show the validated commit on ${repo} yet. Retry publication to reconcile it safely.`);
      }

      let pullRequest = await this.findOpenPullRequest(repo, branchName, target.publicationBaseBranch);
      if (!pullRequest) {
        const repoEvidence = Array.isArray(evidence.repositories)
          ? evidence.repositories.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).repository === repo) as Record<string, unknown> | undefined
          : undefined;
        const checks = repoEvidence?.checks && typeof repoEvidence.checks === 'object' ? repoEvidence.checks as Record<string, unknown> : evidence.checks;
        const observed = Array.isArray(checks.observed) ? checks.observed as Array<Record<string, unknown>> : [];
        const commands = observed.map(check => typeof check.command === 'string' ? check.command : undefined).filter((value): value is string => Boolean(value));
        const title = `feat: ${issue.title} [${issue.identifier}]`.slice(0, 256);
        try {
          const url = await this.github.createPullRequest(
            cwd, title, pullRequestBody(snapshot, repo, target.resultCommit, commands), target.publicationBaseBranch, branchName
          );
          const match = url.match(/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)$/);
          if (!match) throw new Error('GitHub returned an invalid pull request link.');
          pullRequest = { number: Number(match[1]), url };
        } catch (error) {
          const reconciled = await this.findOpenPullRequest(repo, branchName, target.publicationBaseBranch).catch(() => undefined);
          if (!reconciled) throw error;
          pullRequest = reconciled;
        }
      }
      published.push({ repository: repo, branchName, baseBranch: target.publicationBaseBranch,
        resultCommit: target.resultCommit, pullRequestUrl: pullRequest.url, publishedAt: this.now() });
    }
    return published;
  }

  /** Backward-compatible primary pull request for older callers. */
  async publish(snapshot: OrchestrationSnapshot): Promise<OrchestrationPublicationRecord> {
    const publications = await this.publishAll(snapshot);
    const primary = publications.find(item => item.repository?.toLowerCase() === canonicalRepo(snapshot.run.repository).toLowerCase()) ?? publications[0];
    if (!primary) throw new Error('No codebase pull request was published.');
    return primary;
  }

  async synchronizePublishedIssue(snapshot: OrchestrationSnapshot): Promise<void> {
    await synchronizePublishedOrchestrationIssue(snapshot, this.issues);
  }
}

export const orchestrationPublicationService = new OrchestrationPublicationService();
