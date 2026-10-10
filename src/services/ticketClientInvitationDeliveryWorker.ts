import type { TicketClientInvitationDeliveryService } from './ticketClientInvitationDeliveryService.js';

/** Cloud-only poller for activation-version outbox events. The Phase 3 notice
 * worker remains independent and continues draining its existing event shape. */
export function startTicketClientInvitationDeliveryWorker(config: {
  isCloud: boolean;
  enabled: boolean;
  delivery: TicketClientInvitationDeliveryService;
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
