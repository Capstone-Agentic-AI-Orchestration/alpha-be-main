import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Agent, Project, ProjectBuildStep, Squad, SquadMemberAssignment } from '../models/index.js';
import { ALPHA_ORCHESTRATION_ENABLED, IS_CLOUD } from '../config/env.js';
import type { WorkspaceContext } from './workspaceRegistry.js';
import { issueStore, projectStore, squadStore } from '../store/stores.js';
import { addBranchWorktree, getCurrentBranch, getHeadCommit, isGitRepo, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { agentReadiness } from './agentReadiness.js';
import { reposForProject } from './githubIssueMapping.js';
import { cloneAndBindProject } from './projectBindings.js';
import { projectRunWorkspacePath, resolveProjectWorkspace, allowAttachedWorkspace } from './workspaceService.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { isSupportedTopology, orderedMembers, squadRunner } from './squadRunner.js';
import { addCommentAndShare } from './boardWriteThrough.js';
import { supabaseService } from './supabaseService.js';
import { resolveAgent } from './personaService.js';
import { orchestrationRequestFingerprint } from './orchestrationService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { OrchestrationPlanner, OrchestrationPlanningError, type PlannerAgentIdentity } from './orchestrationPlanner.js';
import { roleCanOwnOrchestrationTask } from './orchestrationContract.js';
import { inspectOrchestrationPlanningWorktree, removeStaleOrchestrationPlanningWorktree } from './orchestrationPlanningRecovery.js';
import { orchestrationSessionId } from './orchestrationSession.js';
export { isProjectBuildRequest } from './projectBuildIntent.js';

export interface ProjectBuildStartResult {
  status: 'started' | 'queued' | 'in_progress' | 'awaiting_review' | 'completed' | 'failed' | 'blocked';
  projectId?: string;
  projectName?: string;
  repository?: string;
  issueId?: string;
  issueIdentifier?: string;
  squadId?: string;
  squadName?: string;
  squadRunId?: string;
  orchestrationRunId?: string;
  orchestrationTaskCount?: number;
  orchestrationCurrentTask?: { id: string; title: string; ownerAgentId: string };
  branchName?: string;
  reason?: string;
}

interface StartProjectBuildInput {
  context: WorkspaceContext;
  projectId?: string;
  threadId: string;
  messageId: string;
  content: string;
  requestedRepository?: string;
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
    reason
  };
}

function issueTitle(content: string): string {
  const clean = content.trim().replace(/^\/build\s*/i, '').replace(/[\r\n]+/g, ' ');
  const sentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
  return `Build: ${sentence.slice(0, 92).trim()}`;
}

function repositoryOptions(project: Project): string[] {
  return reposForProject(project);
}

function buildStepInstructions(phase: ProjectBuildStep['phase'], label: string): string {
  const scope = `Complete only the “${label}” step.`;
  switch (phase) {
    case 'requirements':
      return `${scope} Turn the user's request and existing repository behavior into clear, testable requirements. Record assumptions and unresolved questions for the next agent. Do not begin implementation.`;
    case 'architecture':
      return `${scope} Define the relevant components, interfaces, and decisions for the requested change. Leave a concise design handoff; do not implement later stages.`;
    case 'database':
      return `${scope} Make only the required data-layer changes and focused migration or schema checks. Preserve compatibility and leave the next agent a handoff.`;
    case 'validation':
      return `${scope} Verify the implemented behavior against the request and run relevant checks. Report evidence and concrete failures; do not redo the implementation.`;
    case 'review':
      return `${scope} Review the changes already on the branch for defects, security issues, and convention problems. Report findings with evidence; do not take over implementation.`;
    case 'delivery':
      return `${scope} Check repository and CI readiness and report blockers. Do not merge, publish a release, or deploy without an explicit user request.`;
    case 'implementation':
    default:
      return `${scope} Implement only the feature slice named by this step, building on prior commits. Leave other agents' stages to them.`;
  }
}

