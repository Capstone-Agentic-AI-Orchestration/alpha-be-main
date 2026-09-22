import { Request, Response, Router } from 'express';
import { route } from './asyncRoute.js';
import { agentStore, issueStore, projectStore, runStore, squadStore } from '../store/stores.js';
import type { Agent, ProjectBuildStep, PrototypeRun, Squad, SquadRun } from '../models/index.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import {
  requireProjectWorkspace,
  requireWorkspaceCapability
} from './workspaceContext.js';

export const liveBuildRoomRouter = Router();

type RoomCardStatus = 'completed' | 'running' | 'waiting' | 'review' | 'failed' | 'idle';
type RoomPhaseStatus = 'completed' | 'running' | 'waiting' | 'review' | 'failed';

interface RoomPhase {
  id: string;
  label: string;
  description: string;
  status: RoomPhaseStatus;
  progress: number;
}

/** Percentages represent completed stages only; active work has no invented share. */
function progressForRun(run: PrototypeRun | undefined): number {
  if (!run) return 0;
  if (run.status === 'completed' || run.status === 'awaiting_approval') return 100;
  if (!Array.isArray(run.stages) || run.stages.length === 0) return 0;
  const complete = run.stages.filter((stage: any) => stage.status === 'success').length;
  return Math.min(100, Math.round((complete / run.stages.length) * 100));
}

function phaseStatusForRun(run: PrototypeRun | SquadRun | undefined): RoomPhaseStatus {
  if (!run) return 'waiting';
  if (run.status === 'completed') return 'completed';
  if (run.status === 'awaiting_approval') return 'review';
  if (run.status === 'failed' || run.status === 'cancelled') return 'failed';
  return run.status === 'running' || run.status === 'validating' ? 'running' : 'waiting';
}

function phaseStatusForCard(status: RoomCardStatus): RoomPhaseStatus {
  if (status === 'completed') return 'completed';
  if (status === 'running') return 'running';
  if (status === 'review') return 'review';
  if (status === 'failed') return 'failed';
  return 'waiting';
}

function cardStatus(run: any | undefined, squadRun: any | undefined, memberIndex: number): RoomCardStatus {
  if (!run) {
    return squadRun && memberIndex > (squadRun.currentMemberIndex ?? -1) ? 'waiting' : 'idle';
  }
  if (run.status === 'completed') return 'completed';
  if (run.status === 'awaiting_approval') return 'review';
  if (run.status === 'failed' || run.status === 'cancelled') return 'failed';
  if (squadRun && memberIndex !== squadRun.currentMemberIndex) return 'waiting';
  return run.status === 'queued' ? 'waiting' : 'running';
}

function currentTask(run: any | undefined, status: RoomCardStatus): string {
  if (status === 'completed') return 'Work completed';
  if (status === 'review') return 'Ready for review';
  if (status === 'failed') return 'Run stopped — review activity';
  if (status === 'waiting') return 'Waiting for squad handoff';
  if (status === 'idle') return 'Ready to run';
  return run?.stages?.[run.currentStageIndex]?.label || 'Execution in progress';
}

function squadProgress(
  squadRun: SquadRun | undefined,
  memberRunByAgent: ReadonlyMap<string, PrototypeRun>
): number {
  if (!squadRun) return 0;
  if (squadRun.status === 'awaiting_approval') return 100;
  if (!squadRun.memberAgentIds.length) return 0;
  return Math.round(
    squadRun.memberAgentIds.reduce(
      (sum, agentId) => sum + progressForRun(memberRunByAgent.get(agentId)),
      0
    ) / squadRun.memberAgentIds.length
  );
}

function stepDescription(
  step: ProjectBuildStep,
  agentsById: ReadonlyMap<string, Agent>,
  squadsById: ReadonlyMap<string, Squad>
): string {
  const owner = step.agentId
    ? agentsById.get(step.agentId)?.name ?? step.agentId
    : step.squadId
      ? squadsById.get(step.squadId)?.name ?? step.squadId
      : 'No execution owner assigned';
  return step.approvalGate ? `${owner} - approval required` : owner;
}

