import { featureSpecSourceHash, plannerRequirementsFromSpec, specPlanningBrief } from './featureSpecContract.js';
import { manualChecklistRequirements } from './issueChecklist.js';
import { isBoardThreadId } from './boardThreads.js';
import { roleCanPlan } from './agentRoleContracts.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Agent, Project, ProjectBuildStep, RuntimeEngine } from '../models/index.js';
import { ALPHA_ORCHESTRATION_ENABLED, IS_CLOUD } from '../config/env.js';
import type { WorkspaceContext } from './workspaceRegistry.js';
import { issueStore, projectStore } from '../store/stores.js';
import { addBranchWorktree, assertSafeBranchName, fetchRemoteBranch, getCurrentBranch, getHeadCommit, isGitRepo, isGitWorkingTreeClean, remoteHasDevBranch } from '../utils/gitUtils.js';
import { agentReadiness } from './agentReadiness.js';
import { reposForProject } from './githubIssueMapping.js';
import { cloneAndBindProject } from './projectBindings.js';
import { projectRunWorkspacePath, resolveProjectWorkspace, allowAttachedWorkspace } from './workspaceService.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { addCommentAndShare } from './boardWriteThrough.js';
import { supabaseService } from './supabaseService.js';
import { resolveAgent } from './personaService.js';
import { orchestrationRequestFingerprint } from './orchestrationService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { OrchestrationPlanner, OrchestrationPlanningError, type PlannerAgentIdentity } from './orchestrationPlanner.js';
import { composeProjectContext } from './projectPlaybook.js';
import { MAX_PROJECT_CONTEXT_CHARS } from './orchestrationContract.js';
import { inspectOrchestrationPlanningWorktree, removeStaleOrchestrationPlanningWorktree } from './orchestrationPlanningRecovery.js';
import { orchestrationSessionId } from './orchestrationSession.js';
import { chatBuildRequestKey } from './chatBuildIdentity.js';
import { repositoryFileOverview } from './repositoryOverview.js';

export interface ProjectBuildStartResult {
  blockingBuild?: { runId: string; projectId?: string; issueId?: string; status: string };
  status: 'started' | 'queued' | 'in_progress' | 'plan_ready' | 'awaiting_review' | 'completed' | 'failed' | 'blocked';
  projectId?: string;
  projectName?: string;
  repository?: string;
  repositories?: string[];
  issueId?: string;
  issueIdentifier?: string;
  orchestrationRunId?: string;
  orchestrationTaskCount?: number;
  orchestrationCurrentTask?: { id: string; title: string; ownerAgentId: string };
  branchName?: string;
  reason?: string;
}

interface StartProjectBuildInput {
  /** Trusted delivery service constraint. Never populated from a model or HTTP body. */
  deliveryRepair?: { repositories: Array<{ repository: string; base: string; commit: string; includePaths: string[]; excludePaths: string[] }> };
  context: WorkspaceContext;
  projectId?: string;
  threadId: string;
  messageId: string;
  content: string;
  requestedRepository?: string;
  requestedRepositories?: string[];
  /** Existing board issue to build. Omitted for chat requests, which get their own issue. */
  issueId?: string;
}

interface SelectedProjectRepository { repository: string; checkoutDir: string }

