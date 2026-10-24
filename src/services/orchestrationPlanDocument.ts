import { createHash } from 'node:crypto';
import type { OrchestrationPlan } from './orchestrationContract.js';

// Escape model-provided prose so it cannot introduce links, images or HTML in the preview.
const prose = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');

export function orchestrationPlanDocument(plan: OrchestrationPlan, version: number) {
  const lines = [`# Build plan · version ${version}`, '', prose(plan.goal), '',
    plan.milestones?.length ? 'Execution: continuous milestones. Later tasks are planned after the current milestone is accepted.' : 'Execution: direct task plan.',
    '', 'Review this document before starting planned work. Publication requires separate approval.', '', '## Requirements', ''];
  for (const requirement of plan.requirements) lines.push(`- **${prose(requirement.id)}**: ${prose(requirement.description)}`);
  if (plan.exclusions.length) lines.push('', '## Exclusions', '', ...plan.exclusions.map(value => `- ${prose(value)}`));
  if (plan.projectContext) lines.push('', '## Project guidance', '', prose(plan.projectContext));
  if (plan.milestones?.length) {
    lines.push('', '## Milestone roadmap', '');
    for (const [index, milestone] of plan.milestones.entries()) lines.push(
      `### ${index + 1}. ${prose(milestone.title)}`, '', prose(milestone.objective), '',
      `Requirements: ${milestone.requirementIds.map(prose).join(', ')}`, '',
      `Repositories: ${milestone.repositories.map(prose).join(', ')}`, '',
      plan.tasks.some(task => task.milestoneId === milestone.id) ? 'Detailed tasks are included below.' : 'Tasks will be planned from accepted repository evidence.', '');
  }
  lines.push('', '## Planned tasks', '');
  for (const task of plan.tasks) lines.push(`### ${prose(task.title)} (${prose(task.id)})`, '', prose(task.description), '',
    `Agent: ${prose(task.ownerAgentId)} · Role: ${prose(task.kind)}${task.repository ? ` · Repository: ${prose(task.repository)}` : ''}`, '',
    ...(task.milestoneId ? [`Milestone: ${prose(task.milestoneId)}`, ''] : []),
    ...(task.assignmentReason ? [prose(task.assignmentReason), ''] : []),
    `Dependencies: ${task.dependsOn.map(prose).join(', ') || 'None'}`, '',
    `Requirements: ${task.requirementIds.map(prose).join(', ')} · ${task.required ? 'Required' : 'Optional'}`, '',
    'Acceptance criteria:', '', ...task.acceptanceCriteria.map(value => `- ${prose(value)}`), '',
    `Checks: ${task.requiredChecks.join(', ') || 'None declared'}`, '',
    `Included paths: ${task.scope.includePaths.map(prose).join(', ') || 'No code paths declared'}`, '',
    `Excluded paths: ${task.scope.excludePaths.map(prose).join(', ') || 'None'}`, '');
  const content = lines.join('\n') + '\n';
  return { version, fileName: `build-plan-v${version}.md`, content, contentHash: createHash('sha256').update(content).digest('hex') };
}
