import type { TicketCommunicationDeliveryResult } from './ticketCommunicationNotificationService.js';

type DeliveryService = { deliverNext(): Promise<TicketCommunicationDeliveryResult> };

/** Cloud-only poller for Phase 5 client message/document notices. */
export function startTicketCommunicationNotificationWorker(config: {
  isCloud: boolean;
  enabled: boolean;
  delivery: DeliveryService;
  onUnavailable: () => void;
}): () => void {
  if (!config.isCloud || !config.enabled) return () => undefined;

  let stopped = false;
  let busy = false;
  let unavailableReported = false;
  async function tick() {
    if (stopped || busy) return;
    busy = true;
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
