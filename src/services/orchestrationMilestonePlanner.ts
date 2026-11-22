import { sameRepository } from '../utils/repositoryName.js';
import { createHash } from 'node:crypto';
import type { SQLiteService } from './sqliteService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import { plannableAgents, plannerIdentity, readyProjectAgents, selectPlanner } from './planningAgents.js';
import { type OrchestrationPlan, type OrchestrationTaskDefinition } from './orchestrationContract.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { plannerModelName, repositoryPlanningContext } from './projectBuildOrchestrator.js';
import { getGitChangedPaths, getGitFileAtCommit, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { readMemoryAtCommit, renderProjectMemory } from './repositoryMemory.js';
import { planRepositoryCoverage } from './orchestrationWorkspace.js';

export type Milestone = NonNullable<OrchestrationPlan['milestones']>[number];
export type MilestoneExpansion = { tasks: OrchestrationTaskDefinition[]; checkpoints: Array<{ repository: string; commit: string }> };
/** `refused`: why the build's checks refused this milestone's last tasks, for the Orchestrator's one correction. */
export type PlanNextMilestone = (snapshot: OrchestrationSnapshot, milestone: Milestone, refused?: string) => Promise<MilestoneExpansion>;

/** Up to 10,000 characters of accepted source the milestone changed, skipping secrets and lockfiles. */
async function acceptedSource(dir: string, commit: string, changed: readonly string[]): Promise<Array<{ path: string; content: string }>> {
  const source = [];
  let remaining = 10_000;
  for (const file of changed.filter(file => /\.(?:[cm]?[jt]sx?|json|sql|prisma|py|go|md)$/.test(file) && !/(?:^|\/)(?:\.env|secrets?|credentials?|[^/]*lock\.)/i.test(file)).slice(0, 20)) {
    if (remaining < 512) break;
    const content = await getGitFileAtCommit(dir, commit, file, Math.min(remaining, 6_000)).catch(() => undefined);
    if (content) { source.push({ path: file, content }); remaining -= content.length; }
  }
  return source;
}

/** One codebase at its accepted checkpoint: the commit, what changed since the build began, and its planning context. */
async function workspaceEvidence(snapshot: OrchestrationSnapshot, workspace: { repository: string; worktreePath: string; baseCommit: string }) {
  const { run } = snapshot;
  if (!workspace.worktreePath || !await isGitWorkingTreeClean(workspace.worktreePath)) throw new Error(`Repository ${workspace.repository} must have a clean checkpoint before milestone planning.`);
  const commit = await getHeadCommit(workspace.worktreePath);
  const latestAccepted = [...snapshot.attempts].reverse().find(attempt => attempt.status === 'accepted' &&
    snapshot.tasks.some(task => task.id === attempt.taskId && sameRepository((task.repository ?? run.repository), workspace.repository)));
  if (commit !== (latestAccepted?.resultCommit ?? workspace.baseCommit)) throw new Error(`Repository ${workspace.repository} no longer matches its accepted checkpoint.`);
  const overview = repositoryPlanningContext(workspace.worktreePath);
  const changed = await getGitChangedPaths(workspace.worktreePath, workspace.baseCommit, commit);
  const source = await acceptedSource(workspace.worktreePath, commit, changed);
  return {
    commit,
    evidence: { repository: workspace.repository, commit, changedPaths: changed.slice(0, 120), source },
    planning: { repository: workspace.repository, repositoryContext: overview.context, availableScripts: overview.scripts, hasAcceptedWork: Boolean(latestAccepted) }
  };
}

/** Source and access unchanged while the model was thinking. Never activate a stale expansion. */
async function assertStillCurrent(snapshot: OrchestrationSnapshot, workspaces: ReadonlyArray<{ worktreePath: string }>,
  checkpoints: ReadonlyArray<{ commit: string }>, tasks: ReadonlyArray<{ ownerAgentId: string }>): Promise<void> {
  const { run } = snapshot;
  for (const [index, workspace] of workspaces.entries()) {
    if (!await isGitWorkingTreeClean(workspace.worktreePath) || await getHeadCommit(workspace.worktreePath) !== checkpoints[index].commit) throw new Error('The repository checkpoint changed during milestone planning.');
  }
  const refreshed = await workspaceRegistry.resolve(run.createdBy, run.workspaceId);
  if (!refreshed || !workspaceRegistry.can(refreshed.role, 'squad.run') || !workspaceRegistry.canAccessProjectBuilds(refreshed, run.projectId)) throw new Error('Project execution access changed during milestone planning.');
  for (const task of tasks) {
    if (!await workspaceRegistry.canAccessProjectAgentRun(refreshed, run.projectId, task.ownerAgentId)) throw new Error('A planned specialist is no longer authorized for this project.');
  }
}

/** The goal for planning a milestone; on a second try it carries why the checks refused the first. */
function milestoneGoal(goal: string, refused?: string): string {
  return refused ? `${goal}\nThe build's checks refused the tasks last planned for this milestone: ${refused}\nPlan this milestone's tasks again so they pass.` : goal;
}

/** New planning uses fresh access, ready agents and immutable accepted source, never an old chat transcript. */
export function milestonePlanner(store: SQLiteService, planner = new OrchestrationPlanner()): PlanNextMilestone {
  return async (snapshot, milestone, refused) => {
    const { run } = snapshot;
    const context = await workspaceRegistry.resolve(run.createdBy, run.workspaceId);
    if (!context || !workspaceRegistry.can(context.role, 'squad.run') || !workspaceRegistry.canAccessProjectBuilds(context, run.projectId)) throw new Error('Project execution access is no longer available.');
    const project = store.getProjects().find(item => item.id === run.projectId);
    if (!project) throw new Error('The milestone project is unavailable.');
    const runtimes = store.getRuntimes();
    const eligible = await readyProjectAgents({ agents: store.getAgents(), runtimes, context, projectId: run.projectId, projectKey: project.key });
    const identity = selectPlanner(eligible, runtimes);
    if (!identity) throw new Error('No authorized planning agent with an available model is ready.');
    const workspaces = run.repositoryWorkspaces?.length ? run.repositoryWorkspaces : [{ repository: run.repository, worktreePath: run.worktreePath!, baseCommit: run.baseCommit! }];
    const runOptional = new Set(planRepositoryCoverage(run).optionalRepositories.map(item => item.toLowerCase()));
    const checkpoints = [];
    const evidence = [];
    const repositories = [];
    for (const workspace of workspaces) {
      const read = await workspaceEvidence(snapshot, workspace);
      checkpoints.push({ repository: workspace.repository, commit: read.commit });
      evidence.push(read.evidence);
      // A repository finished in an earlier milestone may still be listed here (a requirement can
      // span both sides); it gets a task only if this milestone needs changes there.
      if (milestone.repositories.some(repo => sameRepository(repo, workspace.repository))) repositories.push({
        ...read.planning,
        // Optional for the whole build stays optional in each milestone (read from the run, as every check does).
        ...(runOptional.has(workspace.repository.toLowerCase()) ? { optional: true } : {})
      });
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
      goal: milestoneGoal(run.plan.goal, refused),
      milestoneContext: { id: milestone.id, title: milestone.title, objective: milestone.objective },
      acceptedEvidence,
      projectContext: run.plan.projectContext, exclusions: run.plan.exclusions,
      // Repository memory as committed at the checkpoints this milestone plans from.
      repositoryMemory: renderProjectMemory(await Promise.all(checkpoints.map(item => {
        const dir = workspaces.find(workspace => workspace.repository === item.repository)!.worktreePath;
        return readMemoryAtCommit(item.repository, dir, item.commit);
      }))),
      approvedRequirements: requirements, repositoryContext: repositories[0]?.repositoryContext ?? '',
      availableScripts: repositories[0]?.availableScripts ?? [], repositories,
      eligibleAgents: plannableAgents(eligible),
      planner: plannerIdentity(identity, runtimes)
    });
    await assertStillCurrent(snapshot, workspaces, checkpoints, result.plan.tasks);
    const ids = new Map(result.plan.tasks.map(task => [task.id, `m${(run.plan.milestones?.findIndex(item => item.id === milestone.id) ?? -1) + 1}-${createHash('sha256').update(task.id).digest('hex').slice(0, 16)}`]));
    return { checkpoints, tasks: result.plan.tasks.map(task => ({ ...task, id: ids.get(task.id)!, milestoneId: milestone.id, dependsOn: task.dependsOn.map(id => ids.get(id)!) })) };
  };
}
