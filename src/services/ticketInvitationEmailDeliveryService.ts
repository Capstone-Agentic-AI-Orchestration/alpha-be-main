import {
  PostgresTicketInvitationEmailStore,
  type TicketInvitationEmailClaim,
  type TicketInvitationEmailFailureCode,
} from '../store/ticketInvitationEmailPostgresStore.js';
import { TicketInvitationEmailError, type TicketInvitationEmailProvider } from './ticketInvitationEmailProvider.js';

export const TICKET_INVITATION_EMAIL_MAX_ATTEMPTS = 5;
export const TICKET_INVITATION_EMAIL_RETRY_WINDOW_MS = 10 * 60_000;

export function createTicketInvitationEmailDeliveryService(
  store: PostgresTicketInvitationEmailStore,
  provider: TicketInvitationEmailProvider,
  now: () => Date = () => new Date(),
) {
  async function fail(claim: TicketInvitationEmailClaim, retryable: boolean): Promise<void> {
    if (retryable && claim.attempt < TICKET_INVITATION_EMAIL_MAX_ATTEMPTS) {
      const seconds = Math.min(240, 30 * 2 ** Math.max(0, claim.attempt - 1));
      await store.scheduleRetry(claim, seconds);
      return;
    }
    const reason: TicketInvitationEmailFailureCode = retryable ? 'attempt_limit_reached' : 'provider_failure';
    await store.deadLetter(claim, reason);
  }

  return {
    async deliverNext(): Promise<boolean> {
      const claim = await store.claimNext(provider.identity);
      if (!claim) return false;
      if (!claim.identityMatches || claim.attempt > TICKET_INVITATION_EMAIL_MAX_ATTEMPTS) {
        await store.deadLetter(claim, 'provider_failure');
        return true;
      }
      const firstAttempt = Date.parse(claim.firstAttemptAt);
      const currentTime = now().getTime();
      if (!Number.isFinite(firstAttempt) || firstAttempt > currentTime
        || currentTime - firstAttempt >= TICKET_INVITATION_EMAIL_RETRY_WINDOW_MS) {
        await store.deadLetter(claim, 'attempt_limit_reached');
        return true;
      }
      if (!await store.canDispatch(claim)) {
        await store.discard(claim);
        return true;
      }

      try {
        await provider.send(claim.recipient, `client-invitation/${claim.eventId}`);
      } catch (error) {
        await fail(claim, error instanceof TicketInvitationEmailError && error.retryable);
        return true;
      }
      // Keep DB confirmation outside the provider catch. The stable provider
      // idempotency key makes a recovered lease safe after an uncertain commit.
      await store.markDelivered(claim);
      return true;
    },
  };
}

/** Cloud-only outbox poller. Missing sender settings leave the application bootable. */
export function startTicketInvitationEmailDelivery(config: {
  isCloud: boolean;
  enabled: boolean;
  providerFactory: () => TicketInvitationEmailProvider | null;
  database: () => import('../store/database.js').TransactionalSql;
  onUnavailable: () => void;
}): () => void {
  if (!config.isCloud || !config.enabled) return () => undefined;
  const provider = config.providerFactory();
  if (!provider) {
    config.onUnavailable();
    return () => undefined;
  }
  const store = new PostgresTicketInvitationEmailStore(config.database());
  const delivery = createTicketInvitationEmailDeliveryService(store, provider);
  let stopped = false;
  let busy = false;
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      for (let i = 0; i < 5 && !stopped; i++) if (!await delivery.deliverNext()) break;
    } catch { config.onUnavailable(); }
    finally { busy = false; }
  }
  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