function phaseRows(
  steps: ProjectBuildStep[],
  selectedSquad: Squad,
  agentsById: ReadonlyMap<string, Agent>,
  squadsById: ReadonlyMap<string, Squad>,
  selectedRun: SquadRun | undefined,
  memberRunByAgent: ReadonlyMap<string, PrototypeRun>
): RoomPhase[] {
  const enabledSteps = steps
    .filter(step => step.enabled)
    .sort((a, b) => a.position - b.position);

  if (enabledSteps.length > 0) {
    return enabledSteps.map(step => {
      if (step.agentId) {
        const memberIndex = selectedSquad.memberAgentIds.indexOf(step.agentId);
        const run = memberRunByAgent.get(step.agentId);
        const status = phaseStatusForCard(cardStatus(run, selectedRun, memberIndex));
        return {
          id: step.id,
          label: step.label,
          description: stepDescription(step, agentsById, squadsById),
          status,
          progress: progressForRun(run)
        };
      }

      const run = step.squadId === selectedSquad.id ? selectedRun : undefined;
      return {
        id: step.id,
        label: step.label,
        description: stepDescription(step, agentsById, squadsById),
        status: phaseStatusForRun(run),
        progress: squadProgress(run, memberRunByAgent)
      };
    });
  }

  // Without an explicit project pipeline, show the project's real squad
  // membership rather than a generic requirements-to-release template.
  return selectedSquad.memberAgentIds.map((agentId, memberIndex) => {
    const agent = agentsById.get(agentId);
    const run = memberRunByAgent.get(agentId);
    const status = phaseStatusForCard(cardStatus(run, selectedRun, memberIndex));
    return {
      id: `squad-member-${agentId}`,
      label: agent?.name ?? agentId,
      description: agent?.role ?? 'Assigned squad member',
      status,
      progress: progressForRun(run)
    };
  });
}

/** Return only projects that can actually open a room for this caller. */
liveBuildRoomRouter.get('/live-build-room/projects', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const all = await projectStore().list(req.workspace!.workspaceId);
  const projects = workspaceRegistry.scopeProjects(all, req.workspace!);
  res.json(projects
    .filter(project => workspaceRegistry.canAccessLiveBuildRoom(req.workspace!, project.id))
    .map(project => ({
      id: project.id,
      key: project.key,
      name: project.name,
      color: project.color
    })));
}));

/**
 * Project-scoped execution room.
 *
 * The endpoint intentionally returns a complete room snapshot rather than
 * making the browser stitch together workspace, project, squad and run rows.
 * That keeps authorization in one place and prevents a client from combining
 * a permitted project with a squad or run from another project.
 */
