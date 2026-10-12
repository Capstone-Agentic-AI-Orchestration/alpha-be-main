import { TicketInvitationEmailError, type TicketInvitationContentEmailProvider } from './ticketInvitationEmailProvider.js';
import type { TicketCommunicationNotificationClaim, TicketCommunicationNotificationStore } from '../store/ticketCommunicationNotificationStore.js';

export type TicketCommunicationDeliveryResult = 'idle' | 'delivered' | 'retry' | 'discarded' | 'dead';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 5 * 60_000;

function emailContent(kind: TicketCommunicationNotificationClaim['kind'], portalUrl: string) {
  return kind === 'message'
    ? {
      subject: 'A new message is waiting in your Alpha client portal',
      text: [
        'Your project manager sent you an update about one of your tickets.',
        'Sign in to Alpha and open My Tickets to read and reply:',
        portalUrl,
        'This email does not contain ticket details. If you did not expect it, you can ignore it.',
      ].join('\n\n'),
    }
    : {
      subject: 'A ticket document is available in your Alpha client portal',
      text: [
        'Your project manager added a document to one of your tickets.',
        'Sign in to Alpha and open My Tickets to review the document:',
        portalUrl,
        'This email does not contain the document or a download link. If you did not expect it, you can ignore it.',
      ].join('\n\n'),
    };
}

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1));
}

function retryable(error: unknown): boolean {
  return !(error instanceof TicketInvitationEmailError) || error.retryable;
}

/** Generic notices only: never places client text, file names, ticket IDs, or signed URLs in email. */
export function createTicketCommunicationNotificationService(
  store: TicketCommunicationNotificationStore,
  provider: TicketInvitationContentEmailProvider,
  webOrigin: string,
) {
  const portalUrl = new URL('/#/client', webOrigin).toString();

  return {
    async deliverNext(): Promise<TicketCommunicationDeliveryResult> {
      const now = new Date();
      const claim = await store.claimNext({
        now: now.toISOString(), leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
      });
      if (!claim) return 'idle';
      if (!provider.canSendTo?.(claim.recipient)) {
        await store.discard(claim, new Date().toISOString());
        return 'discarded';
      }

      const content = emailContent(claim.kind, portalUrl);
      try {
        await provider.sendContent(claim.recipient, content.subject, content.text,
          `alpha-ticket-communication-${claim.eventId}`);
      } catch (error) {
        if (!retryable(error) || claim.attempt >= MAX_ATTEMPTS) {
          await store.deadLetter(claim, new Date().toISOString(),
            claim.attempt >= MAX_ATTEMPTS ? 'attempt_limit_reached' : 'provider_failure');
          return 'dead';
        }
        const retryAt = new Date(Date.now() + retryDelay(claim.attempt)).toISOString();
        await store.scheduleRetry(claim, retryAt);
        return 'retry';
      }

      await store.markDelivered(claim, new Date().toISOString());
      return 'delivered';
    },
  };
}
