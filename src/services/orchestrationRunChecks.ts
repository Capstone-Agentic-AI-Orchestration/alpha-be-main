import type { Agent } from '../models/index.js';
import { MAX_INITIAL_PLAN_TASKS, validateOrchestrationPlan, type OrchestrationPlan, type PlanValidationIssue } from './orchestrationContract.js';
import type { OrchestrationRunRecord } from './orchestrationStateMachine.js';
import { planRepositoryCoverage } from './orchestrationWorkspace.js';

/**
 * The one place a plan is checked outside the planner. Each call site names what it is checking,
 * and the options come from here and from the saved run, so the same rule can no longer be written
 * differently in two places (a codebase allowed to stay empty at planning, refused at start).
 * A guard test fails when a new direct validateOrchestrationPlan call appears elsewhere.
 */
export type RunPlanCheck =
  /** Starting an approved plan: the tasks that will actually run. */
  | 'start'
  /** Replacing a plan that has not started. */
  | 'revision'
  /** A plan after the next milestone's tasks are added. */
  | 'milestone'
  /** A blocked build's replacement audit plan; its baseline audits cover every codebase. */
  | 'audit_replan'
  /** Correction and validation tasks added after review; built by code, not the model. */
  | 'review_correction';

type Agents = readonly Pick<Agent, 'id' | 'role'>[];

export function checkRunPlan(run: OrchestrationRunRecord, plan: OrchestrationPlan, purpose: RunPlanCheck, agents: Agents): PlanValidationIssue[] {
  switch (purpose) {
    case 'start':
      return validateOrchestrationPlan(plan, agents, { maxTaskCount: MAX_INITIAL_PLAN_TASKS, initialPlan: true, ...planRepositoryCoverage(run) });
    case 'revision':
      return validateOrchestrationPlan(plan, agents, { initialPlan: true, ...planRepositoryCoverage(run) });
    case 'milestone':
      return validateOrchestrationPlan(plan, agents, planRepositoryCoverage(run));
    case 'audit_replan':
      return validateOrchestrationPlan(plan, agents, { initialPlan: true, repositories: planRepositoryCoverage(run).repositories });
    case 'review_correction':
      return validateOrchestrationPlan(plan, agents);
  }
}

/** One milestone's own tasks, checked against the codebases that milestone names. */
export function checkMilestoneStage(stage: OrchestrationPlan, repositories: readonly string[], agents: Agents): PlanValidationIssue[] {
  return validateOrchestrationPlan(stage, agents, { initialPlan: true, maxTaskCount: MAX_INITIAL_PLAN_TASKS, repositories, auditMilestone: true });
}

/** A new build's first plan, before its run exists; the same rule the planner used. */
export function checkNewRunPlan(plan: OrchestrationPlan, agents: Agents, scope: { repositories?: readonly string[]; optionalRepositories?: readonly string[] }): PlanValidationIssue[] {
  return validateOrchestrationPlan(plan, agents, { maxTaskCount: MAX_INITIAL_PLAN_TASKS, initialPlan: true, ...scope });
}
