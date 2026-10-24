import { describe, expect, it, vi } from 'vitest';
import { createBrevoTicketAcknowledgmentProvider, createGmailTicketAcknowledgmentProvider,
  createResendTicketAcknowledgmentProvider, createTicketAcknowledgmentEmailProvider,
  TicketAcknowledgmentEmailError } from './ticketAcknowledgmentEmailProvider.js';

const configuration = { apiKey: 'synthetic-key', senderEmail: 'sender@example.invalid', senderName: 'Alpha test' };
const gmailConfiguration = { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token',
  senderEmail: 'sender@example.invalid', senderName: 'Alpha test' };
const id = '00000000-0000-4000-8000-000000000001';

it('sends a general decline outcome with a reference and no internal PM note', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id }), { status: 200 }));
  const provider = createResendTicketAcknowledgmentProvider(configuration, send)!;
  const reference = `INQ-${'A'.repeat(32)}`;
  await provider.send('client@example.test', id, reference, 'declined');
  const body = JSON.parse(String(send.mock.calls[0][1]?.body));
  expect(body.subject).toContain('update');
  expect(body.text).toContain('will not be proceeding');
  expect(body.text).toContain(reference);
  expect(body.text).not.toContain('has been received');
});

describe('provider selection', () => {
  it('selects Gmail explicitly and has no silent fallback when Gmail OAuth is missing', () => {
    const selected = createTicketAcknowledgmentEmailProvider({ providerName: ' Gmail ', brevo: configuration, gmail: gmailConfiguration });
    expect(selected?.identity).toBe(createGmailTicketAcknowledgmentProvider(gmailConfiguration)?.identity);
    expect(createTicketAcknowledgmentEmailProvider({ providerName: 'gmail', brevo: configuration })).toBeNull();
  });
  it('selects Brevo without coupling queue processing to its configuration', () => {
    const selected = createTicketAcknowledgmentEmailProvider({ providerName: ' Brevo ', brevo: configuration });
    expect(selected?.identity).toBe(createBrevoTicketAcknowledgmentProvider(configuration)?.identity);
  });
  it('selects Resend explicitly without falling back to configured Brevo credentials', () => {
    const selected = createTicketAcknowledgmentEmailProvider({ providerName: ' Resend ', brevo: configuration, resend: configuration });
    expect(selected?.identity).toBe(createResendTicketAcknowledgmentProvider(configuration)?.identity);
    expect(selected?.identity).not.toBe(createBrevoTicketAcknowledgmentProvider(configuration)?.identity);
    expect(createTicketAcknowledgmentEmailProvider({ providerName: 'resend', brevo: configuration })).toBeNull();
    expect(createTicketAcknowledgmentEmailProvider({ providerName: 'resend', brevo: configuration,
      resend: { ...configuration, apiKey: '' } })).toBeNull();
  });
  it.each(['', 'unknown', 'smtp'])('never falls back to Brevo for unsupported provider %j', name => {
    const send = vi.fn<typeof fetch>();
    expect(createTicketAcknowledgmentEmailProvider({ providerName: name, brevo: configuration }, send)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps delivery unavailable when the selected provider is not configured', () => {
    expect(createTicketAcknowledgmentEmailProvider({ providerName: 'brevo', brevo: { ...configuration, apiKey: '' } })).toBeNull();
  });
});

describe('Gmail inquiry acknowledgment provider', () => {
  it('sends to the inquiry email through the Gmail API without adding extra scopes or recipient restrictions', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gmail-message-id' }), { status: 200 }));
    const provider = createGmailTicketAcknowledgmentProvider(gmailConfiguration, send)!;
    await expect(provider.send('client@example.invalid', id, 'INQ-0123456789ABCDEF0123456789ABCDEF')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const raw = JSON.parse(String(send.mock.calls[1][1]?.body)) as { raw: string };
    const message = Buffer.from(raw.raw, 'base64url').toString('utf8');
    expect(message).toContain('To: client@example.invalid');
    expect(Buffer.from(message.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString())
      .toContain('Your inquiry reference: INQ-0123456789ABCDEF0123456789ABCDEF');
    expect(provider.identity).not.toContain(gmailConfiguration.refreshToken);
  });

  it('does not relay provider failures or permit invalid inquiry references', async () => {
    const send = vi.fn<typeof fetch>();
    const provider = createGmailTicketAcknowledgmentProvider(gmailConfiguration, send)!;
    await expect(provider.send('client@example.invalid', id, 'invalid-reference'))
      .rejects.toEqual(new TicketAcknowledgmentEmailError(false));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Resend inquiry acknowledgment provider', () => {
  it.each([{ apiKey: '' }, { senderEmail: '' }, { senderEmail: 'not-email' }, { senderName: '' },
    { senderName: 'a'.repeat(101) }, { apiKey: 'injected\r\nheader' }, { senderName: 'injected\nheader' },
    { senderName: 'Alpha <other@example.invalid>' }, { testRecipient: 'not-email' },
    { senderEmail: 'onboarding@resend.dev' },
    { senderEmail: 'other@resend.dev', testRecipient: 'owner@example.invalid' }])('fails closed for invalid setup: %j', override => {
    expect(createResendTicketAcknowledgmentProvider({ ...configuration, ...override })).toBeNull();
  });

  it('sends a generic receipt with an HTTP idempotency header and stable identity', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ id }), { status: 200 }));
    const provider = createResendTicketAcknowledgmentProvider(configuration, send)!;
    await provider.send('client@example.invalid', id);
    await provider.send('client@example.invalid', id);
    const [url, options] = send.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      Authorization: 'Bearer synthetic-key', 'Idempotency-Key': id,
    } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(options!.body as string);
    expect(body).toMatchObject({ from: '"Alpha test" <sender@example.invalid>', to: ['client@example.invalid'] });
    expect(body.text).toContain('does not approve');
    expect(body).not.toHaveProperty('headers');
    expect(body).not.toHaveProperty('attachments');
    expect(send.mock.calls[1][1]?.body).toBe(options?.body);
    expect(send.mock.calls[1][1]?.headers).toEqual(options?.headers);
    expect(createResendTicketAcknowledgmentProvider({ ...configuration, apiKey: 'rotated' })!.identity).toBe(provider.identity);
    expect(createResendTicketAcknowledgmentProvider({ ...configuration, senderName: 'Changed' })!.identity).not.toBe(provider.identity);
    expect(createResendTicketAcknowledgmentProvider({ ...configuration, testRecipient: 'owner@example.invalid' })!.identity).not.toBe(provider.identity);
  });

  it('restricts the no-domain sender without redirecting other recipients', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id })));
    const provider = createResendTicketAcknowledgmentProvider({ ...configuration,
      senderEmail: 'onboarding@resend.dev', testRecipient: 'Owner@example.invalid' }, send)!;
    await expect(provider.send('other@example.invalid', id)).rejects.toMatchObject({ retryable: false });
    expect(send).not.toHaveBeenCalled();
    await provider.send('owner@example.invalid', id);
    expect(JSON.parse(send.mock.calls[0][1]!.body as string).to).toEqual(['owner@example.invalid']);
  });

  it('escapes quoted display names in the sender mailbox', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id })));
    await createResendTicketAcknowledgmentProvider({ ...configuration, senderName: 'Alpha "Team"' }, send)!.send('client@example.invalid', id);
    expect(JSON.parse(send.mock.calls[0][1]!.body as string).from).toBe('"Alpha \\"Team\\"" <sender@example.invalid>');
  });

  it.each([400, 401, 403, 422, 429, 500, 503])('classifies HTTP %i without leaking provider content', async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"message":"private-secret"}', { status }));
    await expect(createResendTicketAcknowledgmentProvider(configuration, send)!.send('client@example.invalid', id))
      .rejects.toEqual(new TicketAcknowledgmentEmailError(status === 429 || status >= 500));
  });

  it.each([['concurrent_idempotent_requests', true], ['invalid_idempotent_request', false], ['unknown', false]] as const)
    ('classifies conflict %s without claiming it was delivered', async (name, retryable) => {
      const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ name }), { status: 409 }));
      await expect(createResendTicketAcknowledgmentProvider(configuration, send)!.send('client@example.invalid', id))
        .rejects.toEqual(new TicketAcknowledgmentEmailError(retryable));
    });

  it.each(['{}', '{"id":""}', 'invalid-json'])('does not confirm an ambiguous success response: %s', async body => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    await expect(createResendTicketAcknowledgmentProvider(configuration, send)!.send('client@example.invalid', id))
      .rejects.toEqual(new TicketAcknowledgmentEmailError(true));
  });

  it('sanitizes a lost response and rejects invalid inputs before fetching', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('private network details'));
    const provider = createResendTicketAcknowledgmentProvider(configuration, send)!;
    await expect(provider.send('client@example.invalid\r\nBcc:other@example.invalid', id)).rejects.toMatchObject({ retryable: false });
    await expect(provider.send('client@example.invalid', 'not-a-uuid')).rejects.toMatchObject({ retryable: false });
    expect(send).not.toHaveBeenCalled();
    await expect(provider.send('client@example.invalid', id)).rejects.toEqual(new TicketAcknowledgmentEmailError(true));
  });
});

