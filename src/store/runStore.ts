import type { PrototypeRun, RemoteAction, SquadRun } from '../models/index.js';

/**
 * Runs: what an agent did, and what it touched outside the machine.
 *
 * Written by the desktop, which is where agents run, and read by the cloud,
 * which is where oversight happens. That asymmetry is the whole point of the
 * privacy split -- a project manager sees the work (stages, branches, pull
 * requests) without seeing the conversation that produced it.
 *
 * One caveat worth stating plainly: a desktop's runs reference its own issue
 * and project ids, and the cloud's tables have foreign keys to rows that only
 * exist under the shared board's ids. So the cloud can read runs today and
 * will have runs to read once the desktop works on the shared board.
 */
/** What a caller supplies; the store fills in an id and a timestamp. */
export type RemoteActionInput = Omit<RemoteAction, 'id' | 'createdAt'> &
  Partial<Pick<RemoteAction, 'id' | 'createdAt'>>;

export interface RunStore {
  list(workspaceId: string): Promise<PrototypeRun[]>;
  /**
   * The same runs without stage logs or the activity feed. Lists, analytics
   * and dashboards use this: the logs are most of a run's size, and reading
   * them back for counts made every refresh download the whole history.
   */
  listSummaries(workspaceId: string): Promise<PrototypeRun[]>;
  get(workspaceId: string, id: string): Promise<PrototypeRun | null>;
  /**
   * `ownerId` is the login a *new* row is recorded under, and is ignored when
   * the run already exists -- a run belongs to whoever produced it, and a
   * project manager approving one does not become its owner. Passed in rather
   * than read from the process, which in the cloud serves everybody.
   */
  save(workspaceId: string, run: PrototypeRun, ownerId: string): Promise<PrototypeRun>;

  listSquadRuns(workspaceId: string): Promise<SquadRun[]>;
  getSquadRun(workspaceId: string, id: string): Promise<SquadRun | null>;
  saveSquadRun(workspaceId: string, run: SquadRun, ownerId: string): Promise<SquadRun>;
  /** The member runs of one squad run, in the order the squad works. */
  runsForSquadRun(workspaceId: string, squadRunId: string): Promise<PrototypeRun[]>;

  /** Everything a run did to a remote: pushes, pull requests, merges. */
  recordRemoteAction(workspaceId: string, action: RemoteActionInput): Promise<RemoteAction>;
  listRemoteActions(workspaceId: string, runId?: string): Promise<RemoteAction[]>;
}

/** A run as lists show it: every field except stage logs and the activity feed. */
export function summarizeRun(run: PrototypeRun): PrototypeRun {
  return {
    ...run,
    stages: (run.stages ?? []).map(stage => ({ ...stage, logs: [] })),
    activities: [],
    logsOmitted: true
  };
}
