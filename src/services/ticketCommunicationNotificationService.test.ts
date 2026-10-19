import { describe, expect, it, vi } from 'vitest';

import { createTicketCommunicationNotificationService } from './ticketCommunicationNotificationService.js';
import type { TicketCommunicationNotificationClaim, TicketCommunicationNotificationStore } from '../store/ticketCommunicationNotificationStore.js';

const claim: TicketCommunicationNotificationClaim = {
  eventId: 'notification-event-1', leaseToken: 'opaque-lease-token', attempt: 1, kind: 'message', action: null,
  recipient: 'verified-client@example.test',
};

function store(overrides: Partial<TicketCommunicationNotificationStore> = {}) {
  return {
    claimNext: vi.fn(async () => claim),
    enqueueDueActionNotices: vi.fn(async () => 0),
    markDelivered: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    deadLetter: vi.fn(async () => true),
    discard: vi.fn(async () => true),
    ...overrides,
  } satisfies TicketCommunicationNotificationStore;
}

describe('Client ticket update email notifications', () => {
  const provider = (sendContent: ReturnType<typeof vi.fn>) => ({
    identity: 'ticket-communication-test-provider', canSendTo: () => true, send: async () => undefined, sendContent,
  });

  it.each([
    ['action', 'agree_scope', 'Please review the proposed work on your Alpha ticket', 'agree to it or ask for changes'],
    ['action', 'review_result', 'Your result is ready to review on Alpha', 'accept it or tell them what needs fixing'],
    ['message', 'reply', 'Your project manager is waiting for your reply on Alpha', 'asked you for more information'],
    ['reminder', 'agree_scope', 'Reminder: please review the proposed work on your Alpha ticket', 'agree to it or ask for changes'],
    ['reminder', 'review_result', 'Reminder: your result is waiting for your review on Alpha', 'accept it or tell them what needs fixing'],
    ['reminder', 'reply', 'Reminder: your project manager is waiting for your reply on Alpha', 'asked you for more information'],
  ] as const)('names the request in a %s email about %s and links to the tickets that need the client', async (kind, action, subject, sentence) => {
    const sendContent = vi.fn(async (_to: string, _subject: string, _text: string, _key: string) => undefined);
    const service = createTicketCommunicationNotificationService(store({ claimNext: vi.fn(async () => ({ ...claim, kind, action })) }),
      provider(sendContent), 'https://tickets.example.test');
    await expect(service.deliverNext()).resolves.toBe('delivered');
    const [, sentSubject, body] = sendContent.mock.calls[0];
    expect(sentSubject).toBe(subject);
    expect(body).toContain(sentence);
    expect(body).toContain('https://tickets.example.test/#/client?filter=needs_client');
    expect(body).toContain('This email does not contain ticket details');
  });

  it('keeps a plain message or document notice generic when nothing is being asked of the client', async () => {
    for (const kind of ['message', 'document'] as const) {
      const sendContent = vi.fn(async (_to: string, _subject: string, _text: string, _key: string) => undefined);
      const service = createTicketCommunicationNotificationService(store({ claimNext: vi.fn(async () => ({ ...claim, kind })) }),
        provider(sendContent), 'https://tickets.example.test');
      await service.deliverNext();
      expect(sendContent.mock.calls[0][2]).toContain('https://tickets.example.test/#/client');
      expect(sendContent.mock.calls[0][2]).not.toContain('filter=needs_client');
    }
  });

  it('queues due notices with a one day freshness window and a three day reminder inside a two week limit', async () => {
    const queue = store({ enqueueDueActionNotices: vi.fn(async () => 2) });
    const service = createTicketCommunicationNotificationService(queue, provider(vi.fn()), 'https://tickets.example.test');
    await expect(service.enqueueDue(new Date('2026-10-20T00:00:00.000Z'))).resolves.toBe(2);
    expect(queue.enqueueDueActionNotices).toHaveBeenCalledWith({
      now: '2026-10-20T00:00:00.000Z', freshWithinMs: 86_400_000, reminderAfterMs: 259_200_000, reminderWithinMs: 1_209_600_000,
    });
  });

  it('sends a generic portal notification without ticket or message content', async () => {
    const queue = store();
    const sendContent = vi.fn(async (_recipient: string, _subject: string, _text: string, _key: string) => undefined);
    const service = createTicketCommunicationNotificationService(queue, {
      identity: 'ticket-communication-test-provider', canSendTo: () => true, send: async () => undefined, sendContent,
    }, 'https://tickets.example.test');

    await expect(service.deliverNext()).resolves.toBe('delivered');
    expect(sendContent).toHaveBeenCalledWith(
      claim.recipient,
      'A new message is waiting in your Alpha client portal',
      expect.stringContaining('Sign in to Alpha and open My Tickets'),
      'alpha-ticket-communication-notification-event-1',
    );
    const emailBody = sendContent.mock.calls[0][2];
    expect(emailBody).toContain('https://tickets.example.test/#/client');
    expect(emailBody).not.toContain('private ticket details');
    expect(queue.markDelivered).toHaveBeenCalledTimes(1);
  });

  it('retries transient provider failures and discards recipients outside the configured sender policy', async () => {
    const retryQueue = store();
    const failingService = createTicketCommunicationNotificationService(retryQueue, {
      identity: 'ticket-communication-test-provider', canSendTo: () => true, send: async () => undefined,
      async sendContent() { throw new Error('synthetic transient provider failure'); },
    }, 'https://tickets.example.test');
    await expect(failingService.deliverNext()).resolves.toBe('retry');
    expect(retryQueue.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(retryQueue.deadLetter).not.toHaveBeenCalled();

    const restrictedQueue = store();
    const sendContent = vi.fn(async () => undefined);
    const restrictedService = createTicketCommunicationNotificationService(restrictedQueue, {
      identity: 'ticket-communication-test-provider', canSendTo: () => false,
      send: async () => undefined, sendContent,
    }, 'https://tickets.example.test');
    await expect(restrictedService.deliverNext()).resolves.toBe('discarded');
    expect(restrictedQueue.discard).toHaveBeenCalledTimes(1);
    expect(sendContent).not.toHaveBeenCalled();
  });
});
