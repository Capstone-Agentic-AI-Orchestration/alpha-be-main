import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { TicketInvitationSecretContext } from './invitationSecret.js';

export interface TicketClientEmailLinkSecretProtector {
  protect(value: string, context: TicketInvitationSecretContext): string;
  unprotect(envelope: string, context: TicketInvitationSecretContext): string;
}

const validContext = (context: TicketInvitationSecretContext): boolean => Boolean(context
  && [context.workspaceId, context.ticketId, context.invitationId].every(value => typeof value === 'string'
    && value.length > 0 && value.length <= 200 && value.trim() === value)
  && typeof context.expiresAt === 'string' && Number.isFinite(Date.parse(context.expiresAt))
  && new Date(context.expiresAt).toISOString() === context.expiresAt);

function aad(context: TicketInvitationSecretContext): Buffer {
  if (!validContext(context)) throw new Error('Client email link is unavailable.');
  return Buffer.from(JSON.stringify([
    'alpha-client-email-link-v1', context.workspaceId, context.ticketId, context.invitationId, context.expiresAt,
  ]));
}

/** Encrypts Supabase's one-time token hash for bounded outbox retries. */
export function createTicketClientEmailLinkSecretProtector(secret: string): TicketClientEmailLinkSecretProtector {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Client email link encryption is not configured.');
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'),
    Buffer.from('alpha-ticketing-client-auth-v1'), Buffer.from('provider-email-link-token-hash'), 32));
  const valuePattern = /^[A-Za-z0-9_-]{20,256}$/;
  return {
    protect(value, context) {
      if (!valuePattern.test(value)) throw new Error('Client email link is unavailable.');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `v1.${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
    },
    unprotect(envelope, context) {
      try {
        if (typeof envelope !== 'string' || envelope.length > 2048) throw new Error();
        const parts = envelope.split('.');
        if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
        const nonce = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const ciphertext = Buffer.from(parts[3], 'base64url');
        if (nonce.length !== 12 || nonce.toString('base64url') !== parts[1]
          || tag.length !== 16 || tag.toString('base64url') !== parts[2]
          || ciphertext.length < 20 || ciphertext.length > 256 || ciphertext.toString('base64url') !== parts[3]) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad(context));
        decipher.setAuthTag(tag);
        const value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        if (!valuePattern.test(value)) throw new Error();
        return value;
      } catch {
        throw new Error('Client email link is unavailable.');
      }
    },
  };
}
