import { Request, Response, Router } from 'express';
import { route } from './asyncRoute.js';
import { sqliteService } from '../services/sqliteService.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import {
  requireProjectWorkspace,
  requireWorkspaceCapability
} from './workspaceContext.js';

export const liveBuildRoomRouter = Router();

type RoomCardStatus = 'completed' | 'running' | 'waiting' | 'review' | 'failed' | 'idle';

function progressForRun(run: any | undefined): number {
  if (!run) return 0;
  if (run.status === 'completed') return 100;
  if (!Array.isArray(run.stages) || run.stages.length === 0) return run.status === 'running' ? 50 : 0;
  const complete = run.stages.filter((stage: any) => stage.status === 'success').length;
  const active = run.stages.some((stage: any) => stage.status === 'running') ? 0.5 : 0;
  return Math.min(100, Math.round(((complete + active) / run.stages.length) * 100));
}

function phaseStatus(status: string): 'completed' | 'running' | 'waiting' | 'failed' {
  if (status === 'success') return 'completed';
  if (status === 'running') return 'running';
  if (status === 'failed' || status === 'cancelled') return 'failed';
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
  return run?.stages?.[run.currentStageIndex]?.label || 'Preparing workspace';
}

function phaseRows(run: any | undefined) {
  if (run?.stages?.length) {
    return run.stages.map((stage: any) => ({
      id: stage.id,
      label: stage.label,
      description: stage.description,
      status: phaseStatus(stage.status),
      progress: stage.status === 'success' ? 100 : stage.status === 'running' ? 64 : 0
    }));
  }
  return [
    { id: 'requirements', label: 'Requirements', description: 'Project context and acceptance criteria', status: 'waiting', progress: 0 },
    { id: 'architecture', label: 'Architecture', description: 'Plan and boundaries', status: 'waiting', progress: 0 },
    { id: 'build', label: 'Build', description: 'Implementation in the project workspace', status: 'waiting', progress: 0 },
    { id: 'review', label: 'Review', description: 'Verification and review handoff', status: 'waiting', progress: 0 },
    { id: 'release', label: 'Release', description: 'Delivery handoff', status: 'waiting', progress: 0 }
  ];
}

/** Return only projects that can actually open a room for this caller. */
liveBuildRoomRouter.get('/live-build-room/projects', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const projects = workspaceRegistry.scopeProjects(sqliteService.getProjects(), req.workspace!);
  res.json(projects
    .filter(project => workspaceRegistry.canAccessLiveBuildRoom(req.workspace!, project.id))
    .map(project => ({
      id: project.id,
      key: project.key,
      name: project.name,
      color: project.color
    })));
});

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
  const project = sqliteService.getProjects().find(item => item.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  // Read once for the whole response: every squad below looks itself up in it.
  const assignments = await workspaceRegistry.listSquadProjectAssignments(workspaceId, project.id);
  const projectSquadIds = new Set(workspaceRegistry.listProjectSquadIds(req.workspace!, project.id));
  const squads = workspaceRegistry
    .scopeSquads(sqliteService.getSquads(), req.workspace!)
    .filter(squad => projectSquadIds.has(squad.id))
    .map(squad => ({
      ...squad,
      ownerId: workspaceRegistry.squadOwnerId(req.workspace!, squad.id),
      assignment: assignments.find(
        assignment => assignment.squadId === squad.id && assignment.status === 'active'
      )
    }));

  const squadRuns = workspaceRegistry
    .scope('squad_runs', sqliteService.getSquadRuns(), workspaceId)
    .filter(run => run.projectId === project.id && projectSquadIds.has(run.squadId))
    .filter(run => workspaceRegistry.canAccessSquad(req.workspace!, run.squadId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const squadRun = squadRuns[0];
  const selectedSquad = squads.find(squad => squad.id === squadRun?.squadId) ?? squads[0];
  if (!selectedSquad) return res.status(404).json({ error: 'This project does not have an accessible squad.' });

  const selectedRun = squadRun && squadRun.squadId === selectedSquad.id ? squadRun : undefined;
  const memberRuns = selectedRun
    ? sqliteService.getRunsForSquadRun(selectedRun.id)
      .filter(run => run.projectId === project.id)
      .sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0))
    : [];
  const membersById = new Map(sqliteService.getAgents().map(agent => [agent.id, agent]));
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
    phases: phaseRows(currentRun),
    issue: selectedRun
      ? sqliteService.getIssues().find(issue => issue.id === selectedRun.issueId)
      : sqliteService.getIssues().find(issue => issue.projectId === project.id && issue.assignedSquadId === selectedSquad.id),
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
