import { describe, expect, it, vi } from 'vitest';

import { createTicketCommunicationNotificationService } from './ticketCommunicationNotificationService.js';
import type { TicketCommunicationNotificationClaim, TicketCommunicationNotificationStore } from '../store/ticketCommunicationNotificationStore.js';

const claim: TicketCommunicationNotificationClaim = {
  eventId: 'notification-event-1', leaseToken: 'opaque-lease-token', attempt: 1, kind: 'message',
  recipient: 'verified-client@example.test',
};

function store(overrides: Partial<TicketCommunicationNotificationStore> = {}) {
  return {
    claimNext: vi.fn(async () => claim),
    markDelivered: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    deadLetter: vi.fn(async () => true),
    discard: vi.fn(async () => true),
    ...overrides,
  } satisfies TicketCommunicationNotificationStore;
}

describe('Client ticket update email notifications', () => {
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
