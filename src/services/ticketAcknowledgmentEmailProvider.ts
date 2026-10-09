import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ACKNOWLEDGMENT_SUBJECT = 'Alpha has received your inquiry';
export const ACKNOWLEDGMENT_TEXT = [
  'Your inquiry has been received. A project manager will review it.',
  'This acknowledgment does not approve the requested work, create an account, or grant project access.',
  'You do not need to download the Alpha desktop app.',
  'If you did not submit an inquiry, you can ignore this email.',
].join('\n\n');

export class TicketAcknowledgmentEmailError extends Error {
  constructor(readonly retryable: boolean) {
    // Never include provider bodies, credentials, recipient addresses or fetch errors.
    super('The acknowledgment email could not be confirmed by the provider.');
    this.name = 'TicketAcknowledgmentEmailError';
  }
}

export interface TicketAcknowledgmentEmailProvider {
  // Include provider + sender + content version in identity. Never migrate an
  // uncertain in-flight send to another provider: their dedupe stores differ.
  readonly identity: string;
  // Adapters must support the same UUID key and identical-request deduplication
  // for at least the queue's ten-minute retry window. Verify before adding one.
  send(recipient: string, idempotencyKey: string): Promise<void>;
}

export interface TicketAcknowledgmentProviderConfiguration {
  providerName: string;
  brevo: { apiKey: string; senderEmail: string; senderName: string };
  resend?: { apiKey: string; senderEmail: string; senderName: string; testRecipient?: string };
}

/** Only implemented, reviewed providers can send. No fallback on setup errors. */
export function createTicketAcknowledgmentEmailProvider(
  config: TicketAcknowledgmentProviderConfiguration, send: typeof fetch = fetch,
): TicketAcknowledgmentEmailProvider | null {
  switch (config.providerName.trim().toLowerCase()) {
    case 'resend': return config.resend ? createResendTicketAcknowledgmentProvider(config.resend, send) : null;
    case 'brevo': return createBrevoTicketAcknowledgmentProvider(config.brevo, send);
    default: return null;
  }
}

const email = z.string().email().max(254);
const uuid = z.string().uuid();

/** The default resend.dev sender is restricted to the Resend account's email. */
export function createResendTicketAcknowledgmentProvider(config: {
  apiKey: string; senderEmail: string; senderName: string; testRecipient?: string;
}, send: typeof fetch = fetch): TicketAcknowledgmentEmailProvider | null {
  const restrictedRecipient = (config.testRecipient || '').trim().toLowerCase();
  const defaultDomain = config.senderEmail.split('@')[1]?.toLowerCase() === 'resend.dev';
  if (!config.apiKey.trim() || /[\r\n]/.test(config.apiKey)
    || !email.safeParse(config.senderEmail).success || !config.senderName.trim()
    || config.senderName.length > 100 || /[\r\n<>]/.test(config.senderName)
    || (restrictedRecipient && !email.safeParse(restrictedRecipient).success)
    || (defaultDomain && (config.senderEmail !== 'onboarding@resend.dev' || !restrictedRecipient))) return null;

  const from = `"${config.senderName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${config.senderEmail}>`;
  return {
    identity: createHash('sha256').update(JSON.stringify([
      'resend-ack-v1', from, restrictedRecipient, ACKNOWLEDGMENT_SUBJECT, ACKNOWLEDGMENT_TEXT,
    ])).digest('hex'),
    async send(recipient, idempotencyKey) {
      // Never redirect somebody else's inquiry receipt to the account owner's inbox.
      if (!email.safeParse(recipient).success || !uuid.safeParse(idempotencyKey).success
        || (restrictedRecipient && recipient.toLowerCase() !== restrictedRecipient)) {
        throw new TicketAcknowledgmentEmailError(false);
      }
      try {
        const response = await send('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { accept: 'application/json', 'content-type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`, 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ from, to: [recipient], subject: ACKNOWLEDGMENT_SUBJECT, text: ACKNOWLEDGMENT_TEXT }),
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (body && typeof body === 'object' && 'id' in body && uuid.safeParse(body.id).success) return;
          // Unknown acceptance: retry only with the same persisted key and body.
          throw new TicketAcknowledgmentEmailError(true);
        }
        if (response.status === 409) {
          const body: unknown = await response.json().catch(() => null);
          // Concurrent processing is retryable; changed payloads must not be replayed.
          throw new TicketAcknowledgmentEmailError(Boolean(body && typeof body === 'object'
            && 'name' in body && body.name === 'concurrent_idempotent_requests'));
        }
        throw new TicketAcknowledgmentEmailError(response.status === 429 || response.status >= 500);
      } catch (error) {
        if (error instanceof TicketAcknowledgmentEmailError) throw error;
        throw new TicketAcknowledgmentEmailError(true);
      }
    },
  };
}

/** HTTPS only; no SDK/dependencies or SMTP credentials added to desktop builds. */
export function createBrevoTicketAcknowledgmentProvider(config: {
  apiKey: string; senderEmail: string; senderName: string;
}, send: typeof fetch = fetch): TicketAcknowledgmentEmailProvider | null {
  if (!config.apiKey.trim() || /[\r\n]/.test(config.apiKey)
    || !email.safeParse(config.senderEmail).success || !config.senderName.trim()
    || config.senderName.length > 100 || /[\r\n]/.test(config.senderName)) return null;

  return {
    // A configuration change must not alter the body/sender of a pending retry.
    // Do not include the API key: key rotation doesn't change the email itself.
    identity: createHash('sha256').update(JSON.stringify([
      'brevo-ack-v1', config.senderEmail, config.senderName, ACKNOWLEDGMENT_SUBJECT, ACKNOWLEDGMENT_TEXT,
    ])).digest('hex'),
    async send(recipient, idempotencyKey) {
      if (!email.safeParse(recipient).success || !uuid.safeParse(idempotencyKey).success) {
        throw new TicketAcknowledgmentEmailError(false);
      }
      try {
        const response = await send('https://api.brevo.com/v3/smtp/email', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': config.apiKey },
          body: JSON.stringify({
            sender: { email: config.senderEmail, name: config.senderName },
            to: [{ email: recipient }], subject: ACKNOWLEDGMENT_SUBJECT,
            textContent: ACKNOWLEDGMENT_TEXT, headers: { idempotencyKey },
          }),
        });
        if (response.status === 201) return; // Accepted by Brevo, not proof of inbox delivery.
        if (response.status === 400) {
          const body: unknown = await response.json();
          if (body && typeof body === 'object' && 'code' in body && body.code === 'duplicate_parameter') return;
        }
        throw new TicketAcknowledgmentEmailError(response.status === 429 || response.status >= 500);
      } catch (error) {
        if (error instanceof TicketAcknowledgmentEmailError) throw error;
        // Network/timeouts can mean accepted-but-unacknowledged. The persisted
        // dispatch window and stable key bound retries; never create a new key.
        throw new TicketAcknowledgmentEmailError(true);
      }
    },
  };
}
