import { hkdfSync } from 'node:crypto';

import { createTicketInvitationSecretProtector } from './invitationSecret.js';
import { createTicketClientEmailLinkSecretProtector } from './clientEmailLinkSecret.js';

/** Purpose-separated keys derived from the existing server-only cloud secret. */
export function createClientTicketInvitationSecretProtector(sessionSecret: string) {
  if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) {
    throw new Error('Client invitation secrets are not configured.');
  }
  const keyId = 'session-derived-v1';
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret, 'utf8'),
    Buffer.from('alpha-ticketing-client-invitation-v1'), Buffer.from('outbox-invitation-token'), 32));
  return {
    invitation: createTicketInvitationSecretProtector(keyId, new Map([[keyId, key]])),
    providerLink: createTicketClientEmailLinkSecretProtector(sessionSecret),
  };
}
