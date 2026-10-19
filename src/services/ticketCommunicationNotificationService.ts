import { TicketInvitationEmailError, type TicketInvitationContentEmailProvider } from './ticketInvitationEmailProvider.js';
import type {
  TicketClientAction, TicketCommunicationNotificationClaim, TicketCommunicationNotificationStore,
} from '../store/ticketCommunicationNotificationStore.js';

export type TicketCommunicationDeliveryResult = 'idle' | 'delivered' | 'retry' | 'discarded' | 'dead';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A scope or result shared in the last day gets an immediate notice (older ones only get the reminder). */
const ACTION_FRESH_MS = DAY_MS;
/** One gentle reminder when the client has not acted for three days... */
const REMINDER_AFTER_MS = 3 * DAY_MS;
/** ...and none for requests that went quiet more than two weeks ago. */
const REMINDER_WITHIN_MS = 14 * DAY_MS;

const ACTION_COPY: Record<TicketClientAction, { subject: string; reminderSubject: string; summary: string }> = {
  agree_scope: {
    subject: 'Please review the proposed work on your Alpha ticket',
    reminderSubject: 'Reminder: please review the proposed work on your Alpha ticket',
    summary: 'Your project manager shared the work they propose for one of your tickets. Please read it, then agree to it or ask for changes. Work cannot start until you agree.',
  },
  review_result: {
    subject: 'Your result is ready to review on Alpha',
    reminderSubject: 'Reminder: your result is waiting for your review on Alpha',
    summary: 'Your project manager shared the finished work for one of your tickets. Please look it over, then accept it or tell them what needs fixing.',
  },
  reply: {
    subject: 'Your project manager is waiting for your reply on Alpha',
    reminderSubject: 'Reminder: your project manager is waiting for your reply on Alpha',
    summary: 'Your project manager asked you for more information on one of your tickets.',
  },
};

function emailContent(claim: Pick<TicketCommunicationNotificationClaim, 'kind' | 'action'>, portalUrl: string, actionUrl: string) {
  if (claim.action) {
    const copy = ACTION_COPY[claim.action];
    return {
      subject: claim.kind === 'reminder' ? copy.reminderSubject : copy.subject,
      text: [
        copy.summary,
        'Sign in to Alpha and open your tickets. The one that needs you is marked "Action needed":',
        actionUrl,
        'This email does not contain ticket details. If you did not expect it, you can ignore it.',
      ].join('\n\n'),
    };
  }
  return claim.kind === 'message'
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

/** Notices name the kind of request waiting on the client, never its content, ticket IDs or signed URLs. */
export function createTicketCommunicationNotificationService(
  store: TicketCommunicationNotificationStore,
  provider: TicketInvitationContentEmailProvider,
  webOrigin: string,
) {
  const portalUrl = new URL('/#/client', webOrigin).toString();
  // Opens the client's own ticket list already filtered to what needs them.
  const actionUrl = new URL('/#/client?filter=needs_client', webOrigin).toString();

  return {
    /** Queue "waiting on you" notices and one reminder per request. Safe to call repeatedly. */
    async enqueueDue(now: Date = new Date()): Promise<number> {
      return store.enqueueDueActionNotices({
        now: now.toISOString(), freshWithinMs: ACTION_FRESH_MS,
        reminderAfterMs: REMINDER_AFTER_MS, reminderWithinMs: REMINDER_WITHIN_MS,
      });
    },

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

      const content = emailContent(claim, portalUrl, actionUrl);
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
