/**
 * Holds a run's live events until the run itself exists in the cloud.
 *
 * Run channels are private (0006): Realtime lets a message through only if
 * the sender owns a `prototype_runs` row for that channel. The runner saves a
 * run and starts streaming it in the same breath, both fire-and-forget, so the
 * first stage updates could reach Realtime before the row did -- and be
 * refused, silently, as a policy violation. Broadcasts now wait for the run's
 * first save to settle.
 *
 * Only the first save gates anything: once the row exists, later updates to it
 * change nothing about who may publish. A save that fails still releases the
 * gate; the broadcast is then refused by policy and reported, rather than
 * held forever.
 */
export class RunPublishGate {
  private readonly firstSave = new Map<string, Promise<void>>();

  /** Record a save of this run. Only the first one per run is waited on. */
  saved(runId: string, save: Promise<unknown>): void {
    if (!this.firstSave.has(runId)) {
      this.firstSave.set(runId, save.then(() => undefined, () => undefined));
    }
  }

  /** Resolves once the run's first save has settled, or at once if none began. */
  async ready(runId: string): Promise<void> {
    await this.firstSave.get(runId);
  }

  /** Forget a finished run, so a long-lived daemon does not accumulate them. */
  done(runId: string): void {
    this.firstSave.delete(runId);
  }
}