/** A requested branch base is runner setup, never a specialist's Git task. */
export function requestedBuildBase(goal: string): string | undefined {
  const bases = [...goal.matchAll(/\b(?:branch(?:\s+(?:out|off))?\s+from|branch\s+(?:off|based\s+on)|base\s+branch\s*(?:is|:|=)?)\s+[`"']?(?:origin\/)?([a-zA-Z0-9][a-zA-Z0-9._\/-]*)/gi)]
    .map(match => match[1].replace(/[.,;]+$/, ''));
  const unique = [...new Set(bases)];
  if (unique.length > 1) throw new Error('The request names conflicting base branches. Specify one base before planning.');
  if (unique[0]) assertSafeBranchName(unique[0]);
  return unique[0];
}

const inFlightBuilds = new Map<string, Promise<ProjectBuildStartResult>>();
// Desktop supplies a fresh ID for every daemon launch; source runs use a
// process-scoped fallback so interrupted planning can be recognized as stale.
const orchestrationOwnerSessionId = orchestrationSessionId;

function blocked(reason: string, project?: Project, repository?: string): ProjectBuildStartResult {
  return {
    status: 'blocked',
    projectId: project?.id,
    projectName: project?.name,
    repository,
    repositories: repository ? [repository] : undefined,
    reason
  };
}

/** Says what is holding the repository, so the user knows whether to approve, wait, or stop it. */
function activeBuildReason(status: string, repository: string): string {
  return `Waiting for the existing ${status.replace(/_/g, ' ')} build using ${repository}. Open its task's Build tab to inspect it, or explicitly queue planning from this task. Waiting does not cancel either build.`;
}

/** Resolve an intentionally unpinned role to the first model in its live runtime catalog. */
export function plannerModelName(provider: string, configuredModel: string, runtimes: RuntimeEngine[]): string {
  const pinned = configuredModel.trim();
  if (pinned) return pinned;
  const matching = runtimes.filter(candidate => provider === 'Google Gemini'
    ? candidate.id === 'antigravity'
    : candidate.provider === provider
  );
  const usable = matching.filter(candidate => candidate.status === 'online' &&
    candidate.models.some(model => model.trim())
  );
  // Prefer the machine's selected runtime; if the provider has more than one,
  // use a stable order so repeated builds do not depend on scan response order.
  const runtime = usable.find(candidate => candidate.isDefault) ??
    [...usable].sort((left, right) => left.id.localeCompare(right.id))[0];
  return runtime?.models.find(model => model.trim())?.trim() ?? '';
}

function issueTitle(content: string): string {
  const clean = content.trim().replace(/^\/build\s*/i, '').replace(/[\r\n]+/g, ' ');
  const sentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
  return `Build: ${sentence.slice(0, 92).trim()}`;
}

function repositoryOptions(project: Project): string[] {
  return reposForProject(project);
}

const PLANNING_KINDS = new Set(['requirements', 'architecture']);
const MAX_README_CONTEXT_CHARS = 7_000;

type PlanningReservation = NonNullable<ReturnType<typeof sqliteService.getOrchestrationPlanningReservation>>;
type PlanningReservationCleanup = 'released' | 'workspace_preserved' | 'reservation_changed';

async function reconcilePlanningReservation(input: {
  workspaceId: string;
  repositoryDir: string;
  projectId: string;
  reservation: PlanningReservation;
}): Promise<PlanningReservationCleanup> {
  const worktreeSafeToRetire = await removeStaleOrchestrationPlanningWorktree({
    repositoryDir: input.repositoryDir,
    projectId: input.projectId,
    reservation: input.reservation
  });
  if (!worktreeSafeToRetire) {
    const inspection = await inspectOrchestrationPlanningWorktree({
      projectId: input.projectId,
      reservation: input.reservation,
      repositoryDir: input.repositoryDir
    });
    const durableReservation = runWithWorkspace(input.workspaceId, () =>
      sqliteService.getOrchestrationPlanningReservationByRun(input.projectId, input.reservation.runId, input.reservation.repository));
    if (durableReservation) {
      runWithWorkspace(input.workspaceId, () => sqliteService.recordOrchestrationPlanningRecovery({
        projectId: input.projectId,
        reservation: durableReservation,
        state: inspection.canPreview ? 'needs_review' : 'manual_review',
        reason: inspection.canPreview
          ? `Planning stopped before a task plan was activated. The saved private workspace was preserved for review. ${inspection.reason ?? 'It differs from its reserved clean base.'}`
          : `Planning stopped before a task plan was activated. The saved workspace was preserved and repository admission remains paused. ${inspection.reason ?? 'Alpha could not verify the saved workspace identity.'}`
      }));
    }
    return 'workspace_preserved';
  }
  const released = runWithWorkspace(input.workspaceId, () => sqliteService.releaseOrchestrationPlanningReservation(
    input.reservation.requestKey,
    input.reservation.requestFingerprint,
    input.reservation.ownerSessionId
  ));
  return released ? 'released' : 'reservation_changed';
}

function planningRequestKey(requestKey: string, repository: string, primaryRepository: string): string {
  if (repository.toLowerCase() === primaryRepository.toLowerCase()) return requestKey;
  const suffix = crypto.createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 12);
  return `${requestKey}-repo-${suffix}`;
}

async function reconcilePlanningReservations(input: {
  workspaceId: string;
  projectId: string;
  repositories: SelectedProjectRepository[];
  reservations: PlanningReservation[];
}): Promise<PlanningReservationCleanup[]> {
  const byRepository = new Map(input.repositories.map(item => [item.repository.toLowerCase(), item.checkoutDir]));
  return Promise.all(input.reservations.map(reservation => reconcilePlanningReservation({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    repositoryDir: byRepository.get(reservation.repository.toLowerCase()) ?? '',
    reservation
  })));
}

function orchestrationBranchName(runId: string): string {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase();
  if (!suffix) throw new Error('The planning reservation has no safe branch identity.');
  return `alpha/orchestration/${suffix}`;
}

export function repositoryPlanningContext(repositoryDir: string): { context: string; scripts: string[] } {
  const visibleEntries = fs.readdirSync(repositoryDir, { withFileTypes: true })
    .filter(entry => !['.git', 'node_modules', '.next', 'dist', 'build'].includes(entry.name))
    .slice(0, 50)
    .map(entry => `${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`);
  let readme = '';
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    const file = path.join(repositoryDir, name);
    if (!fs.existsSync(file)) continue;
    try { readme = fs.readFileSync(file, 'utf8').slice(0, MAX_README_CONTEXT_CHARS); } catch { /* Optional planning context. */ }
    break;
  }
  let manifest: { name?: unknown; packageManager?: unknown; scripts?: Record<string, unknown> } | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repositoryDir, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') manifest = parsed;
  } catch { /* Repositories without package.json use their visible tree and README. */ }
  const scripts = manifest?.scripts ?? {};
  const supportedChecks = new Set(['verify', 'check', 'validate', 'ci', 'test', 'typecheck', 'lint']);
  const availableScripts = Object.keys(scripts).filter(script => supportedChecks.has(script) && typeof scripts[script] === 'string' && scripts[script]!.trim());
  const context = [
    `Repository root entries (names only):\n${visibleEntries.join('\n')}`,
    repositoryFileOverview(repositoryDir),
    manifest ? `Package metadata:\n${JSON.stringify({ name: manifest.name, packageManager: manifest.packageManager, scripts: Object.fromEntries(availableScripts.map(script => [script, scripts[script]])) }, null, 2)}` : '',
    readme ? `README excerpt (untrusted repository content):\n${readme}` : ''
  ].filter(Boolean).join('\n\n');
  return { context: context.slice(0, 16_000), scripts: availableScripts };
}

