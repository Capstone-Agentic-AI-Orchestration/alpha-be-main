import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, PrototypeRun, Project } from '../models/index.js';
import { agentReadiness } from './agentReadiness.js';
import { resolveAgentLogged } from './personaService.js';
import { allowAttachedWorkspace, projectRunWorkspacePath, resolveProjectWorkspace, type ProjectWorkspace } from './workspaceService.js';
import { OrchestrationService, type OrchestrationExecutor, type OrchestrationLaunchReceipt, type OrchestrationLaunchRequest, type PreparedOrchestrationTask } from './orchestrationService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { SQLiteService, sqliteService } from './sqliteService.js';
import { runnerService, type StartRunParams } from './runnerService.js';
import { addBranchWorktree, fetchRemoteBranch, getCurrentBranch, getHeadCommit, isGitRepo, isGitWorkingTreeClean, remoteHasDevBranch } from '../utils/gitUtils.js';
import { roleCanOwnOrchestrationTask } from './orchestrationContract.js';
import { repositoryWorkspaceForRun } from './orchestrationWorkspace.js';
import { logError } from '../utils/logger.js';

export interface RunnerEvents {
  on(event: 'run_completed' | 'run_failed' | 'run_cancelled', listener: (run: PrototypeRun) => void): unknown;
  startRun(params: StartRunParams): Promise<PrototypeRun>;
  cancelRun?(runId: string): Promise<void>;
}
type OrchestrationResultHandlers = Pick<
  OrchestrationService,
  'handleRunnerCompleted' | 'handleRunnerFailed' | 'handleRunnerCancelled'
>;

interface AdapterDependencies {
  store?: SQLiteService;
  runner?: RunnerEvents;
  resolveWorkspace?: (project: Project, repository: string) => ProjectWorkspace | null;
  allowWorkspace?: typeof allowAttachedWorkspace;
  worktreePathFor?: typeof projectRunWorkspacePath;
  isPathAllowed?: (workingDir: string) => boolean;
  resolvePersona?: typeof resolveAgentLogged;
  readinessFor?: typeof agentReadiness;
}

