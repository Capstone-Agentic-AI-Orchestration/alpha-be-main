import crypto from 'node:crypto';
import fs from 'node:fs';

import type { Project, ProjectBuildStep, Squad } from '../models/index.js';
import type { WorkspaceContext } from './workspaceRegistry.js';
import { issueStore, projectStore, squadStore } from '../store/stores.js';
import { isGitRepo, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { agentReadiness } from './agentReadiness.js';
import { reposForProject } from './githubIssueMapping.js';
import { cloneAndBindProject } from './projectBindings.js';
import { resolveProjectWorkspace, allowAttachedWorkspace } from './workspaceService.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { isSupportedTopology, squadRunner } from './squadRunner.js';
import { addCommentAndShare } from './boardWriteThrough.js';
import { supabaseService } from './supabaseService.js';
export { isProjectBuildRequest } from './projectBuildIntent.js';

export interface ProjectBuildStartResult {
  status: 'started' | 'queued' | 'in_progress' | 'awaiting_review' | 'failed' | 'blocked';
  projectId?: string;
  projectName?: string;
  repository?: string;
  issueId?: string;
  issueIdentifier?: string;
  squadId?: string;
  squadName?: string;
  squadRunId?: string;
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
    try {
      if (!(await isGitWorkingTreeClean(checkout.dir))) {
        return blocked('This repository has uncommitted changes. Commit or stash them before starting a build so agent commits do not include your existing work.', project, repository);
      }
    } catch {
      return blocked('Alpha could not verify the repository’s Git status. Check repository permissions and try again.', project, repository);
    }
    try {
      await fs.promises.access(checkout.dir, fs.constants.W_OK);
    } catch {
      return blocked('The selected repository is not writable by the local build runner. Check its folder permissions, then try again.', project, repository);
    }
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

    const runtimes = sqliteService.getRuntimes();
    const notReady = agents.map(agent => ({ agent, readiness: agentReadiness(agent, runtimes) }))
      .filter(item => item.readiness.status !== 'ready');
    if (notReady.length) {
      const first = notReady[0];
      return blocked(`${first.agent.name} is not ready: ${first.readiness.detail}`, project, repository);
    }

    const stepAgentIds = orderedSteps.map(step => step.agentId).filter((id): id is string => Boolean(id));
    const requestKey = crypto.createHash('sha256').update(`${workspaceId}:${threadId}:${messageId}`).digest('hex').slice(0, 16);
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
        '- Implement the requested behavior in the project repository, not as a code snippet in chat.',
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

    const enabledPlan = orderedSteps.map((step, index) => {
      const agentName = step.agentId ? agents.find(agent => agent.id === step.agentId)?.name : undefined;
      return `${index + 1}. ${step.label} (${step.phase})${agentName ? ` — ${agentName}` : ''}`;
    });
    const plan = [
      `Implement the complete project change requested in issue ${issue.identifier}.`,
      `User request: ${content.trim().replace(/^\/build\s*/i, '')}`,
      ...(enabledPlan.length ? ['Follow the project’s ordered build sequence:', ...enabledPlan] : []),
      'This is a real repository build. Create or update the required project files on the assigned branch; do not answer with a standalone code snippet.',
      'Preserve unrelated changes already in the working tree. Inspect the repository before editing and follow its established stack and conventions.',
      'Before handing work to the next agent, commit your completed changes and leave a concise, factual handoff.',
      'The final agent must run the available relevant checks, report their actual results, and summarize changed files and remaining limitations.'
    ];

    try {
      const squadRun = await squadRunner.startSquadRun({
        squadId: squad.id,
        issueId: issue.id,
        plan,
        mission: content.trim().replace(/^\/build\s*/i, ''),
        workspaceId,
        memberAgentIds: stepAgentIds
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
