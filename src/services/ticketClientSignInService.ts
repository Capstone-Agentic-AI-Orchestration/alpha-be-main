import { randomUUID } from 'node:crypto';

import type { PostgresTicketClientSignInStore } from '../store/ticketClientSignInPostgresStore.js';
import type { TicketClientIdentityProvider } from './ticketClientIdentityProvider.js';
import type { TicketInvitationContentEmailProvider } from './ticketInvitationEmailProvider.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

function emailValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 254 || value.trim() !== value) return null;
  const normalized = value.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

/** No open signup: an email link is sent only to an active, already-invited client. */
export function createTicketClientSignInService(
  store: PostgresTicketClientSignInStore,
  identityProvider: TicketClientIdentityProvider,
  emailProvider: TicketInvitationContentEmailProvider,
  webOrigin: string,
  onDeliveryUnavailable: () => void = () => undefined,
) {
  const origin = new URL(webOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || typeof emailProvider.sendContent !== 'function') throw new Error('Client sign-in delivery is not configured.');

  return {
    async request(emailInput: unknown): Promise<{ accepted: true }> {
      const email = emailValue(emailInput);
      // Same public response for unknown emails and known non-client accounts.
      if (!email) return { accepted: true };
      const userId = await store.findActiveClientUserId(email);
      if (!userId) return { accepted: true };
      try {
        // A restricted sender must not consume/replace a provider link it cannot deliver.
        if (emailProvider.canSendTo && !emailProvider.canSendTo(email)) throw new Error();
        const generated = await identityProvider.generateEmailLink(email, 'magiclink');
        if (generated.userId !== userId || generated.type !== 'magiclink') throw new Error();
        const link = new URL('/', origin.origin);
        link.hash = `/client/activate?${new URLSearchParams({
          providerTokenHash: generated.tokenHash, providerTokenType: generated.type,
        }).toString()}`;
        const body = [
          'Use this secure, one-time link to sign in to your Alpha client portal:',
          link.toString(),
          'This link is for the client account associated with this email. It does not open Alpha’s desktop app or internal developer workspace.',
          'If you did not request this email, you can ignore it.',
        ].join('\n\n');
        await emailProvider.sendContent(email, 'Your Alpha client sign-in link', body, `client-sign-in:${randomUUID()}`);
      } catch {
        // Keep the public response indistinguishable from an unknown email.
        // The callback is deliberately generic and must not receive the address.
        try { onDeliveryUnavailable(); } catch { /* logging must not change the public auth response */ }
      }
      return { accepted: true };
    },
  };
}
