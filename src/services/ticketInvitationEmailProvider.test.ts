import { describe, expect, it, vi } from 'vitest';

import {
  createTicketInvitationEmailProvider, TicketInvitationEmailError,
  TICKET_INVITATION_EMAIL_SUBJECT, TICKET_INVITATION_EMAIL_TEXT,
} from './ticketInvitationEmailProvider.js';

const config = { apiKey: 'test-key', senderEmail: 'onboarding@resend.dev', senderName: 'Alpha',
  testRecipient: 'approved@example.test' };
const emailId = '2bd5f42c-1a8e-4bd4-afc5-b2a01b055f88';

describe('ticket invitation email provider', () => {
  it('requires existing Resend settings and a fixed recipient for the Resend test sender', () => {
    expect(createTicketInvitationEmailProvider({ ...config, apiKey: '' })).toBeNull();
    expect(createTicketInvitationEmailProvider({ ...config, testRecipient: '' })).toBeNull();
  });

  it('sends only to the configured test recipient with a stable idempotency key', async () => {
    const send = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify({ id: emailId }), { status: 200 }));
    const provider = createTicketInvitationEmailProvider(config, send as typeof fetch)!;
    await provider.send('APPROVED@example.test', 'client-invitation/delivery-1');
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('client-invitation/delivery-1');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      to: ['approved@example.test'], subject: TICKET_INVITATION_EMAIL_SUBJECT,
      text: TICKET_INVITATION_EMAIL_TEXT,
    });
  });

  it('sends server-authored dynamic activation content through the same guarded Resend transport', async () => {
    const send = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify({ id: emailId }), { status: 200 }));
    const provider = createTicketInvitationEmailProvider(config, send as typeof fetch)!;
    await provider.sendContent('approved@example.test', 'Activate Alpha access', 'One-time link: https://example.test', 'activation-1');
    expect(send).toHaveBeenCalledOnce();
    const init = send.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      to: ['approved@example.test'], subject: 'Activate Alpha access', text: 'One-time link: https://example.test',
    });
  });

  it('refuses a non-test recipient before calling Resend', async () => {
    const send = vi.fn();
    const provider = createTicketInvitationEmailProvider(config, send as typeof fetch)!;
    await expect(provider.send('client@example.test', 'client-invitation/delivery-2'))
      .rejects.toMatchObject({ retryable: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('preflights the recipient restriction without sending email or exposing its address', () => {
    const send = vi.fn();
    const provider = createTicketInvitationEmailProvider(config, send as typeof fetch)!;
    expect(provider.canSendTo!(' APPROVED@example.test ')).toBe(true);
    expect(provider.canSendTo!('client@example.test')).toBe(false);
    expect(provider.canSendTo!('invalid-address')).toBe(false);
    expect(provider).not.toHaveProperty('testRecipient');
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts other valid recipients only when the verified sender has no test restriction', () => {
    const provider = createTicketInvitationEmailProvider({
      ...config, senderEmail: 'support@alpha.example', testRecipient: '',
    }, vi.fn() as typeof fetch)!;
    expect(provider.canSendTo!('client@example.test')).toBe(true);
    expect(provider.canSendTo!('invalid-address')).toBe(false);
  });

  it('retries provider timeouts and concurrent idempotent requests, but not invalid requests', async () => {
    const timeout = createTicketInvitationEmailProvider(config, vi.fn(async () => { throw new Error('network'); }) as typeof fetch)!;
    await expect(timeout.send('approved@example.test', 'key')).rejects.toBeInstanceOf(TicketInvitationEmailError);
    await expect(timeout.send('approved@example.test', 'key')).rejects.toMatchObject({ retryable: true });

    const concurrent = createTicketInvitationEmailProvider(config, vi.fn(async () => new Response(
      JSON.stringify({ name: 'concurrent_idempotent_requests' }), { status: 409 },
    )) as typeof fetch)!;
    await expect(concurrent.send('approved@example.test', 'key')).rejects.toMatchObject({ retryable: true });

    const changed = createTicketInvitationEmailProvider(config, vi.fn(async () => new Response(
      JSON.stringify({ name: 'invalid_idempotent_request' }), { status: 409 },
    )) as typeof fetch)!;
    await expect(changed.send('approved@example.test', 'key')).rejects.toMatchObject({ retryable: false });
  });
});
