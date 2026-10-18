/**
 * One run at a time per working directory.
 *
 * Every run for a project executes in that project's checkout — the same
 * directory, every time — and `runnerService.startRun` fired `executeTask`
 * without awaiting it. Two runs on one project therefore overlapped, and the
 * first thing each one does is `git checkout -B <its own branch>`, which moves
 * the working tree. The second run switched the tree out from under the first;
 * both agents carried on editing files and committed to whichever branch
 * happened to be checked out at the time.
 *
 * Nothing prevented it. The UI disables the launch button for an issue that is
 * already running, but two *different* issues in one project are two clicks,
 * and the daemon had no guard of its own.
 *
 * So: work is serialised per directory, and only per directory. Runs in
 * different projects still execute at the same time, which is the parallelism
 * that was actually safe. This is deliberately not a global limit — that would
 * be a throughput decision, and this is a correctness one.
 *
 * ## Why a promise chain and not a lock
 *
 * A lock needs a release, and a release that is missed on a throw wedges the
 * workspace until the daemon restarts. Chaining makes the release structural:
 * the next task is attached to the settlement of the previous one, so it runs
 * whether that one resolved or rejected.
 */

export class WorkspaceQueue {
  /** The promise the next task for this key must wait on. */
  private tails = new Map<string, Promise<void>>();

  /** How many tasks are queued or running for this key, so tails can be dropped. */
  private counts = new Map<string, number>();

  /**
   * How many tasks are already queued or running for `key`.
   *
   * Read before enqueuing to tell the caller whether its task will start now or
   * wait — a run that reports itself as running while it sits in a queue is the
   * same kind of untruth as a run reporting tests it never executed.
   */
  depth(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Keys with work queued or running. For diagnostics. */
  activeKeys(): string[] {
    return [...this.counts.keys()];
  }

  /**
   * Run `task` once every task enqueued before it on `key` has settled.
   *
   * The returned promise settles with the task's own result, so callers see
   * their own failure and not the queue's.
   */
  run<T>(
    key: string,
    task: () => Promise<T>,
    options: { shouldStart?: () => boolean | Promise<boolean> } = {}
  ): Promise<T | undefined> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.counts.set(key, this.depth(key) + 1);

    // Both arms reach the same gate: a task must not be skipped merely because
    // the one before it threw, but a caller may withdraw queued work before it
    // reaches the front of the chain. The predicate is evaluated at the last
    // possible moment, immediately before the task would start.
    const runIfAllowed = async () => {
      if (options.shouldStart && !await options.shouldStart()) return undefined;
      return task();
    };
    const result = previous.then(runIfAllowed, runIfAllowed);

    let tail: Promise<void>;
    tail = result.then(
      () => this.release(key, () => tail),
      () => this.release(key, () => tail)
    );

    this.tails.set(key, tail);
    return result;
  }

  /**
   * Drop the key once nothing is left on it, so the maps do not grow for the
   * life of the daemon. The identity check matters: by the time this runs, a
   * later task may already have chained a new tail onto this one, and deleting
   * that would let the task after it start early.
   */
  private release(key: string, self: () => Promise<void>) {
    const remaining = this.depth(key) - 1;

    if (remaining > 0) {
      this.counts.set(key, remaining);
      return;
    }

    this.counts.delete(key);
    if (this.tails.get(key) === self()) this.tails.delete(key);
  }
}

/**
 * Keyed by the resolved workspace path, which is what the git commands actually
 * operate on — two projects pointed at one checkout must share a queue, and
 * they would not if this were keyed by project id.
 */
export const workspaceQueue = new WorkspaceQueue();