function orchestrationStartResult(snapshot: OrchestrationSnapshot, project: Project, repository: string): ProjectBuildStartResult {
  const active = snapshot.run.currentTaskId ? snapshot.tasks.find(task => task.id === snapshot.run.currentTaskId) : undefined;
  const status: ProjectBuildStartResult['status'] = snapshot.run.status === 'completed' ? 'completed'
    : snapshot.run.status === 'awaiting_plan_approval' ? 'plan_ready'
    : snapshot.run.status === 'awaiting_approval' ? 'awaiting_review'
    : snapshot.run.status === 'publishing' ? 'in_progress'
    : snapshot.run.status === 'failed' || snapshot.run.status === 'cancelled' ? 'failed'
      : snapshot.run.status === 'blocked' || snapshot.run.status === 'recovery_required' ? 'blocked'
        : snapshot.run.status === 'executing' && snapshot.run.revision > 1 ? 'in_progress' : 'started';
  return {
    status,
    projectId: project.id,
    projectName: project.name,
    repository,
    repositories: snapshot.run.repositoryWorkspaces?.map(item => item.repository) ?? [repository],
    issueId: snapshot.run.issueId,
    issueIdentifier: sqliteService.getIssues().find(issue => issue.id === snapshot.run.issueId)?.identifier,
    orchestrationRunId: snapshot.run.id,
    orchestrationTaskCount: snapshot.tasks.length,
    orchestrationCurrentTask: active ? { id: active.id, title: active.title, ownerAgentId: active.ownerAgentId } : undefined,
    branchName: snapshot.run.branchName,
    reason: snapshot.run.stoppedReason
  };
}