function assignmentsForBuildSteps(
  steps: ProjectBuildStep[],
  executionOrder: string[]
): SquadMemberAssignment[] {
  if (!steps.length || !executionOrder.length) return [];
  const assignments = new Map<string, SquadMemberAssignment>();

  steps.forEach((step, index) => {
    const agentId = step.agentId && executionOrder.includes(step.agentId)
      ? step.agentId
      : executionOrder[index % executionOrder.length];
    const instruction = `(${step.phase}) ${buildStepInstructions(step.phase, step.label)}`;
    const existing = assignments.get(agentId);
    assignments.set(agentId, existing
      ? {
          agentId,
          stageLabel: `${existing.stageLabel} · ${step.label}`,
          phase: existing.phase === step.phase ? step.phase : undefined,
          instructions: `${existing.instructions}\n- ${instruction}`
        }
      : {
          agentId,
          stageLabel: step.label,
          phase: step.phase,
          instructions: instruction
        });
  });

  return [...assignments.values()];
}

function selectSquad(
  context: WorkspaceContext,
  project: Project,
  squads: Squad[],
  assignments: Array<{ squadId: string; status: string }>,
  steps: ProjectBuildStep[]
): Squad | null {
  const activeIds = new Set(assignments.filter(item => item.status === 'active').map(item => item.squadId));
  const accessible = squads.filter(squad => activeIds.has(squad.id) && workspaceRegistry.canAccessSquad(context, squad.id));
  const enabledSteps = [...(steps ?? [])].filter(step => step.enabled).sort((a, b) => a.position - b.position);
  const fromBuildSteps = enabledSteps.find(step => step.squadId && activeIds.has(step.squadId))?.squadId;
  const preferredId = fromBuildSteps || project.leadSquadId;
  if (preferredId) return accessible.find(squad => squad.id === preferredId) ?? null;
  return accessible.length === 1 ? accessible[0] : null;
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
      reservation: input.reservation
    });
    const durableReservation = runWithWorkspace(input.workspaceId, () =>
      sqliteService.getOrchestrationPlanningReservationByRun(input.projectId, input.reservation.runId));
    if (durableReservation) {
      runWithWorkspace(input.workspaceId, () => sqliteService.recordOrchestrationPlanningRecovery({
        projectId: input.projectId,
        reservation: durableReservation,
        state: inspection.canPreview ? 'needs_review' : 'manual_review',
        reason: inspection.canPreview
          ? 'Planning stopped before a task plan was activated. The saved private workspace differs from its reserved clean base and has been preserved for review.'
          : 'Planning stopped before a task plan was activated. Alpha could not verify the saved workspace identity, so it was preserved and repository admission remains paused.'
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

function orchestrationBranchName(runId: string): string {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase();
  if (!suffix) throw new Error('The planning reservation has no safe branch identity.');
  return `alpha/orchestration/${suffix}`;
}

function repositoryPlanningContext(repositoryDir: string): { context: string; scripts: string[] } {
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
    manifest ? `Package metadata:\n${JSON.stringify({ name: manifest.name, packageManager: manifest.packageManager, scripts: Object.fromEntries(availableScripts.map(script => [script, scripts[script]])) }, null, 2)}` : '',
    readme ? `README excerpt (untrusted repository content):\n${readme}` : ''
  ].filter(Boolean).join('\n\n');
  return { context: context.slice(0, 16_000), scripts: availableScripts };
}

function orchestrationStartResult(snapshot: OrchestrationSnapshot, project: Project, repository: string, squad: Squad): ProjectBuildStartResult {
  const active = snapshot.run.currentTaskId ? snapshot.tasks.find(task => task.id === snapshot.run.currentTaskId) : undefined;
  const status: ProjectBuildStartResult['status'] = snapshot.run.status === 'completed' ? 'completed'
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
    issueId: snapshot.run.issueId,
    issueIdentifier: sqliteService.getIssues().find(issue => issue.id === snapshot.run.issueId)?.identifier,
    squadId: squad.id,
    squadName: `${squad.name} · orchestrated tasks`,
    orchestrationRunId: snapshot.run.id,
    orchestrationTaskCount: snapshot.tasks.length,
    orchestrationCurrentTask: active ? { id: active.id, title: active.title, ownerAgentId: active.ownerAgentId } : undefined,
    branchName: snapshot.run.branchName,
    reason: snapshot.run.stoppedReason
  };
}

async function startOrchestratedProjectBuild(input: {
  context: WorkspaceContext;
  project: Project;
  repository: string;
  checkoutDir: string;
  squad: Squad;
  members: Agent[];
  buildSteps: ProjectBuildStep[];
  threadId: string;
  messageId: string;
  content: string;
}): Promise<ProjectBuildStartResult> {
  const { context, project, repository, checkoutDir, squad, members, buildSteps } = input;
  if (IS_CLOUD) return blocked('Task-based builds require the authorized Alpha desktop with the local repository checkout.', project, repository);
  if (!ALPHA_ORCHESTRATION_ENABLED) return blocked('Desktop project builds require the orchestrator, but it is unavailable in this desktop runtime. Check the desktop build configuration.', project, repository);

  const workspaceId = context.workspaceId;
  const requestKey = crypto.createHash('sha256').update(`${workspaceId}:${input.threadId}:${input.messageId}`).digest('hex').slice(0, 16);
  const cleanGoal = input.content.trim().replace(/^\/build\s*/i, '').trim();
  if (!cleanGoal || cleanGoal.length > 4_000) return blocked('Keep a task-based build request between 1 and 4,000 characters so its accepted scope remains explicit.', project, repository);
  const expectedIssueId = `chat-build-${requestKey}`;
  const requestFingerprint = orchestrationRequestFingerprint({
    workspaceId, projectId: project.id, issueId: expectedIssueId, repository,
    createdBy: context.userId, originalRequest: cleanGoal
  });
  const priorSnapshot = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationByRequestKey(requestKey));
  if (priorSnapshot) {
    if (priorSnapshot.run.requestFingerprint !== requestFingerprint) {
      return blocked('This chat request key is already associated with a different task workflow. Start a new chat message to create a separate build.', project, repository);
    }
    return orchestrationStartResult(priorSnapshot, project, repository, squad);
  }
  let activeWorkflow = runWithWorkspace(workspaceId, () => sqliteService.getActiveOrchestrationForProject(project.id, repository));
  if (activeWorkflow) {
    const reservation = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationPlanningReservation(project.id, repository));
    const isPlanningReservation = reservation?.runId === activeWorkflow.runId && activeWorkflow.status === 'planning';
    const ownsReservation = isPlanningReservation && reservation?.ownerSessionId === orchestrationOwnerSessionId;
    if (isPlanningReservation && !ownsReservation) {
      const recovery = await reconcilePlanningReservation({
        workspaceId,
        repositoryDir: checkoutDir,
        projectId: project.id,
        reservation
      });
      if (recovery === 'workspace_preserved') {
        return blocked('A previous Alpha session stopped while planning and its private workspace no longer matches the recorded clean base. Alpha preserved it and paused this repository so no other build or code call can overwrite the unresolved work.', project, repository);
      }
      if (recovery === 'reservation_changed') {
        return blocked('The interrupted planning reservation changed while Alpha was reconciling it. Refresh the project and retry after checking the active build.', project, repository);
      }
      activeWorkflow = runWithWorkspace(workspaceId, () => sqliteService.getActiveOrchestrationForProject(project.id, repository));
    }
    const isSamePlanningRequest = ownsReservation && reservation?.runId === activeWorkflow?.runId && reservation.requestKey === requestKey;
    if (activeWorkflow && !isSamePlanningRequest) {
      return blocked(`A task-based build is ${activeWorkflow.status.replace('_', ' ')} for this repository. Follow or resolve that build before starting another.`, project, repository);
    }
  }

  const issueId = `chat-build-${requestKey}`;
  const idempotencyLabel = `alpha:chat-build-${requestKey}`;
  const currentIssues = await issueStore().list(workspaceId);
  let issue = currentIssues.find(item => item.projectId === project.id && item.labels.includes(idempotencyLabel));
  const previousLegacyRun = issue && sqliteService.getSquadRuns().find(run => run.issueId === issue!.id);
  if (previousLegacyRun && issue) {
    const runs = sqliteService.getRunsForSquadRun(previousLegacyRun.id);
    const firstRun = runs.sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0))[0];
    return {
      status: previousLegacyRun.status === 'awaiting_approval' ? 'awaiting_review' : previousLegacyRun.status === 'failed' || previousLegacyRun.status === 'cancelled' ? 'failed' : 'in_progress',
      projectId: project.id, projectName: project.name, repository, issueId: issue.id,
      issueIdentifier: issue.identifier, squadId: squad.id, squadName: squad.name,
      squadRunId: previousLegacyRun.id, branchName: firstRun?.branchName ?? previousLegacyRun.branchName,
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
  const eligible = members.map(agent => {
    const readiness = agentReadiness(agent, sqliteService.getRuntimes());
    if (readiness.status !== 'ready') return { agent, readiness, persona: undefined };
    return { agent, readiness, persona: resolveAgent(agent, { projectKey: project.key, includeMemory: false, includeToolPolicy: false }) };
  }).filter((item): item is { agent: Agent; readiness: ReturnType<typeof agentReadiness>; persona: ReturnType<typeof resolveAgent> } => Boolean(item.persona));

  const configuredPlannerStep = orderedSteps.find(step => PLANNING_KINDS.has(step.phase) && step.agentId);
  let plannerCandidate = configuredPlannerStep
    ? eligible.find(item => item.agent.id === configuredPlannerStep.agentId)
    : eligible.find(item => roleCanOwnOrchestrationTask('requirements', item.persona.role));
  if (!plannerCandidate) {
    const reason = configuredPlannerStep
      ? `The configured ${configuredPlannerStep.phase} step owner is unavailable or not ready. Update that owner before starting the task workflow.`
      : 'The project squad has no ready Research, Requirements, Manager, Architecture, or Orchestrator Agent persona to validate the task plan.';
    return blocked(reason, project, repository);
  }
  if (!roleCanOwnOrchestrationTask('requirements', plannerCandidate.persona.role)) {
    return blocked(`${plannerCandidate.persona.role} cannot act as the read-only planning orchestrator. Assign a Research, Requirements, Manager, Architecture, or Orchestrator Agent persona to the planning step.`, project, repository);
  }
  const plannerIdentity: PlannerAgentIdentity = {
    id: plannerCandidate.agent.id,
    name: plannerCandidate.persona.name,
    role: plannerCandidate.persona.role,
    provider: plannerCandidate.persona.modelProvider,
    modelName: plannerCandidate.persona.modelName,
    reasoningEffort: plannerCandidate.persona.reasoningEffort,
    systemPrompt: plannerCandidate.persona.systemPrompt
  };
  const availableAgents = eligible.map(item => ({ id: item.agent.id, role: item.persona.role, ready: true as const }));
  const activeIndependentCall = runWithWorkspace(workspaceId, () =>
    sqliteService.getActiveAgentCallProjectLock(project.id, repository));
  if (activeIndependentCall) {
    return blocked('An independent code call or patch is using this repository. Let it finish before starting a task-based build.', project, repository);
  }

  let baseCommit: string;
  try {
    baseCommit = await getHeadCommit(checkoutDir);
  } catch (error) {
    return blocked(`The selected repository has no stable Git base for planning. ${error instanceof Error ? error.message : ''}`.trim(), project, repository);
  }
  const proposedRunId = `orchestration-${crypto.randomUUID()}`;
  let reservation: ReturnType<typeof sqliteService.reserveOrchestrationPlanning>;
  try {
    reservation = runWithWorkspace(workspaceId, () => sqliteService.reserveOrchestrationPlanning({
      projectId: project.id,
      repository,
      requestKey,
      requestFingerprint,
      createdBy: context.userId,
      runId: proposedRunId,
      branchName: orchestrationBranchName(proposedRunId),
      baseCommit,
      worktreePath: projectRunWorkspacePath(project.id, proposedRunId),
      ownerSessionId: orchestrationOwnerSessionId
    }));
  } catch (error) {
    return blocked(error instanceof Error ? error.message : 'The project repository could not be reserved for planning.', project, repository);
  }

  try {
    if (!fs.existsSync(reservation.worktreePath)) {
      await addBranchWorktree(checkoutDir, reservation.worktreePath, reservation.branchName, reservation.baseCommit);
    } else if (!(await isGitRepo(reservation.worktreePath)) ||
        await getCurrentBranch(reservation.worktreePath) !== reservation.branchName ||
        await getHeadCommit(reservation.worktreePath) !== reservation.baseCommit ||
        !(await isGitWorkingTreeClean(reservation.worktreePath))) {
      return blocked('The saved planning worktree does not match its reserved branch and base commit. Alpha preserved it for recovery; review the Live Build Room before retrying.', project, repository);
    }
  } catch (error) {
    return blocked(`The isolated planning workspace could not be prepared. ${error instanceof Error ? error.message : 'Inspect the saved build workspace before retrying.'}`, project, repository);
  }

  const planningContext = repositoryPlanningContext(reservation.worktreePath);
  const planner = new OrchestrationPlanner();
  let planned;
  try {
    planned = await planner.createPlan({
      runId: reservation.runId,
      cwd: reservation.worktreePath,
      goal: cleanGoal,
      repositoryContext: planningContext.context,
      availableScripts: planningContext.scripts,
      eligibleAgents: availableAgents,
      planner: plannerIdentity,
      buildSteps: orderedSteps.map(step => ({
        id: step.id, label: step.label, phase: step.phase,
        agentId: step.agentId, position: step.position, required: step.required,
        dependsOn: step.dependsOn ?? []
      }))
    });
  } catch (error) {
    const detail = error instanceof OrchestrationPlanningError ? error.message : error instanceof Error ? error.message : 'The plan could not be validated.';
    const cleanup = await reconcilePlanningReservation({ workspaceId, repositoryDir: checkoutDir, projectId: project.id, reservation });
    const recoveryNote = cleanup === 'released' ? ''
      : cleanup === 'workspace_preserved'
        ? ' The private planning workspace did not match its clean checkpoint, so Alpha preserved it and kept the repository paused for recovery.'
        : ' The planning reservation changed during cleanup; refresh the project before retrying.';
    return blocked(`Task planning stopped before any specialist was launched. ${detail}${recoveryNote}`, project, repository);
  }

  if (!issue) {
    issue = await issueStore().create(workspaceId, {
      id: issueId,
      projectId: project.id,
      githubRepo: repository,
      title: issueTitle(cleanGoal),
      description: [
        'Build requested from project chat using the task-driven orchestrator.', '',
        'Original request:', cleanGoal, '',
        'Build expectations:',
        '- Work is assigned as separate, role-qualified tasks by Alpha’s validated plan.',
        '- Each specialist receives only its task package and repository path scope.',
        '- Alpha checks the result and required scripts before advancing to a dependent task.',
        '- A human remains responsible for final review and approval.',
        '', `Source conversation: ${input.threadId}`
      ].join('\n'),
      status: 'todo', priority: 'medium', assignedSquadId: squad.id,
      labels: ['alpha:chat-build', 'alpha:task-orchestration', idempotencyLabel], createdBy: context.userId
    });
    workspaceRegistry.bind('issues', issue.id, workspaceId);
    await supabaseService.shareIssue(issue);
    addCommentAndShare({
      id: `comm-${issue.id}-chat-build`, issueId: issue.id,
      authorType: 'system', authorName: 'Alpha Orchestrator',
      content: `Task workflow planned by ${plannerCandidate.persona.name} for ${squad.name}.`, createdAt: issue.createdAt
    });
  }

  if (issue.id !== expectedIssueId) {
    const cleanup = await reconcilePlanningReservation({ workspaceId, repositoryDir: checkoutDir, projectId: project.id, reservation });
    const recoveryNote = cleanup === 'released' ? ''
      : cleanup === 'workspace_preserved'
        ? ' The private planning workspace was preserved because its state changed; the repository remains paused for recovery.'
        : ' The planning reservation changed during cleanup; refresh the project before retrying.';
    return blocked(`The existing chat build issue has a different identity than this task workflow request. No specialists were started; contact a project administrator to reconcile the local build record.${recoveryNote}`, project, repository);
  }

  try {
    const { orchestrationService } = await import('./orchestrationRuntime.js');
    const snapshot = await orchestrationService.start({
      workspaceId, projectId: project.id, issueId: issue.id, repository,
      requestKey, requestFingerprint, createdBy: context.userId,
      executorId: orchestrationOwnerSessionId,
      runId: reservation.runId,
      planningOwnerSessionId: orchestrationOwnerSessionId,
      branchName: reservation.branchName,
      baseRef: reservation.baseCommit,
      baseCommit: reservation.baseCommit,
      worktreePath: reservation.worktreePath,
      startingCommit: reservation.baseCommit,
      eligibleAgents: availableAgents,
      plan: planned.plan,
      planSource: 'model'
    });
    return orchestrationStartResult(snapshot, project, repository, squad);
  } catch (error) {
    const persisted = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationByRequestKey(requestKey));
    let recoveryNote = '';
    if (!persisted) {
      const cleanup = await reconcilePlanningReservation({ workspaceId, repositoryDir: checkoutDir, projectId: project.id, reservation });
      recoveryNote = cleanup === 'workspace_preserved'
        ? ' Alpha preserved the private planning workspace because it changed after reservation; the repository remains paused for recovery.'
        : cleanup === 'reservation_changed'
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
  input: Omit<StartProjectBuildInput, 'requestedRepository'> & { repositories?: string[] }
): Promise<ProjectBuildStartResult[]> {
  const repositories = [...new Set((input.repositories ?? []).map(repository => repository.trim()).filter(Boolean))];
  const desktopProjectBuild = Boolean(input.projectId && !IS_CLOUD);
  if (desktopProjectBuild && repositories.length > 1) {
    return Promise.resolve([blocked('Orchestrator plans run against one repository at a time. Choose a single repository for this build.', undefined, repositories.join(', '))]);
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
  if (!workspaceRegistry.can(context.role, 'agent.run') || !workspaceRegistry.can(context.role, 'squad.run')) {
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
    const requested = input.requestedRepository?.trim();
    if (requested && !repos.some(repo => repo.toLowerCase() === requested.toLowerCase())) {
      return blocked(`“${requested}” is not a repository attached to ${project.name}. Choose one of this project’s repositories.`, project);
    }
    if (!requested && repos.length > 1) {
      return blocked(`Choose one repository to build: ${repos.join(', ')}.`, project);
    }

    let repository = requested || undefined;
    if (!repository && repos.length) {
      const connected: string[] = [];
      for (const repo of repos) {
        const checkout = resolveProjectWorkspace(project, repo);
        if (checkout && fs.existsSync(checkout.dir) && await isGitRepo(checkout.dir)) connected.push(repo);
      }
      if (connected.length === 1) repository = connected[0];
      else if (connected.length > 1) {
        return blocked(`Choose which repository to build in: ${connected.join(', ')}.`, project);
      } else if (repos.length === 1) {
        repository = repos[0];
      } else {
        return blocked(`Connect one of this project’s repositories before starting a build: ${repos.join(', ')}.`, project);
      }
    }

    let checkout = resolveProjectWorkspace(project, repository);
    if ((!checkout || !fs.existsSync(checkout.dir)) && repository) {
      try {
        // A repository already attached to the project is enough to build.
        // Bring its managed working copy onto this runner the first time,
        // instead of sending the user away to clone it by hand.
        await cloneAndBindProject(project, repository);
        checkout = resolveProjectWorkspace(project, repository);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'repository connection failed';
        return blocked(
          `Alpha could not connect ${repository} for this build: ${detail} Check the GitHub connection and repository access, then retry.`,
          project,
          repository
        );
      }
    }
    if (!checkout || !fs.existsSync(checkout.dir)) {
      return blocked(
        repository
          ? `The ${repository} repository is not checked out on this machine. Clone or attach it from the project’s Repository page, then try again.`
          : `This project has no local repository checkout. Clone or attach its repository from the project’s Repository page, then try again.`,
        project,
        repository
      );
    }
    if (!(await isGitRepo(checkout.dir))) {
      return blocked('The selected project folder is not a Git checkout. Attach or clone the repository before starting a build.', project, repository);
    }
    // Do not block on a dirty source checkout. The squad runner creates a
    // private Git worktree for this build so user edits stay in the source
    // directory and cannot be swept into an agent commit.
    allowAttachedWorkspace(checkout, project.name);

    const assignments = await workspaceRegistry.listSquadProjectAssignments(workspaceId, project.id);
    const squads = await squadStore().list(workspaceId);
    const buildSteps = await projectStore().getBuildSteps(workspaceId, project.id);
    const squad = selectSquad(context, project, squads, assignments, buildSteps ?? []);
    const activeAssigned = assignments.filter(item => item.status === 'active');
    if (!squad) {
      if (!activeAssigned.length) return blocked('Assign a sequential agent squad to this project in Project settings before starting a build.', project, repository);
      if (activeAssigned.length > 1 && !project.leadSquadId) {
        return blocked('More than one squad is assigned to this project. Set the project’s lead squad or choose one in Project settings.', project, repository);
      }
      return blocked('The project’s configured build squad is unavailable. Reassign an active squad or update the project’s lead squad.', project, repository);
    }
    if (!isSupportedTopology(squad.topology)) {
      return blocked(`The project’s assigned squad uses “${squad.topology}” orchestration, which is not supported for builds yet. Set it to Sequential in Squad settings.`, project, repository);
    }

    const requestKey = crypto.createHash('sha256').update(`${workspaceId}:${threadId}:${messageId}`).digest('hex').slice(0, 16);
    const orderedSteps = [...(buildSteps ?? [])].filter(step => step.enabled).sort((a, b) => a.position - b.position);
    const otherSquadStep = orderedSteps.find(step => step.squadId && step.squadId !== squad.id);
    if (otherSquadStep) {
      return blocked(`The project build sequence includes “${otherSquadStep.label}” on another squad. Configure one sequential squad for this build, or split the work into separate builds.`, project, repository);
    }

    const squadMembers = new Set(squad.memberAgentIds);
    const outsideMember = orderedSteps.find(step => step.agentId && !squadMembers.has(step.agentId));
    if (outsideMember) {
      return blocked(`The “${outsideMember.label}” step uses an agent outside ${squad.name}. Add that agent to the project squad or update the build sequence.`, project, repository);
    }

    const members = [...new Set(squad.memberAgentIds)];
    if (!members.length) return blocked(`${squad.name} has no agents assigned. Add agents before starting this build.`, project, repository);
    const agents = sqliteService.getAgents().filter(agent => members.includes(agent.id) && !agent.isArchived);
    const missing = members.filter(id => !agents.some(agent => agent.id === id));
    if (missing.length) return blocked(`${squad.name} includes unavailable agents. Update the squad membership before starting a build.`, project, repository);

    const useOrchestrator = !IS_CLOUD && Boolean(project.id);
    if (useOrchestrator) {
      if (!repository) return blocked('Task-based builds require one repository attached to this project.', project);
      return startOrchestratedProjectBuild({
        context, project, repository, checkoutDir: checkout.dir, squad, members: agents,
        buildSteps: buildSteps ?? [], threadId, messageId, content
      });
    }

    const activeWorkflow = !IS_CLOUD
      ? runWithWorkspace(workspaceId, () => sqliteService.getActiveOrchestrationForProject(project.id, repository))
      : undefined;
    if (activeWorkflow) {
      if (!repository) return blocked('A task-based build is already active for this project. Choose its repository in the project workspace to follow or resolve it.', project);
      const activeSnapshot = runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationSnapshot(activeWorkflow.runId));
      const cleanGoal = content.trim().replace(/^\/build\s*/i, '').trim();
      const fingerprint = activeSnapshot && orchestrationRequestFingerprint({
        workspaceId, projectId: project.id, issueId: activeSnapshot.run.issueId,
        repository, createdBy: context.userId, originalRequest: cleanGoal
      });
      if (activeSnapshot?.run.requestKey === requestKey && activeSnapshot.run.requestFingerprint === fingerprint) {
        return orchestrationStartResult(activeSnapshot, project, repository, squad);
      }
      return blocked(`A task-based build is ${activeWorkflow.status.replace('_', ' ')} for this repository. Follow or resolve that build before starting another.`, project, repository);
    }

    const runtimes = sqliteService.getRuntimes();
    const notReady = agents.map(agent => ({ agent, readiness: agentReadiness(agent, runtimes) }))
      .filter(item => item.readiness.status !== 'ready');
    if (notReady.length) {
      const first = notReady[0];
      return blocked(`${first.agent.name} is not ready: ${first.readiness.detail}`, project, repository);
    }

    const stepAgentIds = orderedSteps.map(step => step.agentId).filter((id): id is string => Boolean(id));
    const idempotencyLabel = `alpha:chat-build-${requestKey}`;
    const currentIssues = await issueStore().list(workspaceId);
    let issue = currentIssues.find(item => item.projectId === project.id && item.labels.includes(idempotencyLabel));
    if (!issue) {
      const description = [
        'Build requested from project chat.',
        '',
        'Original request:',
        content.trim().replace(/^\/build\s*/i, ''),
        '',
        'Build expectations:',
        '- Complete your assigned build stage in the project repository; do not answer with a standalone code snippet in chat.',
        '- Follow the repository’s existing conventions and preserve unrelated user changes.',
        '- Run the applicable repository checks and report their real results.',
        '- Summarize changed files, verification, and anything that still needs attention.',
        '',
        `Source conversation: ${threadId}`
      ].join('\n');
      issue = await issueStore().create(workspaceId, {
        id: `chat-build-${requestKey}`,
        projectId: project.id,
        githubRepo: repository,
        title: issueTitle(content),
        description,
        status: 'todo',
        priority: 'medium',
        assignedSquadId: squad.id,
        labels: ['alpha:chat-build', idempotencyLabel],
        createdBy: context.userId
      });
      workspaceRegistry.bind('issues', issue.id, workspaceId);
      await supabaseService.shareIssue(issue);
      addCommentAndShare({
        id: `comm-${issue.id}-chat-build`,
        issueId: issue.id,
        authorType: 'system',
        authorName: 'Alpha Orchestrator',
        content: `Build request received from project chat and assigned to ${squad.name}.`,
        createdAt: issue.createdAt
      });
    }

    const existingRun = sqliteService.getSquadRuns().find(run => run.issueId === issue!.id);
    if (existingRun) {
      const runs = sqliteService.getRunsForSquadRun(existingRun.id);
      const firstRun = runs.sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0))[0];
      const status: ProjectBuildStartResult['status'] = existingRun.status === 'failed' || existingRun.status === 'cancelled'
        ? 'failed'
        : existingRun.status === 'awaiting_approval'
          ? 'awaiting_review'
          : firstRun?.status === 'queued' ? 'queued' : 'in_progress';
      return {
        status,
        projectId: project.id,
        projectName: project.name,
        repository,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        squadId: squad.id,
        squadName: squad.name,
        squadRunId: existingRun.id,
        branchName: existingRun.branchName,
        reason: existingRun.stoppedReason
      };
    }

    const executionOrder = [...new Set([
      ...stepAgentIds,
      ...orderedMembers(squad)
    ])];
    const memberAssignments = assignmentsForBuildSteps(orderedSteps, executionOrder);
    const plan = [
      `Shared project goal: ${content.trim().replace(/^\/build\s*/i, '')}`,
      `Target issue: ${issue.identifier} — ${issue.title}`,
      'This is a repository build in an isolated worktree. Preserve unrelated user changes and follow the repository’s existing stack and conventions.',
      'Each agent receives its own stage assignment. Follow your assigned stage and persona; do not repeat or take over other agents’ work.',
      'Before your stage ends, leave a concise, factual handoff describing what you completed, important decisions, checks actually run, and what the next agent should do.'
    ];

    try {
      const squadRun = await squadRunner.startSquadRun({
        squadId: squad.id,
        issueId: issue.id,
        plan,
        mission: content.trim().replace(/^\/build\s*/i, ''),
        workspaceId,
        baseWorkspaceDir: checkout.dir,
        memberAgentIds: stepAgentIds,
        memberAssignments
      });
      workspaceRegistry.bind('squad_runs', squadRun.id, workspaceId);
      const runs = sqliteService.getRunsForSquadRun(squadRun.id);
      for (const run of runs) workspaceRegistry.bind('prototype_runs', run.id, workspaceId);
      const firstRun = runs.sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0))[0];
      return {
        status: firstRun?.status === 'queued' ? 'queued' : 'started',
        projectId: project.id,
        projectName: project.name,
        repository,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        squadId: squad.id,
        squadName: squad.name,
        squadRunId: squadRun.id,
        branchName: squadRun.branchName
      };
    } catch (error) {
      const failedRun = sqliteService.getSquadRuns()
        .filter(run => run.issueId === issue!.id)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      return {
        status: 'failed',
        projectId: project.id,
        projectName: project.name,
        repository,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        squadId: squad.id,
        squadName: squad.name,
        squadRunId: failedRun?.id,
        branchName: failedRun?.branchName,
        reason: error instanceof Error ? error.message : 'The agent run could not start.'
      };
    }
  });
}
