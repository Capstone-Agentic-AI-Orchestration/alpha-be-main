import type { Agent, RuntimeEngine as Runtime } from '../models/index.js';
import { agentReadiness } from './agentReadiness.js';
import { roleCanPlan } from './agentRoleContracts.js';
import { resolveAgent } from './personaService.js';
import { plannerModelName } from './projectBuildOrchestrator.js';
import { workspaceRegistry, type WorkspaceContext } from './workspaceRegistry.js';

/**
 * Who may plan and who may be planned for, decided one way for every planning path (a new
 * build, a revised plan, a plan corrected before start, the next milestone). They used to
 * differ: one path used the stored role and skipped readiness, so a plan could pass and then
 * fail at dispatch, which checks the persona role and readiness.
 */
export interface PlanningAgent { agent: Agent; persona: ReturnType<typeof resolveAgent> }

/** Agents that are ready and may run in this project, with the role their persona gives them. */
export async function readyProjectAgents(input: { agents: Agent[]; runtimes: Runtime[]; context: WorkspaceContext; projectId: string; projectKey?: string }): Promise<PlanningAgent[]> {
  const eligible: PlanningAgent[] = [];
  for (const agent of input.agents) {
    if (agent.isArchived || agentReadiness(agent, input.runtimes).status !== 'ready' ||
        !await workspaceRegistry.canAccessProjectAgentRun(input.context, input.projectId, agent.id)) continue;
    eligible.push({ agent, persona: resolveAgent(agent, { ...(input.projectKey ? { projectKey: input.projectKey } : {}), includeMemory: false, includeToolPolicy: false }) });
  }
  return eligible;
}

/** The planning identity: the Orchestrator Agent when it can plan, otherwise any planning role, always one with a planner model. */
export function selectPlanner(eligible: PlanningAgent[], runtimes: Runtime[]): PlanningAgent | undefined {
  const candidates = eligible.filter(item => roleCanPlan(item.persona.role) && plannerModelName(item.persona.modelProvider, item.persona.modelName, runtimes));
  return candidates.find(item => item.persona.role.trim().toLowerCase() === 'orchestrator agent') ?? candidates[0];
}

/** What the planner is told about each agent it may assign. */
export function plannableAgents(eligible: PlanningAgent[]) {
  return eligible.map(({ agent, persona }) => ({ id: agent.id, role: persona.role, name: persona.name,
    description: (agent.description ?? '').slice(0, 240), ready: true as const, official: Boolean(agent.templateKey) }));
}

/** The planner identity passed to the planning model. */
export function plannerIdentity(item: PlanningAgent, runtimes: Runtime[]) {
  return { id: item.agent.id, name: item.persona.name, role: item.persona.role, provider: item.persona.modelProvider,
    modelName: plannerModelName(item.persona.modelProvider, item.persona.modelName, runtimes), systemPrompt: item.persona.systemPrompt,
    reasoningEffort: item.persona.reasoningEffort };
}
