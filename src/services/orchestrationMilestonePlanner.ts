import { roleCanPlan } from './agentRoleContracts.js';
import { createHash } from 'node:crypto';
import type { SQLiteService } from './sqliteService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import { type OrchestrationPlan, type OrchestrationTaskDefinition } from './orchestrationContract.js';
import { agentReadiness } from './agentReadiness.js';
import { resolveAgent } from './personaService.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { plannerModelName, repositoryPlanningContext } from './projectBuildOrchestrator.js';
import { getGitChangedPaths, getGitFileAtCommit, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';

export type Milestone = NonNullable<OrchestrationPlan['milestones']>[number];
export type MilestoneExpansion = { tasks: OrchestrationTaskDefinition[]; checkpoints: Array<{ repository: string; commit: string }> };
export type PlanNextMilestone = (snapshot: OrchestrationSnapshot, milestone: Milestone) => Promise<MilestoneExpansion>;

/** New planning uses fresh access, ready agents and immutable accepted source, never an old chat transcript. */
export function milestonePlanner(store: SQLiteService, planner = new OrchestrationPlanner()): PlanNextMilestone {
  return async (snapshot, milestone) => {
    const { run } = snapshot;
    const context = await workspaceRegistry.resolve(run.createdBy, run.workspaceId);
    if (!context || !workspaceRegistry.can(context.role, 'squad.run') || !workspaceRegistry.canAccessLiveBuildRoom(context, run.projectId)) throw new Error('Project execution access is no longer available.');
    const project = store.getProjects().find(item => item.id === run.projectId);
    if (!project) throw new Error('The milestone project is unavailable.');
    const runtimes = store.getRuntimes();
    const eligible = [];
    for (const agent of store.getAgents()) {
      if (agent.isArchived || agentReadiness(agent, runtimes).status !== 'ready' || !await workspaceRegistry.canAccessProjectAgentRun(context, run.projectId, agent.id)) continue;
      eligible.push({ agent, persona: resolveAgent(agent, { projectKey: project.key, includeMemory: false, includeToolPolicy: false }) });
    }
    const candidates = eligible.filter(item => roleCanPlan(item.persona.role) && plannerModelName(item.persona.modelProvider, item.persona.modelName, runtimes));
    const identity = candidates.find(item => item.persona.role.toLowerCase() === 'orchestrator agent') ?? candidates[0];
    if (!identity) throw new Error('No authorized planning agent with an available model is ready.');
    const workspaces = run.repositoryWorkspaces?.length ? run.repositoryWorkspaces : [{ repository: run.repository, worktreePath: run.worktreePath!, baseCommit: run.baseCommit! }];
    const checkpoints = [];
    const evidence = [];
    const repositories = [];
    for (const workspace of workspaces) {
      if (!workspace.worktreePath || !await isGitWorkingTreeClean(workspace.worktreePath)) throw new Error(`Repository ${workspace.repository} must have a clean checkpoint before milestone planning.`);
      const commit = await getHeadCommit(workspace.worktreePath);
      const latestAccepted = [...snapshot.attempts].reverse().find(attempt => attempt.status === 'accepted' &&
        snapshot.tasks.some(task => task.id === attempt.taskId && (task.repository ?? run.repository).toLowerCase() === workspace.repository.toLowerCase()));
      if (commit !== (latestAccepted?.resultCommit ?? workspace.baseCommit)) throw new Error(`Repository ${workspace.repository} no longer matches its accepted checkpoint.`);
      checkpoints.push({ repository: workspace.repository, commit });
      const overview = repositoryPlanningContext(workspace.worktreePath);
      const changed = await getGitChangedPaths(workspace.worktreePath, workspace.baseCommit, commit);
      const source = [];
      let remaining = 10_000;
      for (const file of changed.filter(file => /\.(?:[cm]?[jt]sx?|json|sql|prisma|py|go|md)$/.test(file) && !/(?:^|\/)(?:\.env|secrets?|credentials?|[^/]*lock\.)/i.test(file)).slice(0, 20)) {
        if (remaining < 512) break;
        const content = await getGitFileAtCommit(workspace.worktreePath, commit, file, Math.min(remaining, 6_000)).catch(() => undefined);
        if (content) { source.push({ path: file, content }); remaining -= content.length; }
      }
      evidence.push({ repository: workspace.repository, commit, changedPaths: changed.slice(0, 120), source });
      if (milestone.repositories.some(repo => repo.toLowerCase() === workspace.repository.toLowerCase())) repositories.push({ repository: workspace.repository, repositoryContext: overview.context, availableScripts: overview.scripts });
    }
    const requirements = run.plan.requirements.filter(item => milestone.requirementIds.includes(item.id));
    const acceptedReports = snapshot.attempts.filter(attempt => attempt.status === 'accepted').slice(-12).map(attempt => ({
      taskId: attempt.taskId, resultCommit: attempt.resultCommit,
      dependencyAudits: attempt.result?.acceptanceEvidence && (attempt.result.acceptanceEvidence as Record<string, unknown>).dependencyAudits,
      summary: typeof attempt.result?.summary === 'string' ? attempt.result.summary.slice(0, 2_000) : '',
      report: attempt.result?.agentReport ? JSON.stringify(attempt.result.agentReport).slice(0, 2_000) : undefined
    }));
    const acceptedEvidence = JSON.stringify({ repositories: evidence, acceptedReports });
    if (acceptedEvidence.length > 32_000) throw new Error('Accepted source and audit evidence exceed the planning context. Narrow the milestone scope before planning; findings were preserved.');
    const result = await planner.createPlan({
      usageContext: { orchestrationRunId: run.id, threadId: run.originChatThreadId, messageId: run.originBuildMessageId?.replace(/-build$/, '') },
      runId: `${run.id}-milestone-${run.planVersion + 1}`, cwd: workspaces[0].worktreePath,
      repositoryRoots: workspaces.map(workspace => ({ name: workspace.repository, repo: workspace.repository, dir: workspace.worktreePath })),
      goal: run.plan.goal,
      milestoneContext: { id: milestone.id, title: milestone.title, objective: milestone.objective },
      acceptedEvidence,
      projectContext: run.plan.projectContext, exclusions: run.plan.exclusions,
      approvedRequirements: requirements, repositoryContext: repositories[0]?.repositoryContext ?? '',
      availableScripts: repositories[0]?.availableScripts ?? [], repositories,
      eligibleAgents: eligible.map(({ agent, persona }) => ({ id: agent.id, role: persona.role, name: persona.name, description: (agent.description ?? '').slice(0, 240), ready: true, official: Boolean(agent.templateKey) })),
      planner: { id: identity.agent.id, name: identity.persona.name, role: identity.persona.role, provider: identity.persona.modelProvider,
        modelName: plannerModelName(identity.persona.modelProvider, identity.persona.modelName, runtimes), systemPrompt: identity.persona.systemPrompt, reasoningEffort: identity.persona.reasoningEffort }
    });
    // Detect source changes while the model was thinking. Never activate a stale expansion.
    for (const [index, workspace] of workspaces.entries()) if (!await isGitWorkingTreeClean(workspace.worktreePath) || await getHeadCommit(workspace.worktreePath) !== checkpoints[index].commit) throw new Error('The repository checkpoint changed during milestone planning.');
    const refreshed = await workspaceRegistry.resolve(run.createdBy, run.workspaceId);
    if (!refreshed || !workspaceRegistry.can(refreshed.role, 'squad.run') || !workspaceRegistry.canAccessLiveBuildRoom(refreshed, run.projectId)) throw new Error('Project execution access changed during milestone planning.');
    for (const task of result.plan.tasks) if (!await workspaceRegistry.canAccessProjectAgentRun(refreshed, run.projectId, task.ownerAgentId)) throw new Error('A planned specialist is no longer authorized for this project.');
    const ids = new Map(result.plan.tasks.map(task => [task.id, `m${(run.plan.milestones?.findIndex(item => item.id === milestone.id) ?? -1) + 1}-${createHash('sha256').update(task.id).digest('hex').slice(0, 16)}`]));
    return { checkpoints, tasks: result.plan.tasks.map(task => ({ ...task, id: ids.get(task.id)!, milestoneId: milestone.id, dependsOn: task.dependsOn.map(id => ids.get(id)!) })) };
  };
}
