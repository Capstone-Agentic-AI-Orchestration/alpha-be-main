import { describe, it, expect } from 'vitest';
import { WorkspaceQueue } from './workspaceQueue.js';

/**
 * Serialising runs that share a checkout.
 *
 * The property that matters is not "tasks finish" but "tasks never overlap":
 * the failure this exists to prevent is two agents editing one working tree
 * while git switches the branch under both of them.
 */

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** Records enter/exit so an overlap is visible rather than inferred. */
function tracker() {
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;
  return {
    log,
    get maxActive() { return maxActive; },
    task: (name: string, ms = 5, fail = false) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      log.push(`+${name}`);
      await tick(ms);
      log.push(`-${name}`);
      active -= 1;
      if (fail) throw new Error(`${name} failed`);
      return name;
    }
  };
}

describe('WorkspaceQueue', () => {
  it('never runs two tasks on the same key at once', async () => {
    const q = new WorkspaceQueue();
    const t = tracker();

    await Promise.all([
      q.run('/repo', t.task('a', 10)),
      q.run('/repo', t.task('b', 1)),
      q.run('/repo', t.task('c', 5))
    ]);

    expect(t.maxActive).toBe(1);
    expect(t.log).toEqual(['+a', '-a', '+b', '-b', '+c', '-c']);
  });

  it('runs different keys in parallel', async () => {
    // The whole point of keying by directory: two projects are not each other's
    // problem, and serialising them globally would be a throughput decision
    // dressed up as a correctness one.
    const q = new WorkspaceQueue();
    const t = tracker();

    await Promise.all([
      q.run('/repo-a', t.task('a', 10)),
      q.run('/repo-b', t.task('b', 10))
    ]);

    expect(t.maxActive).toBe(2);
  });

  it('starts the next task after one throws', async () => {
    // A wedged workspace is worse than a failed run: nothing on that project
    // could ever run again until the daemon restarted.
    const q = new WorkspaceQueue();
    const t = tracker();

    const first = q.run('/repo', t.task('a', 1, true));
    const second = q.run('/repo', t.task('b', 1));

    await expect(first).rejects.toThrow('a failed');
    await expect(second).resolves.toBe('b');
    expect(t.log).toEqual(['+a', '-a', '+b', '-b']);
  });

  it("gives the caller its own result, not the queue's", async () => {
    const q = new WorkspaceQueue();
    await expect(q.run('/repo', async () => 42)).resolves.toBe(42);
  });

  it('reports depth so a caller can tell it will wait', async () => {
    const q = new WorkspaceQueue();
    expect(q.depth('/repo')).toBe(0);

    const a = q.run('/repo', async () => { await tick(5); });
    expect(q.depth('/repo')).toBe(1);

    const b = q.run('/repo', async () => {});
    expect(q.depth('/repo')).toBe(2);

    await Promise.all([a, b]);
    expect(q.depth('/repo')).toBe(0);
  });

  it('skips queued work when its cancellation predicate is false', async () => {
    const q = new WorkspaceQueue();
    let allowSecond = true;
    let secondStarted = false;

    const first = q.run('/repo', async () => { await tick(5); });
    const second = q.run('/repo', async () => {
      secondStarted = true;
      return 'started';
    }, { shouldStart: () => allowSecond });

    allowSecond = false;
    await Promise.all([first, second]);

    expect(secondStarted).toBe(false);
    await expect(second).resolves.toBeUndefined();
    expect(q.depth('/repo')).toBe(0);
  });

  it('forgets a key once its work is done', async () => {
    // Otherwise the maps grow for the life of the daemon, one entry per
    // directory ever touched.
    const q = new WorkspaceQueue();
    await q.run('/repo', async () => {});
    expect(q.activeKeys()).toEqual([]);
  });

  /**
   * The identity check in release() exists for exactly this interleaving.
   *
   * If a task enqueued while the previous one is settling caused the tail to be
   * deleted, the task after it would chain onto a fresh resolved promise and
   * start immediately — two tasks running on one directory, which is the bug.
   */
  it('does not drop a tail that a later task has already chained onto', async () => {
    const q = new WorkspaceQueue();
    const t = tracker();

    const a = q.run('/repo', t.task('a', 1));
    await tick(2);            // let 'a' finish while its release is pending
    const b = q.run('/repo', t.task('b', 10));
    const c = q.run('/repo', t.task('c', 1));

    await Promise.all([a, b, c]);
    expect(t.maxActive).toBe(1);
    expect(t.log).toEqual(['+a', '-a', '+b', '-b', '+c', '-c']);
  });
});
