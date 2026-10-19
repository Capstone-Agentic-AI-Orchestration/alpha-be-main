import { describe, expect, it, vi } from 'vitest';
import { flushOrchestrationEventOutbox } from './orchestrationEventDelivery.js';
import type { OrchestrationOutboxDeliveryRecord } from './orchestrationStateMachine.js';

const event: OrchestrationOutboxDeliveryRecord = {
  workspaceId: 'private-workspace',
  runId: 'run-1',
  eventId: 'event-1',
  sequence: 3,
  type: 'task_accepted',
  createdAt: '2026-10-20T00:00:00.000Z',
  attempts: 0
};

describe('orchestration event outbox delivery', () => {
  it('publishes only event cursors and marks a delivered event', async () => {
    const store = {
      listDueOrchestrationOutbox: vi.fn(() => [event]),
      markOrchestrationOutboxDelivered: vi.fn(() => true),
      retryOrchestrationOutbox: vi.fn(() => true)
    };
    const publish = vi.fn();

    const result = await flushOrchestrationEventOutbox(store as any, publish, event.createdAt);

    expect(publish).toHaveBeenCalledWith({
      runId: event.runId,
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      createdAt: event.createdAt
    });
    expect(publish.mock.calls[0][0]).not.toHaveProperty('workspaceId');
    expect(result).toEqual({ delivered: 1, deferred: 0 });
    expect(store.markOrchestrationOutboxDelivered).toHaveBeenCalledWith(event.workspaceId, event.eventId, event.createdAt);
    expect(store.retryOrchestrationOutbox).not.toHaveBeenCalled();
  });

  it('defers a failed notification with bounded backoff and safe error metadata', async () => {
    const store = {
      listDueOrchestrationOutbox: vi.fn(() => [{ ...event, attempts: 1 }]),
      markOrchestrationOutboxDelivered: vi.fn(() => true),
      retryOrchestrationOutbox: vi.fn(() => true)
    };
    const onFailure = vi.fn();
    const failure = new Error('sensitive local transport detail');

    const result = await flushOrchestrationEventOutbox(
      store as any,
      () => { throw failure; },
      event.createdAt,
      100,
      onFailure
    );

    expect(result).toEqual({ delivered: 0, deferred: 1 });
    expect(store.markOrchestrationOutboxDelivered).not.toHaveBeenCalled();
    expect(store.retryOrchestrationOutbox).toHaveBeenCalledWith({
      workspaceId: event.workspaceId,
      eventId: event.eventId,
      nextAttemptAt: '2026-10-20T00:00:00.500Z',
      errorCode: 'notification_publish_failed'
    });
    expect(onFailure).toHaveBeenCalledWith(failure);
  });
});
