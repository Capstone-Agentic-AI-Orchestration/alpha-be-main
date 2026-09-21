import { describe, it, expect } from 'vitest';

import { RunPublishGate } from './runPublishGate.js';

/**
 * Private run channels refuse a broadcast until its run row exists, and the
 * runner starts saving and streaming at the same moment. The gate is what
 * keeps the first events from arriving first.
 */
describe('run publish gate', () => {
  it('holds a broadcast until the first save lands', async () => {
    const gate = new RunPublishGate();
    let finishSave!: () => void;
    gate.saved('r1', new Promise<void>(resolve => { finishSave = resolve; }));

    let released = false;
    const waiting = gate.ready('r1').then(() => { released = true; });

    await Promise.resolve();
    expect(released).toBe(false);

    finishSave();
    await waiting;
    expect(released).toBe(true);
  });

  it('waits only on the first save, not on every later update', async () => {
    const gate = new RunPublishGate();
    gate.saved('r1', Promise.resolve());
    gate.saved('r1', new Promise(() => {})); // a later save that never settles

    await expect(gate.ready('r1')).resolves.toBeUndefined();
  });

  it('releases on a failed save, so events are refused and reported, not stuck', async () => {
    const gate = new RunPublishGate();
    gate.saved('r1', Promise.reject(new Error('no token')));
    await expect(gate.ready('r1')).resolves.toBeUndefined();
  });

  it('does not hold a run it never saw a save for', async () => {
    await expect(new RunPublishGate().ready('unknown')).resolves.toBeUndefined();
  });

  it('forgets a finished run', async () => {
    const gate = new RunPublishGate();
    gate.saved('r1', new Promise(() => {}));
    gate.done('r1');
    await expect(gate.ready('r1')).resolves.toBeUndefined();
  });
});
