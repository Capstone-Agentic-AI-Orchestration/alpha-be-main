/**
 * Where a run sits in its squad, and what that means for the run's final acts.
 *
 * Two things happen when a run finishes that must happen once per issue rather
 * than once per agent: a pull request is opened, and the kanban card moves to
 * Review. A squad is several runs against one issue on one shared branch, so
 * both belong to the last member and to nobody else.
 *
 * This was inline in runnerService, and only half applied. The pull request was
 * guarded; the card move was not — so a four-member squad showed the issue as
 * ready for review as soon as the first member finished, with three agents
 * still committing to the branch. One predicate in one place, with a test,
 * because it is easier to guard one call site and forget the second than it
 * looks from the diff.
 */

/** The parts of a run that say where it sits. */
export interface SquadPositioned {
  squadRunId?: string;
  squadOrder?: number;
}

/** The parts of a squad run that say how long it is. */
export interface SquadLength {
  memberAgentIds: string[];
}

/**
 * True when this run's completion is also the issue's completion.
 *
 * A solo run — no `squadRunId`, or a squad run the caller could not load — is
 * final by definition: it is the only run there is. Treating an unresolvable
 * squad as non-final would be the worse failure, leaving the card stuck in
 * `agent_running` and no pull request opened, with nothing to say why.
 */
export function isFinalSquadMember(
  run: SquadPositioned,
  squadRun: SquadLength | undefined
): boolean {
  if (!run.squadRunId || !squadRun) return true;
  return run.squadOrder === squadRun.memberAgentIds.length - 1;
}
