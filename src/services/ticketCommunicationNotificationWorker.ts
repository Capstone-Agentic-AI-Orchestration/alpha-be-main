import type { TicketCommunicationDeliveryResult } from './ticketCommunicationNotificationService.js';

type DeliveryService = {
  deliverNext(): Promise<TicketCommunicationDeliveryResult>;
  /** Queue "waiting on you" notices and reminders; optional so a plain sender still works. */
  enqueueDue?(): Promise<number>;
};

const SWEEP_EVERY_MS = 60_000;

/** Cloud-only poller for client message, document, action-needed and reminder notices. */
export function startTicketCommunicationNotificationWorker(config: {
  isCloud: boolean;
  enabled: boolean;
  delivery: DeliveryService;
  onUnavailable: () => void;
  /** Called once when the action/reminder sweep fails, e.g. before the latest migration is applied. */
  onActionNoticesUnavailable?: () => void;
}): () => void {
  if (!config.isCloud || !config.enabled) return () => undefined;

  let stopped = false;
  let busy = false;
  let unavailableReported = false;
  let sweepReported = false;
  let lastSweepAt = 0;
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    // A failing sweep must never stop messages and documents from being delivered.
    if (config.delivery.enqueueDue && Date.now() - lastSweepAt >= SWEEP_EVERY_MS) {
      lastSweepAt = Date.now();
      try { await config.delivery.enqueueDue(); sweepReported = false; }
      catch {
        if (!sweepReported) { try { config.onActionNoticesUnavailable?.(); } catch { /* logging only */ } }
        sweepReported = true;
      }
    }
    try {
      for (let i = 0; i < 5 && !stopped; i++) {
        const result = await config.delivery.deliverNext();
        if (result === 'idle') break;
      }
      unavailableReported = false;
    } catch {
      if (!unavailableReported) config.onUnavailable();
      unavailableReported = true;
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