async function startOrchestratedProjectBuild(input: {
  deliveryRepair?: StartProjectBuildInput['deliveryRepair'];
  context: WorkspaceContext;
  project: Project;
  repositories: SelectedProjectRepository[];
  members: Agent[];
  buildSteps: ProjectBuildStep[];
  threadId: string;
  messageId: string;
  content: string;
  issueId?: string;
}): Promise<ProjectBuildStartResult> {
  const { context, project, members, buildSteps } = input;
  const fromBoard = isBoardThreadId(input.threadId);
  const repositories = input.repositories;
  const repository = repositories[0]?.repository ?? '';
  if (IS_CLOUD) return blocked('Task-based builds require the authorized Alpha desktop with the local repository checkout.', project, repository);
  if (!ALPHA_ORCHESTRATION_ENABLED) return blocked('The Orchestrator is unavailable in this desktop version. Update the app before starting a build.', project, repository);

  const workspaceId = context.workspaceId;
  const requestKey = chatBuildRequestKey(workspaceId, input.threadId, input.messageId);
  const cleanGoal = input.content.trim().replace(/^\/build\s*/i, '').trim();
  if (!cleanGoal || cleanGoal.length > 4_000) return blocked('Keep a task-based build request between 1 and 4,000 characters so its accepted scope remains explicit.', project, repository);
  if ((project.description?.length ?? 0) > MAX_PROJECT_CONTEXT_CHARS) {
    return blocked(`Project context is over ${MAX_PROJECT_CONTEXT_CHARS.toLocaleString()} characters. Shorten the saved ground rules in Project settings before starting a build.`, project, repository);
  }
  const linkedIssueId = input.issueId?.trim() || undefined;
  const expectedIssueId = linkedIssueId ?? `chat-build-${requestKey}`;
  const requestFingerprint = orchestrationRequestFingerprint({
    ...(input.deliveryRepair ? { repairScopeHash: crypto.createHash('sha256').update(JSON.stringify(input.deliveryRepair)).digest('hex') } : {}),
    workspaceId, projectId: project.id, issueId: expectedIssueId, repository,
    repositories: repositories.map(item => item.repository),
    createdBy: context.userId, originalRequest: cleanGoal
  });
  const priorSnapshot = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationByRequestKey(requestKey));
  if (priorSnapshot) {
    if (priorSnapshot.run.requestFingerprint !== requestFingerprint) {
      return blocked('This chat request key is already associated with a different task workflow. Start a new chat message to create a separate build.', project, repository);
    }
    return orchestrationStartResult(priorSnapshot, project, repository);
  }
  for (const selected of repositories) {
    let activeWorkflow = runWithWorkspace(workspaceId, () => sqliteService.getActiveOrchestrationForProject(project.id, selected.repository));
    let reservation = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationPlanningReservation(project.id, selected.repository));
    const expectedReservationKey = planningRequestKey(requestKey, selected.repository, repository);
    const ownsReservation = activeWorkflow?.status === 'planning' && reservation?.runId === activeWorkflow.runId &&
      reservation.requestKey === expectedReservationKey && reservation.requestFingerprint === requestFingerprint &&
      reservation.ownerSessionId === orchestrationOwnerSessionId;
    if (activeWorkflow?.status === 'planning' && reservation && !ownsReservation && reservation.ownerSessionId !== orchestrationOwnerSessionId) {
      const recovery = await reconcilePlanningReservation({ workspaceId, repositoryDir: selected.checkoutDir, projectId: project.id, reservation });
      if (recovery === 'workspace_preserved') return blocked(`Alpha preserved a changed planning workspace for ${selected.repository}. Review the saved work in the Build review tab before starting another build.`, project, selected.repository);
      if (recovery === 'reservation_changed') return blocked(`The saved planning record for ${selected.repository} changed during recovery. Refresh the project and try again.`, project, selected.repository);
      activeWorkflow = runWithWorkspace(workspaceId, () => sqliteService.getActiveOrchestrationForProject(project.id, selected.repository));
      reservation = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationPlanningReservation(project.id, selected.repository));
    }
    const stillOwnsPlanning = activeWorkflow?.status === 'planning' && reservation?.runId === activeWorkflow.runId &&
      reservation.requestKey === expectedReservationKey && reservation.requestFingerprint === requestFingerprint &&
      reservation.ownerSessionId === orchestrationOwnerSessionId;
    if (activeWorkflow && !stillOwnsPlanning) {
      return { ...blocked(activeBuildReason(activeWorkflow.status, selected.repository), project, selected.repository),
        ...(activeWorkflow.projectId && workspaceRegistry.canAccessProjectBuilds(context, activeWorkflow.projectId)
          ? { blockingBuild: { runId: activeWorkflow.runId, projectId: activeWorkflow.projectId, issueId: activeWorkflow.issueId, status: activeWorkflow.status } } : {}) };
    }
  }

  const issueId = expectedIssueId;
  const idempotencyLabel = `alpha:chat-build-${requestKey}`;
  let issue = linkedIssueId
    ? await issueStore().get(workspaceId, linkedIssueId)
    : (await issueStore().list(workspaceId)).find(item => item.projectId === project.id && item.labels.includes(idempotencyLabel));
  if (linkedIssueId) {
    if (!issue || issue.projectId !== project.id) return blocked('That issue is not part of this project. Open it from the project board and try again.', project, repository);
    if (issue.status === 'done') return blocked(`${issue.identifier} is already done. Reopen it before starting another build.`, project, repository);
  }
  // An approved feature spec fixes the requirements; a draft one does not guide the build.
  const specRecord = linkedIssueId && issue ? runWithWorkspace(workspaceId, () => sqliteService.getFeatureSpec(issue!.id)) : null;
  if (specRecord?.status === 'approved' && issue && specRecord.sourceHash !== featureSpecSourceHash(issue)) {
    return blocked(`${issue.identifier} changed after its feature spec was approved. Review and approve the spec again before building.`, project, repository);
  }
  let approvedSpec = specRecord?.status === 'approved'
    ? { requirements: plannerRequirementsFromSpec(specRecord.spec), exclusions: specRecord.spec.exclusions, brief: specPlanningBrief(specRecord.spec) }
    : undefined;
  // Read the saved card, not a truncated browser prompt. Every manual item is
  // a fixed requirement, even when the task has no AI-generated feature spec.
  const checklistRequirements = manualChecklistRequirements(issue?.subtasks ?? []);
  if (checklistRequirements.length) {
    approvedSpec = {
      requirements: [...(approvedSpec?.requirements ?? []), ...checklistRequirements],
      exclusions: approvedSpec?.exclusions ?? [],
      brief: [approvedSpec?.brief, 'The task acceptance checklist must be satisfied in full.'].filter(Boolean).join('\n')
    };
  }
  if (approvedSpec && (approvedSpec.requirements.length > 20 || approvedSpec.requirements.some(item => item.description.length > 4_000))) {
    return blocked('This task has more acceptance criteria than one build can cover. Split it into smaller tasks (at most 20 requirements per build, each under 4,000 characters).', project, repository);
  }
  const previousLegacyRun = issue && sqliteService.getSquadRuns().find(run => run.issueId === issue!.id);
  if (previousLegacyRun && issue) {
    const runs = sqliteService.getRunsForSquadRun(previousLegacyRun.id);
    const firstRun = runs.sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0))[0];
    return {
      status: previousLegacyRun.status === 'awaiting_approval' ? 'awaiting_review' : previousLegacyRun.status === 'failed' || previousLegacyRun.status === 'cancelled' ? 'failed' : 'in_progress',
      projectId: project.id, projectName: project.name, repository, issueId: issue.id,
      issueIdentifier: issue.identifier,
      branchName: firstRun?.branchName ?? previousLegacyRun.branchName,
      reason: previousLegacyRun.stoppedReason
    };
  }
  const activeLegacyRun = sqliteService.getSquadRuns().find(run => {
    if (run.projectId !== project.id || run.status !== 'running') return false;
    const activeIssue = sqliteService.getIssues().find(candidate => candidate.id === run.issueId);
    const normalize = (value: string) => value.toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    return !activeIssue?.githubRepo || normalize(activeIssue.githubRepo) === normalize(repository);
  });
  if (activeLegacyRun) return blocked('A legacy build is already using this project repository. Wait for it to finish before starting a task-based build.', project, repository);

  const orderedSteps = [...buildSteps].filter(step => step.enabled).sort((a, b) => a.position - b.position);
  const runtimes = sqliteService.getRuntimes();
  const eligible = members.map(agent => {
    const readiness = agentReadiness(agent, runtimes);
    if (readiness.status !== 'ready') return { agent, readiness, persona: undefined };
    return { agent, readiness, persona: resolveAgent(agent, { projectKey: project.key, includeMemory: false, includeToolPolicy: false }) };
  }).filter((item): item is { agent: Agent; readiness: ReturnType<typeof agentReadiness>; persona: ReturnType<typeof resolveAgent> } => Boolean(item.persona));

  const canPlan = (item: typeof eligible[number]) => roleCanPlan(item.persona.role);
  const hasPlannerModel = (item: typeof eligible[number]) => Boolean(
    plannerModelName(item.persona.modelProvider, item.persona.modelName, runtimes)
  );
  const orchestratorAgent = eligible.find(item => item.persona.role.trim().toLowerCase() === 'orchestrator agent');
  const configuredPlannerStep = orderedSteps.find(step => PLANNING_KINDS.has(step.phase) && step.agentId);
  const planningCandidates = [
    orchestratorAgent,
    configuredPlannerStep ? eligible.find(item => item.agent.id === configuredPlannerStep.agentId) : undefined,
    ...eligible.filter(canPlan)
  ].filter((item, index, all): item is typeof eligible[number] => Boolean(item) && all.indexOf(item) === index);
  const plannerCandidate = planningCandidates.find(item => canPlan(item) && hasPlannerModel(item));
  if (!plannerCandidate) {
    const configuredCandidate = configuredPlannerStep
      ? eligible.find(item => item.agent.id === configuredPlannerStep.agentId)
      : undefined;
    if (configuredCandidate && !canPlan(configuredCandidate)) {
      return blocked(`${configuredCandidate.persona.role} cannot prepare a build plan. Assign a Research, Requirements, Manager, Architecture, or Orchestrator Agent persona to the planning step.`, project, repository);
    }
    const modelMissing = planningCandidates.find(canPlan);
    const reason = modelMissing
      ? `No model is available for ${modelMissing.persona.name}. Open Runtimes to scan a signed-in model, or choose an available model in Agent settings, then try again.`
      : `No project-visible planning agent is ready. Make the Orchestrator or a Research, Requirements, Manager, or Architecture Agent available on a signed-in runtime, then try again.`;
    return blocked(reason, project, repository);
  }
  const plannerIdentity: PlannerAgentIdentity = {
    id: plannerCandidate.agent.id,
    name: plannerCandidate.persona.name,
    role: plannerCandidate.persona.role,
    provider: plannerCandidate.persona.modelProvider,
    modelName: plannerModelName(plannerCandidate.persona.modelProvider, plannerCandidate.persona.modelName, runtimes),
    reasoningEffort: plannerCandidate.persona.reasoningEffort,
    systemPrompt: plannerCandidate.persona.systemPrompt
  };
  // A short profile per agent, so the planner chooses on fit rather than on an id.
  const availableAgents = eligible.map(item => ({
    id: item.agent.id,
    role: item.persona.role,
    ready: true as const,
    name: item.persona.name,
    description: (item.agent.description ?? '').slice(0, 240),
    official: Boolean(item.agent.templateKey)
  }));
  const activeIndependentCall = repositories.map(item => runWithWorkspace(workspaceId, () =>
    sqliteService.getActiveAgentCallProjectLock(project.id, item.repository)
  )).find(Boolean);
  if (activeIndependentCall) {
    return blocked('An independent code call or patch is using this repository. Let it finish before starting a task-based build.', project, repository);
  }

  const proposedRunId = `orchestration-${crypto.randomUUID()}`;
  const reservations: PlanningReservation[] = [];
  const baseRefs = new Map<string, string>();
  const branchName = orchestrationBranchName(proposedRunId);
  try {
    for (const [index, target] of repositories.entries()) {
      const repair = input.deliveryRepair?.repositories.find(item => item.repository.toLowerCase() === target.repository.toLowerCase());
      if (input.deliveryRepair && !repair) throw new Error('Repair repository is outside the original delivery.');
      const requestedBase = repair?.base ?? requestedBuildBase(cleanGoal);
      const base = requestedBase ?? (await remoteHasDevBranch(target.checkoutDir) ? 'dev' : undefined);
      let baseRef = 'HEAD';
      if (base) {
        try { baseRef = await fetchRemoteBranch(target.checkoutDir, base); }
        catch { throw new Error(`Cannot prepare ${target.repository} from origin/${base}. Check that the branch exists and GitHub access is available. No specialist was started.`); }
      }
      const baseCommit = await getHeadCommit(target.checkoutDir, baseRef);
      baseRefs.set(target.repository, baseRef);
      if (repair && baseCommit !== repair.commit) throw new Error('The CI repair source changed. Refresh delivery evidence before planning.');
      const worktreePath = index === 0
        ? projectRunWorkspacePath(project.id, proposedRunId)
        : projectRunWorkspacePath(project.id, `${proposedRunId}-${crypto.createHash('sha256').update(target.repository.toLowerCase()).digest('hex').slice(0, 12)}`);
      reservations.push(runWithWorkspace(workspaceId, () => sqliteService.reserveOrchestrationPlanning({
        projectId: project.id,
        repository: target.repository,
        requestKey: planningRequestKey(requestKey, target.repository, repository),
        requestFingerprint,
        createdBy: context.userId,
        runId: proposedRunId,
        branchName,
        baseCommit,
        worktreePath,
        ownerSessionId: orchestrationOwnerSessionId
      })));
    }
  } catch (error) {
    await reconcilePlanningReservations({ workspaceId, projectId: project.id, repositories, reservations });
    return blocked(error instanceof Error ? error.message : 'The project repository could not be reserved for planning.', project, repository);
  }

  try {
    for (let index = 0; index < reservations.length; index++) {
      const reservation = reservations[index];
      const selected = repositories[index];
      if (!fs.existsSync(reservation.worktreePath)) {
        await addBranchWorktree(selected.checkoutDir, reservation.worktreePath, reservation.branchName, reservation.baseCommit);
      } else if (!(await isGitRepo(reservation.worktreePath)) ||
          await getCurrentBranch(reservation.worktreePath) !== reservation.branchName ||
          await getHeadCommit(reservation.worktreePath) !== reservation.baseCommit ||
          !(await isGitWorkingTreeClean(reservation.worktreePath))) {
        throw new Error(`The saved planning workspace for ${selected.repository} does not match its reserved branch and base. Alpha preserved it for review.`);
      }
    }
  } catch (error) {
    const cleanup = await reconcilePlanningReservations({ workspaceId, projectId: project.id, repositories, reservations });
    const preserved = cleanup.some(result => result === 'workspace_preserved');
    return blocked(`The isolated planning workspaces could not be prepared. ${error instanceof Error ? error.message : 'Inspect the saved build workspaces before retrying.'}${preserved ? ' Changed workspaces were preserved for review.' : ''}`, project, repository);
  }

  const planningContexts = reservations.map(reservation => ({
    repository: reservation.repository,
    context: repositoryPlanningContext(reservation.worktreePath)
  }));
  const reservation = reservations[0];
  if (!reservation) return blocked('No selected codebase could be reserved for the build.', project);
  const planner = new OrchestrationPlanner();
  let planned;
  try {
    planned = await planner.createPlan({
      runId: reservation.runId,
      usageContext: { threadId: input.threadId, messageId: input.messageId },
      cwd: reservation.worktreePath,
      repositoryRoots: reservations.map(item => ({ name: item.repository, repo: item.repository, dir: item.worktreePath })),
      branchContext: reservations.map(item => ({ repository: item.repository, branchName: item.branchName, baseRef: baseRefs.get(item.repository) ?? item.baseCommit, baseCommit: item.baseCommit })),
      goal: cleanGoal,
      // The team's playbook and the detected stack, read from the planning checkouts.
      projectContext: composeProjectContext({
        description: project.description,
        repositories: reservations.map(item => ({ repository: item.repository, dir: item.worktreePath }))
      }),
      repositoryContext: planningContexts[0]?.context.context ?? '',
      availableScripts: planningContexts[0]?.context.scripts ?? [],
      repositories: planningContexts.map(item => ({
        repository: item.repository,
        repositoryContext: item.context.context,
        availableScripts: item.context.scripts
      })),
      eligibleAgents: availableAgents,
      planner: plannerIdentity,
      approvedSpec,
      buildSteps: orderedSteps.map(step => ({
        id: step.id, label: step.label, phase: step.phase,
        agentId: step.agentId, position: step.position, required: step.required,
        dependsOn: step.dependsOn ?? []
      }))
    });
    if (input.deliveryRepair) {
      if (planned.plan.schemaVersion !== 1 || planned.plan.milestones?.length) throw new Error('CI repair needs a bounded direct plan.');
      // The model may choose owners and dependencies, but cannot expand the
      // previously authorized write scope or alter the workflow gates.
      for (const task of planned.plan.tasks) {
        const repair = input.deliveryRepair.repositories.find(item => item.repository.toLowerCase() === (task.repository ?? repository).toLowerCase());
        if (!repair) throw new Error('Repair plan selected an unauthorized repository.');
        task.scope = {
          includePaths: [...repair.includePaths],
          excludePaths: [...new Set([...repair.excludePaths, '.github/workflows/**'])]
        };
      }
    }
  } catch (error) {
    const detail = error instanceof OrchestrationPlanningError ? error.message : error instanceof Error ? error.message : 'The plan could not be validated.';
    const cleanup = await reconcilePlanningReservations({ workspaceId, projectId: project.id, repositories, reservations });
    const recoveryNote = cleanup.every(result => result === 'released') ? ''
      : cleanup.includes('workspace_preserved')
        ? ' The private planning workspace did not match its clean checkpoint, so Alpha preserved it and kept the repository paused for recovery.'
        : ' The planning reservation changed during cleanup; refresh the project before retrying.';
    return blocked(`Task planning stopped before any specialist was launched. ${detail}${recoveryNote}`, project, repository);
  }

  try {
    if (!issue) {
      issue = await issueStore().create(workspaceId, {
      id: issueId,
      projectId: project.id,
      githubRepo: repository,
      title: issueTitle(cleanGoal),
      description: [
        fromBoard ? 'Build requested from the project board using the task-driven orchestrator.' : 'Build requested from project chat using the task-driven orchestrator.', '',
        'Original request:', cleanGoal, '',
        'Build expectations:',
        '- Work is assigned as separate, role-qualified tasks by Alpha’s validated plan.',
        '- Each specialist receives only its task package and repository path scope.',
        '- Alpha checks the result and required scripts before advancing to a dependent task.',
        '- A human remains responsible for final review and approval.',
        ...(fromBoard ? [] : ['', `Source conversation: ${input.threadId}`])
      ].join('\n'),
        status: 'todo', priority: 'medium',
        labels: ['alpha:chat-build', 'alpha:task-orchestration', idempotencyLabel], createdBy: context.userId
      });
      workspaceRegistry.bind('issues', issue.id, workspaceId);
      await supabaseService.shareIssue(issue);
      addCommentAndShare({
        id: `comm-${issue.id}-chat-build`, issueId: issue.id,
        authorType: 'system', authorName: 'Alpha Orchestrator',
        content: `Task workflow planned by ${plannerCandidate.persona.name}.`, createdAt: issue.createdAt
      });
    } else if (linkedIssueId) {
      addCommentAndShare({
        id: `comm-${issue.id}-build-${requestKey}`, issueId: issue.id,
        authorType: 'system', authorName: 'Alpha Orchestrator',
        content: fromBoard
          ? `Orchestrator build planned by ${plannerCandidate.persona.name}. Follow it on this task.`
          : `Orchestrator build planned by ${plannerCandidate.persona.name}. Follow it in project chat and its Build review tab.`,
        createdAt: new Date().toISOString()
      });
    }
  } catch (error) {
    const cleanup = await reconcilePlanningReservations({ workspaceId, projectId: project.id, repositories, reservations });
    const recoveryNote = cleanup.every(result => result === 'released') ? ''
      : cleanup.includes('workspace_preserved')
        ? ' Alpha preserved the private planning workspace because its state changed; it remains available for review.'
        : ' The planning reservation changed during cleanup; refresh the project before retrying.';
    return blocked(`The build plan was prepared, but its project record could not be saved. ${error instanceof Error ? error.message : 'Retry after checking the project connection.'}${recoveryNote}`, project, repository);
  }

  if (issue.id !== expectedIssueId) {
    const cleanup = await reconcilePlanningReservations({ workspaceId, projectId: project.id, repositories, reservations });
    const recoveryNote = cleanup.every(result => result === 'released') ? ''
      : cleanup.includes('workspace_preserved')
        ? ' The private planning workspace was preserved because its state changed; the repository remains paused for recovery.'
        : ' The planning reservation changed during cleanup; refresh the project before retrying.';
    return blocked(`The existing chat build issue has a different identity than this task workflow request. No specialists were started; contact a project administrator to reconcile the local build record.${recoveryNote}`, project, repository);
  }

  try {
    const repositoryWorkspaces = reservations.map(item => ({
      repository: item.repository, branchName: item.branchName, baseRef: baseRefs.get(item.repository) ?? item.baseCommit,
      baseCommit: item.baseCommit, worktreePath: item.worktreePath
    }));
    const { orchestrationService } = await import('./orchestrationRuntime.js');
    const snapshot = await orchestrationService.start({
      workspaceId, projectId: project.id, issueId: issue.id, repository,
      requestKey, requestFingerprint, createdBy: context.userId,
      executorId: orchestrationOwnerSessionId,
      runId: reservation.runId,
      planningOwnerSessionId: orchestrationOwnerSessionId,
      branchName: reservation.branchName,
      baseRef: baseRefs.get(reservation.repository) ?? reservation.baseCommit,
      baseCommit: reservation.baseCommit,
      worktreePath: reservation.worktreePath,
      repositoryWorkspaces,
      startingCommit: reservation.baseCommit,
      eligibleAgents: availableAgents,
      plan: planned.plan,
      planSource: 'model'
    });
    for (const extraReservation of reservations.slice(1)) {
      runWithWorkspace(workspaceId, () => sqliteService.releaseOrchestrationPlanningReservation(
        extraReservation.requestKey, requestFingerprint, orchestrationOwnerSessionId
      ));
    }
    return orchestrationStartResult(snapshot, project, repository);
  } catch (error) {
    const persisted = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationByRequestKey(requestKey));
    let recoveryNote = '';
    if (!persisted) {
      const cleanup = await reconcilePlanningReservations({ workspaceId, projectId: project.id, repositories, reservations });
      recoveryNote = cleanup.includes('workspace_preserved')
        ? ' Alpha preserved the private planning workspace because it changed after reservation; the repository remains paused for recovery.'
        : cleanup.includes('reservation_changed')
          ? ' The planning reservation changed during cleanup; refresh the project before retrying.'
          : '';
    }
    return blocked(`Task workflow could not start safely. ${error instanceof Error ? error.message : 'The orchestrator rejected the start request.'}${recoveryNote}`, project, repository);
  }
}

