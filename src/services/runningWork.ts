import type { Issue, PrototypeRun } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { taskThreadId } from './boardThreads.js';

/**
 * What is running on this desktop right now, for the "N running" indicator.
 *
 * Built from the engine's live lists (agent processes and chat replies in this
 * process), not from saved statuses, which stay "running" after a crash or restart.
 * A run saved as running with no live process is reported separately as interrupted,
 * so the board never claims work is happening when nothing is.
 */
export interface RunningItem {
  /** Stable across refreshes, for the list's keys. */
  id: string;
  kind: 'agent' | 'chat';
  projectId?: string;
  issueId?: string;
  identifier?: string;
  /** The person's own chat a reply is being written in, so the list can open it. */
  threadId?: string;
  /** The task's title, or the chat's. */
  title: string;
  agentName?: string;
  /** What it is doing, in a few plain words. */
  activity: string;
  startedAt?: string;
}

export interface RunningWork {
  running: RunningItem[];
  /** Saved as running, but nothing is executing it: open the task to resume or stop it. */
  interrupted: RunningItem[];
}

export interface RunningWorkInput {
  workspaceId: string;
  /** The person asking: only their own chats are listed. */
  userId: string;
  liveRunIds: readonly string[];
  liveTurns: ReadonlyArray<{ threadId: string; agentName?: string; startedAt: string }>;
  /** Run summaries of projects the person can see. */
  runs: readonly PrototypeRun[];
  /** Tasks the person can see, on or off the board. */
  issues: readonly Pick<Issue, 'id' | 'identifier' | 'title' | 'projectId'>[];
  agentNames: ReadonlyMap<string, string>;
  /** The person's own chat threads, by id. */
  threads: ReadonlyMap<string, { title: string; projectId?: string }>;
  /** Active builds, to say what an agent run is doing and whether a plan is being drafted. */
  orchestrations: readonly OrchestrationSnapshot[];
}

const CODE_KINDS = new Set(['database', 'backend', 'frontend', 'mobile', 'delivery']);

function agentActivity(run: PrototypeRun, orchestrations: readonly OrchestrationSnapshot[]): string {
  const task = run.orchestrationTaskId
    ? orchestrations.find(item => item.run.id === run.orchestrationRunId)?.tasks.find(item => item.id === run.orchestrationTaskId)
    : undefined;
  if (!task) return 'Working on the task';
  if (CODE_KINDS.has(task.kind)) return 'Writing code';
  if (task.kind === 'validation') return 'Checking the work';
  if (task.kind === 'review' || task.kind === 'audit') return 'Reviewing the changes';
  return 'Planning the approach';
}

export function runningWork(input: RunningWorkInput): RunningWork {
  const live = new Set(input.liveRunIds);
  const issues = new Map(input.issues.map(issue => [issue.id, issue]));
  const running: RunningItem[] = [];
  const interrupted: RunningItem[] = [];

  for (const run of input.runs) {
    const issue = issues.get(run.issueId);
    const item = {
      id: `run:${run.id}`, kind: 'agent' as const, projectId: run.projectId, issueId: issue?.id, identifier: issue?.identifier,
      title: issue?.title ?? 'A task', agentName: input.agentNames.get(run.agentId), startedAt: run.createdAt
    };
    if (live.has(run.id)) running.push({ ...item, activity: run.status === 'queued' ? 'Waiting for the working folder' : agentActivity(run, input.orchestrations) });
    // The status is written inside the execution, so "running" without one means it died with the
    // engine. A build's run only counts while that build is still active: a stopped build's leftover
    // record needs nobody's attention.
    else if (run.status === 'running' && (!run.orchestrationRunId || input.orchestrations.some(item => item.run.id === run.orchestrationRunId))) {
      interrupted.push({ ...item, activity: 'Nothing is running it any more' });
    }
  }

  // Board task conversations are private per person, with an id derived from the task.
  const taskThreads = new Map(input.issues.map(issue => [taskThreadId(input.workspaceId, input.userId, issue.id), issue]));
  for (const [index, turn] of input.liveTurns.entries()) {
    const issue = taskThreads.get(turn.threadId);
    const thread = input.threads.get(turn.threadId);
    if (!issue && !thread) continue; // Someone else's chat.
    const planning = issue && input.orchestrations.some(item => item.run.issueId === issue.id && item.run.status === 'planning');
    running.push({
      id: `chat:${turn.threadId}:${index}`, kind: 'chat', threadId: turn.threadId, projectId: issue?.projectId ?? thread?.projectId, issueId: issue?.id,
      identifier: issue?.identifier, title: issue?.title ?? thread!.title, agentName: turn.agentName, startedAt: turn.startedAt,
      activity: planning ? 'Drafting a plan' : 'Replying in chat'
    });
  }

  const oldestFirst = (a: RunningItem, b: RunningItem) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
  return { running: running.sort(oldestFirst), interrupted: interrupted.sort(oldestFirst) };
}
