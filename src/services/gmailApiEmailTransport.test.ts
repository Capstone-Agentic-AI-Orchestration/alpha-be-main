import { describe, expect, it, vi } from 'vitest';

import { createGmailEmailTransport, GmailEmailTransportError } from './gmailApiEmailTransport.js';

const config = {
  clientId: 'oauth-client-id', clientSecret: 'oauth-client-secret', refreshToken: 'oauth-refresh-token',
  senderEmail: 'sender@example.test', senderName: 'Alphaexplora',
};

function ok(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200 }); }

describe('Gmail OAuth email transport', () => {
  it('refreshes a server-side OAuth token and sends a base64url MIME message through Gmail', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ access_token: 'access-token', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'gmail-message-123' }));
    const transport = createGmailEmailTransport(config, send)!;
    await transport.send('Client@Example.test', 'Inquiry received', 'Your request was received.', 'delivery/1');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    const tokenRequest = send.mock.calls[0][1]!;
    const tokenBody = new URLSearchParams(String(tokenRequest.body));
    expect(tokenBody.get('client_id')).toBe(config.clientId);
    expect(tokenBody.get('client_secret')).toBe(config.clientSecret);
    expect(tokenBody.get('refresh_token')).toBe(config.refreshToken);
    expect(tokenBody.get('grant_type')).toBe('refresh_token');
    expect(send.mock.calls[1][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const gmailRequest = send.mock.calls[1][1]!;
    expect(new Headers(gmailRequest.headers).get('Authorization')).toBe('Bearer access-token');
    const payload = JSON.parse(String(gmailRequest.body)) as { raw: string };
    const message = Buffer.from(payload.raw, 'base64url').toString('utf8');
    expect(message).toContain('To: client@example.test');
    expect(message).toContain('From: =?UTF-8?B?QWxwaGFleHBsb3Jh?= <sender@example.test>');
    expect(message).toContain('Message-ID: <alpha-');
    expect(message).toContain('Subject: =?UTF-8?B?SW5xdWlyeSByZWNlaXZlZA==?=');
    expect(message).not.toMatch(/\nBcc:/i);
    const encodedBody = message.split('Content-Transfer-Encoding: base64\r\n\r\n')[1];
    expect(Buffer.from(encodedBody.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Your request was received.');
  });

  it('reuses a valid access token while keeping a stable delivery Message-ID', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ access_token: 'access-token', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'message-1' }))
      .mockResolvedValueOnce(ok({ id: 'message-2' }));
    const transport = createGmailEmailTransport(config, send)!;
    await transport.send('client@example.test', 'Subject', 'Body', 'stable-key');
    await transport.send('client@example.test', 'Subject', 'Body', 'stable-key');
    expect(send).toHaveBeenCalledTimes(3);
    const first = JSON.parse(String(send.mock.calls[1][1]?.body)) as { raw: string };
    const second = JSON.parse(String(send.mock.calls[2][1]?.body)) as { raw: string };
    const firstId = Buffer.from(first.raw, 'base64url').toString().match(/Message-ID: ([^\r\n]+)/)?.[1];
    const secondId = Buffer.from(second.raw, 'base64url').toString().match(/Message-ID: ([^\r\n]+)/)?.[1];
    expect(firstId).toBe(secondId);
  });

  it('refreshes an expired Gmail access token once after an authorization failure', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ access_token: 'old-token', expires_in: 3600 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(ok({ access_token: 'new-token', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'gmail-message-123' }));
    await createGmailEmailTransport(config, send)!.send('client@example.test', 'Subject', 'Body', 'key');
    expect(send).toHaveBeenCalledTimes(4);
    expect(new Headers(send.mock.calls[3][1]?.headers).get('Authorization')).toBe('Bearer new-token');
  });

  it('rejects incomplete settings and unsafe message headers before making requests', async () => {
    expect(createGmailEmailTransport({ ...config, refreshToken: '' })).toBeNull();
    const send = vi.fn<typeof fetch>();
    const transport = createGmailEmailTransport(config, send)!;
    await expect(transport.send('client@example.test', 'Subject\r\nBcc: attacker@example.test', 'Body', 'key'))
      .rejects.toEqual(new GmailEmailTransportError(false));
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { status: 403, body: 'private provider details', retryable: false },
    { status: 403, body: JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), retryable: true },
    { status: 403, body: JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }), retryable: false },
    { status: 429, body: 'private provider details', retryable: true },
    { status: 503, body: 'private provider details', retryable: true },
  ])
    ('classifies Gmail API status $status without exposing provider details', async ({ status, body, retryable }) => {
      const send = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(ok({ access_token: 'access-token', expires_in: 3600 }))
        .mockResolvedValueOnce(new Response(body, { status }));
      await expect(createGmailEmailTransport(config, send)!.send('client@example.test', 'Subject', 'Body', 'key'))
        .rejects.toEqual(new GmailEmailTransportError(retryable));
    });
});
