import { createHash } from 'node:crypto';
import { z } from 'zod';

const email = z.string().email().max(254);
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GmailEmailTransportError extends Error {
  constructor(readonly retryable: boolean) {
    // Provider responses and credentials may contain sensitive data. Never forward them.
    super('Gmail could not confirm the email delivery.');
    this.name = 'GmailEmailTransportError';
  }
}

export interface GmailEmailTransport {
  readonly identity: string;
  send(recipient: string, subject: string, text: string, deliveryKey: string): Promise<void>;
}

function encodedHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function encodedBody(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
}

async function retryableGmailFailure(response: Response): Promise<boolean> {
  if (response.status === 408 || response.status === 429 || response.status >= 500) return true;
  if (response.status !== 403) return false;
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('error' in body) || !body.error || typeof body.error !== 'object'
      || !('errors' in body.error) || !Array.isArray(body.error.errors)) return false;
    return body.error.errors.some((entry: unknown) => entry && typeof entry === 'object' && 'reason' in entry
      && (entry.reason === 'rateLimitExceeded' || entry.reason === 'userRateLimitExceeded'));
  } catch { return false; }
}

function rawMessage(senderEmail: string, senderName: string, recipient: string,
  subject: string, text: string, deliveryKey: string): string {
  const senderDomain = senderEmail.slice(senderEmail.lastIndexOf('@') + 1);
  const stableKey = createHash('sha256').update(deliveryKey).digest('hex');
  const mime = [
    `From: ${encodedHeader(senderName)} <${senderEmail}>`,
    `To: ${recipient}`,
    `Subject: ${encodedHeader(subject)}`,
    `Message-ID: <alpha-${stableKey}@${senderDomain}>`,
    `X-Alpha-Delivery-Key: ${stableKey}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody(text),
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** Uses the least-privilege Gmail send scope through a server-side OAuth refresh token. */
export function createGmailEmailTransport(config: {
  clientId: string; clientSecret: string; refreshToken: string; senderEmail: string; senderName: string;
}, send: typeof fetch = fetch, now: () => number = Date.now): GmailEmailTransport | null {
  if (![config.clientId, config.clientSecret, config.refreshToken].every(value => value.trim() && !/[\r\n]/.test(value))
    || !email.safeParse(config.senderEmail).success || !config.senderName.trim() || config.senderName.length > 100
    || /[\r\n]/.test(config.senderName)) return null;

  const senderEmail = config.senderEmail.trim().toLowerCase();
  const senderName = config.senderName.trim();
  const identity = createHash('sha256').update(JSON.stringify([
    'gmail-api-email-v1', senderEmail, senderName,
  ])).digest('hex');
  let accessToken = '';
  let expiresAt = 0;
  let refreshInFlight: Promise<string> | null = null;

  async function refreshAccessToken(force = false): Promise<string> {
    if (!force && accessToken && expiresAt > now() + 60_000) return accessToken;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const response = await send(GOOGLE_TOKEN_URL, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId, client_secret: config.clientSecret,
            refresh_token: config.refreshToken, grant_type: 'refresh_token',
          }),
        });
        if (!response.ok) throw new GmailEmailTransportError(response.status === 429 || response.status >= 500);
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('access_token' in body) || typeof body.access_token !== 'string'
          || !body.access_token.trim() || !('expires_in' in body) || typeof body.expires_in !== 'number'
          || !Number.isFinite(body.expires_in) || body.expires_in < 60) {
          throw new GmailEmailTransportError(true);
        }
        accessToken = body.access_token;
        expiresAt = now() + body.expires_in * 1000;
        return accessToken;
      } catch (error) {
        if (error instanceof GmailEmailTransportError) throw error;
        throw new GmailEmailTransportError(true);
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function sendMessage(token: string, recipient: string, subject: string, text: string, deliveryKey: string): Promise<Response> {
    return send(GMAIL_SEND_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ raw: rawMessage(senderEmail, senderName, recipient, subject, text, deliveryKey) }),
    });
  }

  return {
    identity,
    async send(recipientInput, subject, text, deliveryKey) {
      const recipient = recipientInput.trim().toLowerCase();
      if (!email.safeParse(recipient).success || typeof subject !== 'string' || !subject.trim()
        || subject.length > 200 || /[\r\n]/.test(subject) || typeof text !== 'string' || !text.trim()
        || text.length > 12_000 || typeof deliveryKey !== 'string' || !deliveryKey.trim()
        || deliveryKey.length > 256 || /[\r\n]/.test(deliveryKey)) throw new GmailEmailTransportError(false);
      try {
        let response = await sendMessage(await refreshAccessToken(), recipient, subject, text, deliveryKey);
        // A stale/revoked access token can be refreshed once; don't loop on account/scope errors.
        if (response.status === 401) {
          accessToken = '';
          expiresAt = 0;
          response = await sendMessage(await refreshAccessToken(true), recipient, subject, text, deliveryKey);
        }
        if (!response.ok) throw new GmailEmailTransportError(await retryableGmailFailure(response));
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string' || !body.id) {
          throw new GmailEmailTransportError(true);
        }
      } catch (error) {
        if (error instanceof GmailEmailTransportError) throw error;
        // Gmail has no send idempotency API; a network timeout can be ambiguous.
        // Retrying uses the same RFC Message-ID, but may still deliver a duplicate.
        throw new GmailEmailTransportError(true);
      }
    },
  };
}
