/**
 * A specialist runs its assigned checks before handing in.
 *
 * Alpha always verifies the worktree after the report, but a failure found only there costs a
 * whole attempt: the model never saw the TypeScript or ESLint error it could have fixed in a
 * minute. So handing in waits until every assigned check has been run since the last file
 * change. A check that fails can still be handed in -- the agent reports it, and Alpha's own
 * verification decides -- because a failure the agent cannot fix must not trap it.
 */
export class TaskCheckGate {
  private changeVersion = 0;
  private readonly ranAt = new Map<string, number>();

  constructor(private readonly requiredChecks: readonly string[]) {}

  /** A file, or the lockfile, changed. */
  recordChange(): void {
    this.changeVersion += 1;
  }

  /** These checks ran (passed, failed, or could not start) against the current files. */
  recordRun(scripts: readonly string[]): void {
    for (const script of scripts) this.ranAt.set(script, this.changeVersion);
  }

  /** Assigned checks not run since the last change; empty when the agent changed nothing. */
  missing(): string[] {
    if (this.changeVersion === 0) return [];
    return this.requiredChecks.filter(script => this.ranAt.get(script) !== this.changeVersion);
  }

  /** Why handing in waits, or undefined when it may proceed. */
  refusal(): string | undefined {
    const missing = this.missing();
    if (!missing.length) return undefined;
    return 'Not accepted yet: run project_run_check with scripts ' + JSON.stringify(missing)
      + ' on your latest changes, fix what fails within your scope, then call project_submit_work again.'
      + ' If a check still fails for a reason you cannot fix, report it as failed with the reason.';
  }
}
