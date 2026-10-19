import { afterEach, describe, expect, it, vi } from 'vitest';

import { startTicketCommunicationNotificationWorker } from './ticketCommunicationNotificationWorker.js';

afterEach(() => { vi.useRealTimers(); });

describe('client notification worker sweep', () => {
  it('keeps delivering messages when the action sweep fails, reports it once, and sweeps at most once a minute', async () => {
    vi.useFakeTimers();
    const deliverNext = vi.fn(async () => 'idle' as const);
    const enqueueDue = vi.fn(async () => { throw new Error('migration not applied'); });
    const onUnavailable = vi.fn();
    const onActionNoticesUnavailable = vi.fn();
    const stop = startTicketCommunicationNotificationWorker({
      isCloud: true, enabled: true, delivery: { deliverNext, enqueueDue }, onUnavailable, onActionNoticesUnavailable,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(enqueueDue).toHaveBeenCalledTimes(1);
    expect(deliverNext).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(onActionNoticesUnavailable).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(deliverNext).toHaveBeenCalledTimes(4);
    expect(enqueueDue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(enqueueDue).toHaveBeenCalledTimes(2);
    expect(onActionNoticesUnavailable).toHaveBeenCalledTimes(1);
    stop();
  });

  it('works with a sender that has no sweep', async () => {
    vi.useFakeTimers();
    const deliverNext = vi.fn(async () => 'idle' as const);
    const stop = startTicketCommunicationNotificationWorker({ isCloud: true, enabled: true, delivery: { deliverNext }, onUnavailable: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(deliverNext).toHaveBeenCalledTimes(1);
    stop();
  });
});