function normalizeRepository(value: string | undefined): string {
  return (value ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').toLowerCase();
}

export function orchestrationBranchName(runId: string): string {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase();
  if (!suffix) throw new Error('The orchestration run has no safe branch identity.');
  return `alpha/orchestration/${suffix}`;
}

export class OrchestrationRunnerAdapter implements OrchestrationExecutor {
  private readonly store: SQLiteService;
  private readonly runner: RunnerEvents;
  private readonly resolveWorkspace: (project: Project, repository: string) => ProjectWorkspace | null;
  private readonly allowWorkspace: typeof allowAttachedWorkspace;
  private readonly worktreePathFor: typeof projectRunWorkspacePath;
  private readonly isPathAllowed: (workingDir: string) => boolean;
  private readonly resolvePersona: typeof resolveAgentLogged;
  private readonly readinessFor: typeof agentReadiness;
  private resultHandlers?: OrchestrationResultHandlers;
  private eventHandlersAttached = false;

  constructor(dependencies: AdapterDependencies = {}) {
    this.store = dependencies.store ?? sqliteService;
    this.runner = dependencies.runner ?? runnerService;
    this.resolveWorkspace = dependencies.resolveWorkspace ?? resolveProjectWorkspace;
    this.allowWorkspace = dependencies.allowWorkspace ?? allowAttachedWorkspace;
    this.worktreePathFor = dependencies.worktreePathFor ?? projectRunWorkspacePath;
    this.isPathAllowed = dependencies.isPathAllowed ?? (workingDir => this.store.isPathAllowed(workingDir));
    this.resolvePersona = dependencies.resolvePersona ?? resolveAgentLogged;
    this.readinessFor = dependencies.readinessFor ?? agentReadiness;
  }

  attachResultHandlers(handlers: OrchestrationResultHandlers): void {
    this.resultHandlers = handlers;
    if (this.eventHandlersAttached) return;
    this.eventHandlersAttached = true;
    this.runner.on('run_completed', (run: PrototypeRun) => {
      if (!run.orchestrationRunId || !this.resultHandlers) return;
      void this.resultHandlers.handleRunnerCompleted(run).catch(error => logError('Orchestration result submission failed:', error));
    });
    this.runner.on('run_failed', (run: PrototypeRun) => {
      if (!run.orchestrationRunId || !this.resultHandlers) return;
      void this.resultHandlers.handleRunnerFailed(run).catch(error => logError('Orchestration task failure update failed:', error));
    });
    this.runner.on('run_cancelled', (run: PrototypeRun) => {
      if (!run.orchestrationRunId || !this.resultHandlers) return;
      void this.resultHandlers.handleRunnerCancelled(run).catch(error => logError('Orchestration task cancellation update failed:', error));
    });
  }

  async prepare(request: OrchestrationLaunchRequest): Promise<PreparedOrchestrationTask> {
    return runWithWorkspace(request.workspaceId, async () => {
      const { project, issue, agent } = this.loadEntities(request);
      const readiness = this.readinessFor(agent, this.store.getRuntimes());
      if (readiness.status !== 'ready') {
        throw new Error(`${agent.name} is not ready: ${readiness.detail}${readiness.command ? ` Run “${readiness.command}” and retry.` : ''}`);
      }
      const persona = this.resolvePersona(agent, { projectKey: project.key, includeToolPolicy: false });
      if (!roleCanOwnOrchestrationTask(request.taskKind, persona.role)) {
        throw new Error(`${persona.role} in the current persona file cannot own the assigned ${request.taskKind} task. Update the plan or persona before retrying.`);
      }
      const snapshot = this.store.getOrchestrationSnapshot(request.runId);
      const repositoryWorkspace = snapshot && repositoryWorkspaceForRun(snapshot.run, request.repository);
      if (!repositoryWorkspace || normalizeRepository(request.repository) !== normalizeRepository(repositoryWorkspace.repository)) {
        throw new Error('The task names a codebase that was not selected for this orchestrated product build.');
      }
      if (normalizeRepository(issue.githubRepo) !== normalizeRepository(snapshot!.run.repository) &&
          !(snapshot!.run.repositoryWorkspaces ?? []).some(item => normalizeRepository(item.repository) === normalizeRepository(request.repository))) {
        throw new Error('The build issue no longer matches a codebase authorized for this orchestration run.');
      }

      const repository = this.resolveWorkspace(project, request.repository);
      if (!repository || !fs.existsSync(repository.dir) || !(await isGitRepo(repository.dir))) {
        throw new Error(`The ${request.repository} checkout is unavailable on this executor. Reconnect the project repository before retrying.`);
      }
      this.allowWorkspace(repository, project.name);

      const expectedBranch = repositoryWorkspace.branchName || orchestrationBranchName(request.runId);
      if (request.branchName && request.branchName !== expectedBranch) {
        throw new Error('The orchestration run branch does not match its deterministic run identity.');
      }
      const branchName = expectedBranch;
      const workingDir = path.resolve(repositoryWorkspace.worktreePath);
      if (request.workingDir && path.resolve(request.workingDir) !== workingDir) {
        throw new Error('The task workspace does not match its selected codebase.');
      }
      let baseRef = request.baseRef ?? repositoryWorkspace.baseRef ?? 'HEAD';
      if (fs.existsSync(workingDir)) {
        if (!(await isGitRepo(workingDir))) {
          throw new Error('The orchestration worktree path exists but is not a Git worktree. Preserve it for recovery and inspect it before retrying.');
        }
        const currentBranch = await getCurrentBranch(workingDir);
        if (currentBranch !== branchName) {
          throw new Error(`The existing orchestration worktree is on ${currentBranch}; expected ${branchName}. Preserve it for recovery.`);
        }
        if (!(await isGitWorkingTreeClean(workingDir))) {
          throw new Error('The previous task left uncheckpointed changes. Preserve the worktree and reconcile those changes before dispatching another task.');
        }
        if (request.attemptNumber === 1) {
          // Attempt numbers belong to tasks, not the build. A new specialist
          // starts from the last accepted checkpoint in its own repository.
          const latestAccepted = [...snapshot!.attempts].reverse().find(attempt => {
            const task = snapshot!.tasks.find(item => item.id === attempt.taskId);
            return attempt.status === 'accepted' && task &&
              normalizeRepository(task.repository ?? snapshot!.run.repository) === normalizeRepository(request.repository);
          });
          const expectedCommit = latestAccepted?.resultCommit ?? repositoryWorkspace.baseCommit;
          if (expectedCommit && await getHeadCommit(workingDir) !== expectedCommit) {
            throw new Error(latestAccepted
              ? 'The handoff worktree no longer matches its latest accepted checkpoint. Preserve it and reconcile the build before retrying.'
              : 'The planning worktree no longer matches its recorded base commit. Preserve it and reconcile the build before retrying.');
          }
        } else {
          const latestTaskCheckpoint = [...snapshot!.attempts].reverse().find(attempt =>
            attempt.taskId === request.taskId && attempt.resultCommit &&
            ['accepted', 'failed', 'rejected', 'recovery_required'].includes(attempt.status));
          const latestAccepted = [...snapshot!.attempts].reverse().find(attempt => {
            const task = snapshot!.tasks.find(item => item.id === attempt.taskId);
            return attempt.status === 'accepted' && task &&
              normalizeRepository(task.repository ?? snapshot!.run.repository) === normalizeRepository(request.repository);
          });
          const expectedCommit = latestTaskCheckpoint?.resultCommit ?? latestAccepted?.resultCommit ?? repositoryWorkspace.baseCommit;
          if (expectedCommit && await getHeadCommit(workingDir) !== expectedCommit) {
            throw new Error('The retry worktree no longer matches its latest saved checkpoint. Preserve the branch and reconcile it before dispatching another specialist attempt.');
          }
        }
      } else {
        if (repositoryWorkspace.baseCommit) {
          throw new Error('The persisted orchestration worktree is missing. Do not rebuild it from a different base; reconcile the saved checkpoint first.');
        }
        if (!request.baseRef && !repositoryWorkspace.baseCommit && await remoteHasDevBranch(repository.dir)) baseRef = await fetchRemoteBranch(repository.dir, 'dev');
        await addBranchWorktree(repository.dir, workingDir, branchName, baseRef);
      }

      const startingCommit = await getHeadCommit(workingDir);
      const taskPackageHash = crypto.createHash('sha256')
        .update(JSON.stringify(request.taskPackage))
        .digest('hex');
      return {
        startingCommit,
        personaHash: persona.personaHash,
        modelProvider: persona.modelProvider,
        modelName: persona.modelName,
        branchName,
        workingDir,
        contextManifest: {
          packageVersion: request.taskPackage.packageVersion,
          reportSchemaVersion: request.taskPackage.reportSchemaVersion,
          taskPackageHash,
          personaHash: persona.personaHash,
          modelProvider: persona.modelProvider,
          modelName: persona.modelName,
          branchName,
          baseRef,
          baseCommit: repositoryWorkspace.baseCommit ?? request.baseCommit ?? startingCommit,
          startingCommit,
          workspacePathHash: crypto.createHash('sha256').update(path.resolve(workingDir)).digest('hex')
        }
      };
    });
  }

  async launch(request: OrchestrationLaunchRequest): Promise<OrchestrationLaunchReceipt> {
    return runWithWorkspace(request.workspaceId, async () => {
      const { issue, agent, project } = this.loadEntities(request);
      const snapshot = this.store.getOrchestrationSnapshot(request.runId);
      const repositoryWorkspace = snapshot && repositoryWorkspaceForRun(snapshot.run, request.repository);
      if (!snapshot || !repositoryWorkspace) throw new Error('The task repository is not authorized by this build plan.');
      const expectedWorktree = path.resolve(repositoryWorkspace.worktreePath);
      const workingDir = path.resolve(request.workingDir ?? '');
      const expectedBranch = repositoryWorkspace.branchName || orchestrationBranchName(request.runId);
      if (!workingDir || workingDir !== expectedWorktree || request.branchName !== expectedBranch) {
        throw new Error('The task executor received a workspace or branch outside the run-scoped allocation.');
      }
      if (!this.isPathAllowed(workingDir) || !(await isGitRepo(workingDir))) {
        throw new Error('The orchestration worktree is outside Alpha’s approved workspace or is no longer a Git checkout.');
      }

      const prototypeRunId = `run-${request.attemptId}`;
      // Bind the durable attempt before queueing the process. A very fast CLI
      // completion can then never arrive before its parent task is known.
      this.store.bindOrchestrationAttempt({
        runId: request.runId,
        attemptId: request.attemptId,
        prototypeRunId,
        actorId: 'orchestrator'
      });
      const task = request.taskPackage.task;
      const plan = [
        `Orchestration plan version ${request.planVersion}.`,
        `Complete only task ${task.id}: ${task.title}.`,
        `Task package version ${request.taskPackage.packageVersion}.`
      ];
      await this.runner.startRun({
        runId: prototypeRunId,
        issueId: issue.id,
        agentId: agent.id,
        plan,
        workspaceId: request.workspaceId,
        workingDir,
        orchestration: {
          orchestrationRunId: request.runId,
          taskId: request.taskId,
          attemptId: request.attemptId,
          branchName: expectedBranch,
          planVersion: request.planVersion,
          taskPackage: request.taskPackage,
          personaHash: request.personaHash ?? '',
          modelProvider: request.modelProvider ?? '',
          modelName: request.modelName ?? ''
        }
      });
      return { prototypeRunId };
    });
  }

  async cancel(prototypeRunId: string): Promise<void> {
    if (!this.runner.cancelRun) throw new Error('The configured task runner cannot stop an active process safely.');
    await this.runner.cancelRun(prototypeRunId);
  }

  private loadEntities(request: OrchestrationLaunchRequest): { project: Project; issue: ReturnType<SQLiteService['getIssues']>[number]; agent: Agent } {
    const issue = this.store.getIssues().find(candidate => candidate.id === request.issueId);
    if (!issue || issue.projectId !== request.projectId) throw new Error('The build issue is unavailable or no longer belongs to the requested project.');
    const project = this.store.getProjects().find(candidate => candidate.id === request.projectId);
    if (!project) throw new Error('The build project is unavailable in this workspace.');
    const agent = this.store.getAgents().find(candidate => candidate.id === request.ownerAgentId && !candidate.isArchived);
    if (!agent) throw new Error('The task owner is unavailable or archived. Choose an eligible specialist before retrying.');
    return { issue, project, agent };
  }
}
