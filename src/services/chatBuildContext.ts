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

/** One run as plain lines: goal, status, why it stopped, each planned task, and open findings. */
function describeRun(snapshot: OrchestrationSnapshot, agentName: (agentId: string) => string): string[] {
  const { run, tasks, attempts, findings } = snapshot;
  const lines = [
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
  return lines;
}

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
  const lines = [
    '## This project\'s latest Orchestrator build (live state; answer questions about "the build" or "this problem" from it)',
    ...describeRun(snapshot, agentName)
  ];
  lines.push('Explain the build in plain words when asked. Plans, instructions and review evidence are in the right panel. The user replies and approves through the main chat. Never ask them to type into a side-panel approval box. Do not edit code in this chat.');
  return lines.join('\n');
}

/** A board task and its latest Orchestrator build, if it has one. */
export interface BoardTaskRecord {
  identifier: string;
  title: string;
  /** The task's board column. */
  status: string;
  snapshot?: OrchestrationSnapshot;
}

/** Enough for twenty tasks with short plans, small enough to leave room for the question. */
const BOARD_RECORDS_MAX_CHARS = 6_000;

/**
 * The Orchestrator's records for the tasks on the board, for Ask Alpha.
 *
 * Runs are matched by task, not by conversation. A board question is asked in
 * the project's Ask thread, where no build ever starts, so matching by thread
 * found nothing: asked about a task whose build had been cancelled, the answer
 * said it was still to do and went looking in outside tools for a status.
 */
export function describeBoardTasks(
  tasks: BoardTaskRecord[],
  agentName: (agentId: string) => string,
  options: { canSeeBuilds: boolean; scoped: boolean }
): string {
  const header = options.scoped
    ? '## Orchestration records for the tasks the person selected (live state from Alpha)'
    : '## Orchestration records for the most recently updated tasks in this project (live state from Alpha)';
  const closing = [
    'Answer questions about these tasks and their builds from these records. When the records do not cover something, say so plainly.',
    'Never claim an agent ran, a check passed, or a build started beyond what is recorded here.'
  ].join(' ');
  if (!tasks.length) return [header, '- No tasks are on this project\'s board yet.', closing].join('\n');

  const sections: string[] = [];
  let used = header.length + closing.length;
  let omitted = 0;
  for (const task of tasks) {
    const lines = [`### ${task.identifier} · ${clip(task.title, 160)} (board column: ${task.status})`];
    if (!options.canSeeBuilds) lines.push('- Build records are not available to this person\'s workspace role.');
    else if (!task.snapshot) lines.push('- No build has started for this task.');
    else {
      lines.push(`- Latest build last updated: ${task.snapshot.run.updatedAt}`);
      lines.push(...describeRun(task.snapshot, agentName));
    }
    const section = lines.join('\n');
    if (sections.length && used + section.length > BOARD_RECORDS_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    sections.push(section);
    used += section.length;
  }
  if (omitted) sections.push(`- ${omitted} more ${omitted === 1 ? 'task was' : 'tasks were'} left out to keep this short. Ask about fewer tasks to see them.`);
  return [header, ...sections, closing].join('\n');
}