/** Start a real sequential repository build, or return the exact setup blocker. */
export function startProjectBuild(input: StartProjectBuildInput): Promise<ProjectBuildStartResult> {
  const requestKey = crypto.createHash('sha256')
    .update(`${input.context.workspaceId}:${input.threadId}:${input.messageId}`)
    .digest('hex')
    .slice(0, 16);
  const existing = inFlightBuilds.get(requestKey);
  if (existing) return existing;

  const pending = startProjectBuildOnce(input).finally(() => {
    if (inFlightBuilds.get(requestKey) === pending) inFlightBuilds.delete(requestKey);
  });
  inFlightBuilds.set(requestKey, pending);
  return pending;
}

/** Start one idempotent orchestrator plan for the selected repository. */
export function startProjectBuildBatch(
  input: Omit<StartProjectBuildInput, 'requestedRepository' | 'requestedRepositories'> & { repositories?: string[] }
): Promise<ProjectBuildStartResult[]> {
  const repositories = [...new Set((input.repositories ?? []).map(repository => repository.trim()).filter(Boolean))];
  const desktopProjectBuild = Boolean(input.projectId && !IS_CLOUD);
  if (desktopProjectBuild) {
    return startProjectBuild({ ...input, requestedRepositories: repositories }).then(result => [result]);
  }
  const targets: Array<string | undefined> = repositories.length ? repositories : [undefined];
  return Promise.all(targets.map(async repository => {
    try {
      const result = await startProjectBuild({
        ...input,
        messageId: targets.length > 1 ? `${input.messageId}:repo:${repository}` : input.messageId,
        requestedRepository: repository
      });
      return { ...result, repository: result.repository ?? repository };
    } catch (error) {
      return {
        status: 'blocked' as const,
        projectId: input.projectId,
        repository,
        reason: error instanceof Error ? error.message : 'The build could not be prepared.'
      };
    }
  }));
}

