import type { WorkspaceContext } from './workspaceRegistry.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { OrchestrationPlanner, OrchestrationPlanningError, type OrchestrationPlanningInput } from './orchestrationPlanner.js';
import { repositoryPlanningContext } from './projectBuildOrchestrator.js';
import { plannableAgents, plannerIdentity, readyProjectAgents, selectPlanner } from './planningAgents.js';
import { getCurrentBranch, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { readMemoryAtCommit, renderProjectMemory } from './repositoryMemory.js';
import type { OrchestrationPlan } from './orchestrationContract.js';
import type { OrchestrationRepositoryWorkspace, OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { planRepositoryCoverage } from './orchestrationWorkspace.js';
import { describePlanChanges } from './orchestrationPlanChanges.js';
import { readAgentProductPicture } from './productPictureSource.js';
import { fitCheckCards } from './planFitCheck.js';

/** A saved plan the Orchestrator may plan again: unstarted, unchanged since it was opened. */
function unstartedSnapshot(runId: string, revision: number): OrchestrationSnapshot {
  const snapshot = sqliteService.getOrchestrationSnapshot(runId);
  if (!snapshot || snapshot.run.revision !== revision || snapshot.run.status !== 'awaiting_plan_approval' || snapshot.attempts.length) {
    throw new Error('Only an unchanged, unstarted plan can be revised.');
  }
  return snapshot;
}

async function assertCheckpoints(roots: readonly OrchestrationRepositoryWorkspace[], during: boolean): Promise<void> {
  for (const root of roots) {
    const moved = (!during && await getCurrentBranch(root.worktreePath) !== root.branchName) ||
      await getHeadCommit(root.worktreePath) !== root.baseCommit || !await isGitWorkingTreeClean(root.worktreePath);
    if (moved) {
      throw new Error(during ? 'The planning checkpoint changed during revision. The original plan is preserved.'
        : 'The planning checkpoint changed. Review the saved workspace before revising.');
    }
  }
}

/**
 * Everything the Orchestrator needs to plan again inside a saved, unstarted build, built one way
 * from the run: its checkouts, memory, ready agents, and which codebases may stay without tasks.
 * Revising a plan and correcting one at start both use it, so they plan under the same rules the
 * plan was first made under.
 */
async function unstartedPlanningInput(context: WorkspaceContext, snapshot: OrchestrationSnapshot, goal: string): Promise<OrchestrationPlanningInput> {
  const roots = snapshot.run.repositoryWorkspaces ?? [];
  if (!roots.length) throw new Error('The saved planning workspaces are unavailable.');
  await assertCheckpoints(roots, false);
  const runtimes = sqliteService.getRuntimes();
  const eligible = await readyProjectAgents({ agents: sqliteService.getAgents(), runtimes, context, projectId: snapshot.run.projectId });
  const planner = selectPlanner(eligible, runtimes);
  if (!planner) throw new Error('No authorized planning agent with an available model is ready.');
  const optional = new Set(planRepositoryCoverage(snapshot.run).optionalRepositories.map(item => item.toLowerCase()));
  const contexts = roots.map(root => ({ ...root, context: repositoryPlanningContext(root.worktreePath) }));
  const project = sqliteService.getProjects().find(item => item.id === snapshot.run.projectId);
  return { runId: snapshot.run.id, cwd: roots[0].worktreePath, goal,
    exclusions: snapshot.run.plan.exclusions, approvedRequirements: snapshot.run.plan.requirements,
    // A revision keeps the saved project context (it used to be dropped) and reads the same memory.
    projectContext: snapshot.run.plan.projectContext,
    // The product as recorded now, not when the plan was first made; and the same cards to check again.
    ...readAgentProductPicture(project, snapshot.run.plan.projectContext),
    buildsCards: fitCheckCards(snapshot.run.plan),
    repositoryMemory: renderProjectMemory(await Promise.all(roots.map(root => readMemoryAtCommit(root.repository, root.worktreePath, root.baseCommit)))),
    repositoryContext: contexts[0].context.context, availableScripts: contexts[0].context.scripts,
    repositories: contexts.map(item => ({ repository: item.repository, repositoryContext: item.context.context, availableScripts: item.context.scripts,
      ...(optional.has(item.repository.toLowerCase()) ? { optional: true } : {}) })),
    repositoryRoots: roots.map(item => ({ name: item.repository, repo: item.repository, dir: item.worktreePath })), branchContext: roots,
    eligibleAgents: plannableAgents(eligible),
    planner: plannerIdentity(planner, runtimes)
  };
}

export async function reviseBoardPlan(context: WorkspaceContext, runId: string, revision: number, instruction: string, planner = new OrchestrationPlanner()) {
  return runWithWorkspace(context.workspaceId, async () => {
    const snapshot = unstartedSnapshot(runId, revision);
    const input = await unstartedPlanningInput(context, snapshot,
      snapshot.run.plan.goal + '\nPlan revision requested by the developer (within the same requirements):\n' + instruction);
    const planned = await planner.createPlan(input);
    // The requested planning instruction does not replace the approved product goal.
    planned.plan.goal = snapshot.run.plan.goal;
    await assertCheckpoints(snapshot.run.repositoryWorkspaces ?? [], true);
    return sqliteService.replaceUnstartedPlan({ runId, expectedRevision: revision, plan: planned.plan, actorId: context.userId, reason: instruction });
  });
}

export interface StartCorrection {
  snapshot: OrchestrationSnapshot;
  /** What the saved plan failed, in the check's words. */
  reason: string;
  /** What the correction changed, one short line each. */
  changes: string[];
}

/**
 * A saved plan that failed its start check goes back to the Orchestrator once. The corrected plan
 * is saved as the next version and waits for the person to start it: their approval always covers
 * the exact plan that runs. Throws the planner's error, with both plans, when the correction fails.
 */
export async function correctPlanBeforeStart(context: WorkspaceContext, runId: string, issues: readonly { detail: string }[],
  planner = new OrchestrationPlanner()): Promise<StartCorrection> {
  return runWithWorkspace(context.workspaceId, async () => {
    const latest = sqliteService.getOrchestrationSnapshot(runId);
    const snapshot = unstartedSnapshot(runId, latest?.run.revision ?? -1);
    const reason = issues.map(issue => issue.detail).join(' ');
    const input = await unstartedPlanningInput(context, snapshot, snapshot.run.plan.goal);
    const corrected: OrchestrationPlan = await planner.correctPlan(input, snapshot.run.plan, new OrchestrationPlanningError(reason, 'invalid_plan'));
    corrected.goal = snapshot.run.plan.goal;
    await assertCheckpoints(snapshot.run.repositoryWorkspaces ?? [], true);
    const saved = sqliteService.replaceUnstartedPlan({ runId, expectedRevision: snapshot.run.revision, plan: corrected, actorId: context.userId,
      reason: `The Orchestrator corrected the plan before it could start: ${reason}` });
    return { snapshot: saved, reason, changes: describePlanChanges(snapshot.run.plan, corrected) };
  });
}
