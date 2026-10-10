import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TICKET_INVITATION_EMAIL_SUBJECT = 'An invitation to continue your Alpha inquiry';
export const TICKET_INVITATION_EMAIL_TEXT = [
  'A project manager has reviewed your inquiry and would like to continue the conversation with you.',
  'Client portal access is not active yet. This email does not create an account or grant access to a project.',
  'If secure client access becomes available, Alpha will send you separate instructions.',
  'If you did not submit an inquiry, you can ignore this email.',
].join('\n\n');

export class TicketInvitationEmailError extends Error {
  constructor(readonly retryable: boolean) {
    // Do not expose provider response bodies, recipients, credentials, or fetch errors.
    super('The invitation email could not be confirmed by the provider.');
    this.name = 'TicketInvitationEmailError';
  }
}

export interface TicketInvitationEmailProvider {
  /** Stable hash of provider, sender and fixed message content; never includes the API key. */
  readonly identity: string;
  send(recipient: string, idempotencyKey: string): Promise<void>;
}

/** Provider interface required by the Phase 4 activation and sign-in emails. */
export interface TicketInvitationContentEmailProvider extends TicketInvitationEmailProvider {
  /** Dynamic, server-authored email; never accepts browser HTML. */
  sendContent(recipient: string, subject: string, text: string, idempotencyKey: string): Promise<void>;
}

/** Uses the existing Resend settings; no new Render variables are required. */
export function createTicketInvitationEmailProvider(config: {
  apiKey: string; senderEmail: string; senderName: string; testRecipient?: string;
}, send: typeof fetch = fetch): TicketInvitationContentEmailProvider | null {
  const email = z.string().email().max(254);
  const restrictedRecipient = (config.testRecipient || '').trim().toLowerCase();
  const defaultDomain = config.senderEmail.split('@')[1]?.toLowerCase() === 'resend.dev';
  if (!config.apiKey.trim() || /[\r\n]/.test(config.apiKey)
    || !email.safeParse(config.senderEmail).success || !config.senderName.trim()
    || config.senderName.length > 100 || /[\r\n<>]/.test(config.senderName)
    || (restrictedRecipient && !email.safeParse(restrictedRecipient).success)
    || (defaultDomain && (config.senderEmail !== 'onboarding@resend.dev' || !restrictedRecipient))) return null;

  const from = `"${config.senderName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${config.senderEmail}>`;
  const identity = createHash('sha256').update(JSON.stringify([
    'resend-ticket-invitation-v1', from, restrictedRecipient,
    TICKET_INVITATION_EMAIL_SUBJECT, TICKET_INVITATION_EMAIL_TEXT,
  ])).digest('hex');

  const sendContent = async (recipient: string, subject: string, text: string, idempotencyKey: string): Promise<void> => {
      const normalizedRecipient = recipient.trim().toLowerCase();
      if (!email.safeParse(normalizedRecipient).success || idempotencyKey.length < 1 || idempotencyKey.length > 256
        || /[\r\n]/.test(idempotencyKey)
        || typeof subject !== 'string' || !subject.trim() || subject.length > 200 || /[\r\n]/.test(subject)
        || typeof text !== 'string' || !text.trim() || text.length > 12_000
        || (restrictedRecipient && normalizedRecipient !== restrictedRecipient)) {
        throw new TicketInvitationEmailError(false);
      }
      try {
        const response = await send('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { accept: 'application/json', 'content-type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`, 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ from, to: [normalizedRecipient],
            subject, text }),
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (body && typeof body === 'object' && 'id' in body && emailId.safeParse(body.id).success) return;
          throw new TicketInvitationEmailError(true);
        }
        if (response.status === 409) {
          const body: unknown = await response.json().catch(() => null);
          throw new TicketInvitationEmailError(Boolean(body && typeof body === 'object'
            && 'name' in body && body.name === 'concurrent_idempotent_requests'));
        }
        throw new TicketInvitationEmailError(response.status === 429 || response.status >= 500);
      } catch (error) {
        if (error instanceof TicketInvitationEmailError) throw error;
        throw new TicketInvitationEmailError(true);
      }
  };

  return {
    identity,
    send: (recipient, idempotencyKey) => sendContent(
      recipient, TICKET_INVITATION_EMAIL_SUBJECT, TICKET_INVITATION_EMAIL_TEXT, idempotencyKey,
    ),
    sendContent,
  };
}

const emailId = z.string().uuid();
