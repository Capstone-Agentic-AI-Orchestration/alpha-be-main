import type { SQLiteService } from './sqliteService.js';
import type { OrchestrationOutboxDeliveryRecord } from './orchestrationStateMachine.js';

export type OrchestrationEventNotification = Pick<
  OrchestrationOutboxDeliveryRecord,
  'runId' | 'eventId' | 'sequence' | 'type' | 'createdAt'
>;

type OutboxStore = Pick<SQLiteService,
  'listDueOrchestrationOutbox' | 'markOrchestrationOutboxDelivered' | 'retryOrchestrationOutbox'>;

export interface OrchestrationOutboxFlushResult {
  delivered: number;
  deferred: number;
}

/** Publish small event cursors after their state transaction committed. */
export async function flushOrchestrationEventOutbox(
  store: OutboxStore,
  publish: (event: OrchestrationEventNotification) => void | Promise<void>,
  now = new Date().toISOString(),
  limit = 100,
  onFailure?: (error: unknown) => void
): Promise<OrchestrationOutboxFlushResult> {
  const pending = store.listDueOrchestrationOutbox(now, limit);
  const result: OrchestrationOutboxFlushResult = { delivered: 0, deferred: 0 };

  for (const event of pending) {
    const notification: OrchestrationEventNotification = {
      runId: event.runId,
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      createdAt: event.createdAt
    };
    try {
      await publish(notification);
      if (store.markOrchestrationOutboxDelivered(event.workspaceId, event.eventId, now)) result.delivered += 1;
    } catch (error) {
      const delayMs = Math.min(60_000, 250 * 2 ** Math.min(event.attempts, 8));
      store.retryOrchestrationOutbox({
        workspaceId: event.workspaceId,
        eventId: event.eventId,
        nextAttemptAt: new Date(Date.parse(now) + delayMs).toISOString(),
        // Do not persist transport error text; it may contain implementation or user data.
        errorCode: 'notification_publish_failed'
      });
      result.deferred += 1;
      onFailure?.(error);
    }
  }

  return result;
}

/** A single in-process worker is enough for the local desktop pilot. */
export function startOrchestrationEventOutboxWorker(input: {
  store: OutboxStore;
  publish: (event: OrchestrationEventNotification) => void | Promise<void>;
  onFailure?: (error: unknown) => void;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let flushing = false;
  const flush = async () => {
    if (stopped || flushing) return;
    flushing = true;
    try {
      await flushOrchestrationEventOutbox(input.store, input.publish, new Date().toISOString(), 100, input.onFailure);
    } catch (error) {
      input.onFailure?.(error);
    } finally {
      flushing = false;
    }
  };
  const timer = setInterval(() => void flush(), input.intervalMs ?? 1_000);
  timer.unref?.();
  void flush();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
