import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

const STATUS: Record<string, string> = {
  planning: 'planning', awaiting_plan_approval: 'waiting for the person to approve its plan', executing: 'running',
  paused: 'paused', validating: 'running its final checks', awaiting_approval: 'finished and waiting for the person to review it',
  publishing: 'opening its pull request', blocked: 'stopped and waiting for the person', recovery_required: 'stopped and waiting for the person',
  cancelling: 'stopping', completed: 'completed', cancelled: 'cancelled', failed: 'failed'
};

const clip = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? flat.slice(0, length) + '…' : flat;
};

/**
 * The project's latest Orchestrator build, for the chat agent. Without it a question
 * such as "what is the problem with this?" asked beside a stopped build was answered
 * from the code alone, because nothing told the agent a build existed or why it stopped.
 */
export function describeProjectBuild(
  snapshot: OrchestrationSnapshot | undefined,
  agentName: (agentId: string) => string,
  threadId?: string
): string | undefined {
  if (!snapshot || (threadId && snapshot.run.originChatThreadId !== threadId)) return undefined;
  const { run, tasks, attempts, findings } = snapshot;
  const lines = [
    '## This project\'s latest Orchestrator build (live state; answer questions about "the build" or "this problem" from it)',
    `- Goal: ${clip(run.plan.goal, 300)}`,
    `- Status: ${STATUS[run.status] ?? run.status}`
  ];
  if (run.stoppedReason) lines.push(`- Why it stopped: ${clip(run.stoppedReason, 600)}`);
  for (const task of tasks) {
    const attempt = [...attempts].reverse().find(item => item.taskId === task.id && item.status === 'accepted')
      ?? [...attempts].reverse().find(item => item.taskId === task.id);
    const summary = typeof attempt?.result?.summary === 'string' ? ` — ${clip(attempt.result.summary, 280)}` : '';
    const failure = attempt?.failureReason && task.status !== 'accepted' ? ` (last problem: ${clip(attempt.failureReason, 200)})` : '';
    lines.push(`- Task "${task.title}" by ${agentName(task.ownerAgentId)}: ${task.status}${summary}${failure}`);
  }
  const open = findings.filter(finding => finding.status === 'open');
  for (const finding of open.slice(0, 8)) {
    const title = typeof finding.evidence.title === 'string' ? finding.evidence.title
      : typeof finding.evidence.instruction === 'string' ? finding.evidence.instruction : 'Review finding';
    lines.push(`- Open ${finding.severity} finding: ${clip(title, 200)}${finding.path ? ' (' + finding.path + ')' : ''}`);
  }
  if (open.length > 8) lines.push(`- …and ${open.length - 8} more open findings`);
  lines.push('Explain the build in plain words when asked. Changing it happens from the build panel above the message box (continue, re-run the final checks, stop), not by editing code in this chat.');
  return lines.join('\n');
}

