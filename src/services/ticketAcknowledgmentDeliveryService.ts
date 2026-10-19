import type { TransactionalSql } from '../store/database.js';
import { ACKNOWLEDGMENT_MAX_ATTEMPTS, PostgresTicketAcknowledgmentStore } from '../store/ticketAcknowledgmentPostgresStore.js';
import { TicketAcknowledgmentEmailError,
  type TicketAcknowledgmentEmailProvider } from './ticketAcknowledgmentEmailProvider.js';

export function createTicketAcknowledgmentDeliveryService(
  store: PostgresTicketAcknowledgmentStore, provider: TicketAcknowledgmentEmailProvider,
) {
  return {
    async deliverNext(): Promise<boolean> {
      // A failed/unknown claim COMMIT propagates BEFORE sending. An expired
      // lease can recover it later using the same persisted idempotency key.
      const claim = await store.claim(provider.identity);
      if (!claim) return false;
      if (!claim.identityMatches || !claim.firstAttemptAt) {
        await store.finish(claim, 'dead', 'secret_integrity_failure');
        return true;
      }
      if (claim.attempt > ACKNOWLEDGMENT_MAX_ATTEMPTS || !await store.canDispatch(claim)) {
        await store.finish(claim, 'dead', 'attempt_limit_reached');
        return true;
      }
      let failure: unknown;
      let accepted = false;
      try {
        if (claim.kind === 'central') await provider.send(claim.recipient, claim.id, claim.publicReference);
        else await provider.send(claim.recipient, claim.id);
        accepted = true;
      }
      catch (error) { failure = error; }
      // Deliberately outside the provider catch: failed confirmation must not
      // turn a successful provider call into an unbounded new send.
      if (accepted) await store.finish(claim, 'delivered');
      else await store.finish(claim,
        failure instanceof TicketAcknowledgmentEmailError && failure.retryable
          && claim.attempt < ACKNOWLEDGMENT_MAX_ATTEMPTS ? 'retry' : 'dead', 'provider_failure');
      return true;
    },
  };
}

/** Cloud-only composition; missing sender credentials do not stop Alpha boot. */
export function startTicketAcknowledgmentDelivery(config: {
  isCloud: boolean; enabled: boolean; providerFactory: () => TicketAcknowledgmentEmailProvider | null;
  database: () => TransactionalSql; onUnavailable: () => void;
}): () => void {
  if (!config.isCloud || !config.enabled) return () => undefined;
  const provider = config.providerFactory();
  if (!provider) { config.onUnavailable(); return () => undefined; }
  const delivery = createTicketAcknowledgmentDeliveryService(new PostgresTicketAcknowledgmentStore(config.database()), provider);
  let stopped = false;
  let busy = false;
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      // Bound DB/network work per tick; other application requests keep the pool.
      for (let i = 0; i < 5 && !stopped; i++) if (!await delivery.deliverNext()) break;
    } catch { config.onUnavailable(); }
    finally { busy = false; }
  }
  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