liveBuildRoomRouter.get('/projects/:projectId/live-build-room', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
  if (!workspaceRegistry.canAccessLiveBuildRoom(req.workspace!, req.params.projectId)) {
    return res.status(404).json({ error: 'This project does not have an accessible squad.' });
  }

  const workspaceId = req.workspace!.workspaceId;
  const project = await projectStore().get(workspaceId, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  // Read once for the whole response: every squad below looks itself up in it.
  const [assignments, issues, projectBuildSteps] = await Promise.all([
    workspaceRegistry.listSquadProjectAssignments(workspaceId, project.id),
    issueStore().list(workspaceId),
    projectStore().getBuildSteps(workspaceId, project.id)
  ]);
  const projectSquadIds = new Set(workspaceRegistry.listProjectSquadIds(req.workspace!, project.id));
  const squads = workspaceRegistry
    .scopeSquads(await squadStore().list(workspaceId), req.workspace!)
    .filter(squad => projectSquadIds.has(squad.id))
    .map(squad => ({
      ...squad,
      ownerId: workspaceRegistry.squadOwnerId(req.workspace!, squad.id),
      assignment: assignments.find(
        assignment => assignment.squadId === squad.id && assignment.status === 'active'
      )
    }));

  const squadRuns = (await runStore().listSquadRuns(workspaceId))
    .filter(run => run.projectId === project.id && projectSquadIds.has(run.squadId))
    .filter(run => workspaceRegistry.canAccessSquad(req.workspace!, run.squadId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const squadRun = squadRuns[0];
  const selectedSquad = squads.find(squad => squad.id === squadRun?.squadId) ?? squads[0];
  if (!selectedSquad) return res.status(404).json({ error: 'This project does not have an accessible squad.' });

  const selectedRun = squadRun && squadRun.squadId === selectedSquad.id ? squadRun : undefined;
  const memberRuns = selectedRun
    ? (await runStore().runsForSquadRun(workspaceId, selectedRun.id))
      .filter(run => run.projectId === project.id)
      .sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0))
    : [];
  const membersById = new Map((await agentStore().list(workspaceId)).map(agent => [agent.id, agent]));
  const squadsById = new Map(squads.map(squad => [squad.id, squad]));
  const memberRunByAgent = new Map(memberRuns.map(run => [run.agentId, run]));

  const agentCards = selectedSquad.memberAgentIds.map((agentId, memberIndex) => {
    const agent = membersById.get(agentId);
    const run = memberRunByAgent.get(agentId);
    const status = cardStatus(run, selectedRun, memberIndex);
    return {
      agentId,
      agentName: agent?.name ?? agentId,
      agentRole: agent?.role ?? 'Agent',
      avatar: agent?.avatar,
      color: agent?.color,
      status,
      progress: progressForRun(run),
      currentTask: currentTask(run, status),
      currentStage: run?.stages?.[run.currentStageIndex]?.label,
      runId: run?.id,
      activity: (run?.activities ?? []).slice(-5),
      updatedAt: run?.updatedAt ?? selectedRun?.updatedAt ?? null,
      output: run?.prUrl
        ? { kind: 'pull_request', label: 'Pull request', value: run.prUrl }
        : run?.branchName
          ? { kind: 'branch', label: 'Working branch', value: run.branchName }
          : undefined
    };
  });

  const currentMemberIndex = selectedRun?.currentMemberIndex ?? -1;
  const currentAgentId = selectedRun?.memberAgentIds?.[currentMemberIndex];
  const currentRun = currentAgentId ? memberRunByAgent.get(currentAgentId) : undefined;
  const previousAgentId = currentMemberIndex > 0 ? selectedRun?.memberAgentIds?.[currentMemberIndex - 1] : undefined;
  const nextAgentId = selectedRun?.memberAgentIds?.[currentMemberIndex + 1];
  const agentName = (id?: string) => id ? membersById.get(id)?.name ?? id : undefined;

  const artifacts = memberRuns.flatMap(run => {
    const agent = membersById.get(run.agentId);
    const rows: Array<Record<string, unknown>> = [];
    if (run.changedFiles) {
      rows.push({
        id: `${run.id}-changes`,
        name: `${agent?.name ?? 'Agent'} changes`,
        kind: 'changes',
        detail: `${run.changedFiles} file${run.changedFiles === 1 ? '' : 's'} changed`,
        status: run.status === 'completed' ? 'ready' : 'in_progress',
        runId: run.id
      });
    }
    if (run.prUrl) {
      rows.push({
        id: `${run.id}-pr`,
        name: 'Pull request',
        kind: 'pull_request',
        detail: run.prUrl,
        status: 'ready',
        runId: run.id
      });
    }
    return rows;
  });

  const completed = agentCards.filter(card => card.status === 'completed').length;
  const running = agentCards.filter(card => card.status === 'running').length;
  const waiting = agentCards.filter(card => card.status === 'waiting' || card.status === 'idle').length;
  res.json({
    project: {
      id: project.id,
      name: project.name,
      key: project.key,
      description: project.description,
      color: project.color,
      status: project.status
    },
    squad: {
      ...selectedSquad,
      ownerId: workspaceRegistry.squadOwnerId(req.workspace!, selectedSquad.id),
      projectIds: Array.from(projectSquadIds),
      memberCount: selectedSquad.memberAgentIds.length
    },
    squads,
    eligible: true,
    canRun: workspaceRegistry.can(req.workspace!.role, 'squad.run'),
    canManage: workspaceRegistry.can(req.workspace!.role, 'squad.manage'),
    status: selectedRun?.status ?? 'idle',
    summary: {
      totalAgents: agentCards.length,
      completed,
      running,
      waiting,
      progress: agentCards.length ? Math.round(agentCards.reduce((sum, card) => sum + card.progress, 0) / agentCards.length) : 0
    },
    phases: phaseRows(
      projectBuildSteps ?? [],
      selectedSquad,
      membersById,
      squadsById,
      selectedRun,
      memberRunByAgent
    ),
    issue: selectedRun
      ? issues.find(issue => issue.id === selectedRun.issueId)
      : issues.find(issue => issue.projectId === project.id && issue.assignedSquadId === selectedSquad.id),
    activeRun: selectedRun ? {
      ...selectedRun,
      memberRuns,
      activities: currentRun?.activities ?? []
    } : null,
    agentCards,
    activity: currentRun?.activities ?? [],
    handoff: {
      from: agentName(previousAgentId) ?? 'Project brief',
      to: agentName(currentAgentId) ?? agentName(selectedSquad.memberAgentIds[0]) ?? 'Squad',
      current: agentName(currentAgentId),
      next: agentName(nextAgentId)
    },
    artifacts,
    lastUpdated: selectedRun?.updatedAt ?? project.createdAt
  });
}));