async function startProjectBuildOnce(input: StartProjectBuildInput): Promise<ProjectBuildStartResult> {
  const { context, projectId, threadId, messageId, content } = input;
  if (context.role === 'client') return blocked('Project builds are available to the internal project team.');
  if (!workspaceRegistry.can(context.role, 'agent.run')) {
    return blocked('Your workspace role cannot start project agent builds. Ask a project administrator to update your access.');
  }
  if (!projectId) return blocked('Choose a project in this conversation before asking Alpha to change repository files.');
  if (!workspaceRegistry.canAccessProject(context, projectId)) {
    return blocked('You are not assigned to this project. Ask its project manager to add you before starting a build.');
  }

  const workspaceId = context.workspaceId;
  return runWithWorkspace(workspaceId, async () => {
    const project = await projectStore().get(workspaceId, projectId);
    if (!project) return blocked('This project is no longer available in the active workspace.');

    const repos = repositoryOptions(project);
    const requestedRepos = input.requestedRepositories?.map(repo => repo.trim()).filter(Boolean)
      ?? (input.requestedRepository ? [input.requestedRepository.trim()] : []);
    if (requestedRepos.some(requested => !repos.some(repo => repo.toLowerCase() === requested.toLowerCase()))) {
      const invalid = requestedRepos.find(requested => !repos.some(repo => repo.toLowerCase() === requested.toLowerCase()))!;
      return blocked(`“${invalid}” is not attached to ${project.name}. Choose codebases listed in this project.`, project);
    }
    const selectedRepositories = requestedRepos.length ? [...new Set(requestedRepos)] : [...repos];
    if (!selectedRepositories.length) return blocked('Connect at least one repository to this project before starting a build.', project);

    const selectedCheckouts: SelectedProjectRepository[] = [];
    for (const repo of selectedRepositories) {
      let checkout = resolveProjectWorkspace(project, repo);
      if ((!checkout || !fs.existsSync(checkout.dir)) && repo) {
        try {
          await cloneAndBindProject(project, repo);
          checkout = resolveProjectWorkspace(project, repo);
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'repository connection failed';
          return blocked(`Alpha could not connect ${repo} for this build: ${detail} Check the GitHub connection and repository access, then retry.`, project, repo);
        }
      }
      if (!checkout || !fs.existsSync(checkout.dir)) {
        return blocked(`The ${repo} codebase is not checked out on this machine. Clone or attach it from the project’s Repository page, then try again.`, project, repo);
      }
      if (!(await isGitRepo(checkout.dir))) {
        return blocked(`The selected folder for ${repo} is not a Git checkout. Attach or clone it before starting a build.`, project, repo);
      }
      allowAttachedWorkspace(checkout, project.name);
      selectedCheckouts.push({ repository: repo, checkoutDir: checkout.dir });
    }
    const repository = selectedRepositories[0];
    if (IS_CLOUD) return blocked('Task-based builds require the authorized Alpha desktop with the local repository checkout.', project, repository);

    const buildSteps = await projectStore().getBuildSteps(workspaceId, project.id);
    const availableAgents = sqliteService.getAgents().filter(agent => !agent.isArchived);
    const projectAgents = (await Promise.all(availableAgents.map(async agent =>
      await workspaceRegistry.canAccessProjectAgentRun(context, project.id, agent.id) ? agent : null
    ))).filter((agent): agent is Agent => Boolean(agent));
    if (!projectAgents.length) {
      return blocked('No project-visible specialists are available. Add suitable specialists to the workspace or adjust their project access, then try again.', project, repository);
    }
    return startOrchestratedProjectBuild({
      context, project, repositories: selectedCheckouts, members: projectAgents,
      buildSteps: buildSteps ?? [], threadId, messageId, content, issueId: input.issueId,
      deliveryRepair: input.deliveryRepair
    });
  });
}