describe('Brevo inquiry acknowledgment provider', () => {
  it.each([{ apiKey: '' }, { senderEmail: '' }, { senderEmail: 'not-email' }, { senderName: '' },
    { apiKey: 'injected\r\nheader' }, { senderName: 'injected\nheader' }])('fails closed for invalid setup: %j', override => {
    expect(createBrevoTicketAcknowledgmentProvider({ ...configuration, ...override })).toBeNull();
  });
  it('sends only a generic receipt using HTTPS and a stable UUID key', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 201 }));
    const provider = createBrevoTicketAcknowledgmentProvider(configuration, send)!;
    await provider.send('client@example.invalid', id);
    const [url, options] = send.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'api-key': 'synthetic-key' } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(options!.body as string);
    expect(body).toMatchObject({ to: [{ email: 'client@example.invalid' }], headers: { idempotencyKey: id } });
    expect(body.textContent).toContain('does not approve');
    expect(body.textContent).not.toContain('http');
    expect(body).not.toHaveProperty('params');
    expect(body).not.toHaveProperty('attachment');
    expect(provider.identity).not.toContain('synthetic-key');
    expect(createBrevoTicketAcknowledgmentProvider({ ...configuration, apiKey: 'rotated' })!.identity).toBe(provider.identity);
    expect(createBrevoTicketAcknowledgmentProvider({ ...configuration, senderName: 'Changed' })!.identity).not.toBe(provider.identity);
  });
  it('accepts a provider-confirmed duplicate without generating a new key', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"code":"duplicate_parameter"}', { status: 400 }));
    await expect(createBrevoTicketAcknowledgmentProvider(configuration, send)!.send('client@example.invalid', id)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 429, 500, 503])('classifies HTTP %i without leaking provider content', async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"message":"private-secret-client@example.invalid"}', { status }));
    await expect(createBrevoTicketAcknowledgmentProvider(configuration, send)!.send('client@example.invalid', id))
      .rejects.toMatchObject({ retryable: status === 429 || status >= 500 });
    try { await createBrevoTicketAcknowledgmentProvider(configuration, send)!.send('client@example.invalid', id); }
    catch (error) { expect(String(error)).not.toContain('private-secret'); }
  });
  it('treats lost responses as uncertain, with a sanitized error', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('private server details'));
    await expect(createBrevoTicketAcknowledgmentProvider(configuration, send)!.send('client@example.invalid', id))
      .rejects.toEqual(new TicketAcknowledgmentEmailError(true));
  });
  it('rejects recipient/header injection before making a request', async () => {
    const send = vi.fn<typeof fetch>();
    const provider = createBrevoTicketAcknowledgmentProvider(configuration, send)!;
    await expect(provider.send('client@example.invalid\r\nBcc:other@example.invalid', id)).rejects.toMatchObject({ retryable: false });
    await expect(provider.send('client@example.invalid', 'not-a-uuid')).rejects.toMatchObject({ retryable: false });
    expect(send).not.toHaveBeenCalled();
  });
});
