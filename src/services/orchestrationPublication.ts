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

async function assertPublishedWorkspace(
  snapshot: OrchestrationSnapshot,
  store: SQLiteService,
  github: GitHubPublisher,
  resultCommit: string
): Promise<{ cwd: string; repo: string; branchName: string }> {
  const cwd = snapshot.run.worktreePath ? path.resolve(snapshot.run.worktreePath) : '';
  const repo = canonicalRepo(snapshot.run.repository);
  const branchName = snapshot.run.branchName ?? '';
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

function pullRequestBody(snapshot: OrchestrationSnapshot, resultCommit: string, checkCommands: string[]): string {
  const requiredTasks = snapshot.tasks.filter(task => task.required);
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

  /** Resolve credentials, repository identity, and PR base before approval is committed. */
  async prepare(snapshot: OrchestrationSnapshot): Promise<{ publicationBaseBranch: string; resultCommit: string }> {
    if (snapshot.run.status !== 'awaiting_approval') throw new Error('This build is no longer waiting for human approval.');
    const evidence = getOrchestrationFinalValidationEvidence(snapshot, this.store);
    const { repo, branchName } = await assertPublishedWorkspace(snapshot, this.store, this.github, evidence.resultCommit);
    const auth = await this.github.checkAuth();
    if (!auth.authenticated) throw new Error('Sign in to GitHub in Connected Accounts before approving and publishing this build.');
    const [remoteRepo, branches] = await Promise.all([
      this.github.getRepository(repo),
      this.github.listBranches(repo, 200)
    ]);
    if (canonicalRepo(remoteRepo.nameWithOwner).toLowerCase() !== repo.toLowerCase()) {
      throw new Error('GitHub resolved a different repository than the one authorized for this project.');
    }
    const baseBranch = branches.some(branch => branch.name === 'dev') ? 'dev' : remoteRepo.defaultBranch;
    if (!baseBranch || !isSafeBranchName(baseBranch) || baseBranch === branchName) {
      throw new Error('Alpha could not resolve a safe pull request target branch for this repository.');
    }
    // Keep this value in the durable approval event so a retry uses the same PR target.
    return { publicationBaseBranch: baseBranch, resultCommit: evidence.resultCommit };
  }

  async publish(snapshot: OrchestrationSnapshot): Promise<OrchestrationPublicationRecord> {
    if (snapshot.run.status !== 'publishing') throw new Error('This build has no pending publication to reconcile.');
    const approval = approvalEvidenceFor(snapshot, this.store);
    const evidence = validationEvidence(snapshot, this.store);
    const { cwd, repo, branchName } = await assertPublishedWorkspace(snapshot, this.store, this.github, evidence.resultCommit);
    const auth = await this.github.checkAuth();
    if (!auth.authenticated) throw new Error('Sign in to GitHub in Connected Accounts, then retry publication.');

    const baseBranch = approval.publicationBaseBranch;
    if (!isSafeBranchName(baseBranch) || baseBranch === branchName) {
      throw new Error('The saved pull request target is invalid. Reopen final review and resolve the repository setup.');
    }
    await this.github.pushBranch(cwd, branchName, repo);
    const remoteBranches = await this.listRemoteBranches(repo);
    const remoteHead = remoteBranches.find(branch => branch.name === branchName)?.sha;
    if (remoteHead?.toLowerCase() !== evidence.resultCommit.toLowerCase()) {
      throw new Error('GitHub does not show the validated commit on the build branch yet. Retry publication to reconcile it safely.');
    }

    let pullRequest = await this.findOpenPullRequest(repo, branchName, baseBranch);
    if (!pullRequest) {
      const issue = await this.issues.get(snapshot.run.workspaceId, snapshot.run.issueId);
      if (!issue || issue.projectId !== snapshot.run.projectId) {
        throw new Error('The linked project issue is unavailable. The branch was pushed; reconnect the issue before opening its pull request.');
      }
      const title = `feat: ${issue.title} [${issue.identifier}]`.slice(0, 256);
      const observed = Array.isArray(evidence.checks.observed)
        ? evidence.checks.observed as Array<Record<string, unknown>>
        : [];
      const commands = observed.map(check => typeof check.command === 'string' ? check.command : undefined).filter((value): value is string => Boolean(value));
      try {
        const url = await this.github.createPullRequest(
          cwd,
          title,
          pullRequestBody(snapshot, evidence.resultCommit, commands),
          baseBranch,
          branchName
        );
        const match = url.match(/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)$/);
        if (!match) throw new Error('GitHub returned an invalid pull request link.');
        pullRequest = { number: Number(match[1]), url };
      } catch (error) {
        // The API may have created the PR before a network timeout. Reconcile by
        // the unique run branch and exact base before deciding the operation failed.
        const reconciled = await this.findOpenPullRequest(repo, branchName, baseBranch).catch(() => undefined);
        if (!reconciled) throw error;
        pullRequest = reconciled;
      }
    }

    return {
      branchName,
      baseBranch,
      resultCommit: evidence.resultCommit,
      pullRequestUrl: pullRequest.url,
      publishedAt: this.now()
    };
  }

  async synchronizePublishedIssue(snapshot: OrchestrationSnapshot): Promise<void> {
    await synchronizePublishedOrchestrationIssue(snapshot, this.issues);
  }
}

export const orchestrationPublicationService = new OrchestrationPublicationService();
