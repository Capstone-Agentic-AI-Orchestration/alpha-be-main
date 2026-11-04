import type { WorkspaceContext } from './workspaceRegistry.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { agentReadiness } from './agentReadiness.js';
import { roleCanPlan } from './agentRoleContracts.js';
import { resolveAgent } from './personaService.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import { plannerModelName, repositoryPlanningContext } from './projectBuildOrchestrator.js';
import { getCurrentBranch, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';

export async function reviseBoardPlan(context: WorkspaceContext, runId: string, revision: number, instruction: string) {
  return runWithWorkspace(context.workspaceId, async () => {
    const snapshot = sqliteService.getOrchestrationSnapshot(runId);
    if (!snapshot || snapshot.run.revision !== revision || snapshot.run.status !== 'awaiting_plan_approval' || snapshot.attempts.length) {
      throw new Error('Only an unchanged, unstarted plan can be revised.');
    }
    const roots = snapshot.run.repositoryWorkspaces ?? [];
    if (!roots.length) throw new Error('The saved planning workspaces are unavailable.');
    for (const root of roots) {
      if (await getCurrentBranch(root.worktreePath) !== root.branchName || await getHeadCommit(root.worktreePath) !== root.baseCommit || !await isGitWorkingTreeClean(root.worktreePath)) {
        throw new Error('The planning checkpoint changed. Review the saved workspace before revising.');
      }
    }
    const visible = [];
    for (const agent of sqliteService.getAgents().filter(item => !item.isArchived)) {
      if (agentReadiness(agent, sqliteService.getRuntimes()).status === 'ready' && await workspaceRegistry.canAccessProjectAgentRun(context, snapshot.run.projectId, agent.id)) visible.push(agent);
    }
    const agent = visible.find(item => item.role === 'Orchestrator Agent') ?? visible.find(item => roleCanPlan(item.role));
    if (!agent) throw new Error('No authorized planning agent is ready.');
    const persona = resolveAgent(agent, { includeMemory: false, includeToolPolicy: false });
    const contexts = roots.map(root => ({ ...root, context: repositoryPlanningContext(root.worktreePath) }));
    const planned = await new OrchestrationPlanner().createPlan({ runId, cwd: roots[0].worktreePath,
      goal: snapshot.run.plan.goal + '\nPlan revision requested by the developer (within the same requirements):\n' + instruction,
      exclusions: snapshot.run.plan.exclusions, approvedRequirements: snapshot.run.plan.requirements,
      repositoryContext: contexts[0].context.context, availableScripts: contexts[0].context.scripts,
      repositories: contexts.map(item => ({ repository: item.repository, repositoryContext: item.context.context, availableScripts: item.context.scripts })),
      repositoryRoots: roots.map(item => ({ name: item.repository, repo: item.repository, dir: item.worktreePath })), branchContext: roots,
      eligibleAgents: visible.map(item => ({ id: item.id, role: item.role, name: item.name, ready: true })),
      planner: { id: agent.id, name: persona.name, role: persona.role, provider: persona.modelProvider,
        modelName: plannerModelName(persona.modelProvider, persona.modelName, sqliteService.getRuntimes()), systemPrompt: persona.systemPrompt }
    });
    // The requested planning instruction does not replace the approved product goal.
    planned.plan.goal = snapshot.run.plan.goal;
    for (const root of roots) {
      if (await getHeadCommit(root.worktreePath) !== root.baseCommit || !await isGitWorkingTreeClean(root.worktreePath)) throw new Error('The planning checkpoint changed during revision. The original plan is preserved.');
    }
    return sqliteService.replaceUnstartedPlan({ runId, expectedRevision: revision, plan: planned.plan, actorId: context.userId, reason: instruction });
  });
}
