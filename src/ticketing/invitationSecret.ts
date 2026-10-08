import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface TicketInvitationSecretContext {
  workspaceId: string;
  ticketId: string;
  invitationId: string;
  expiresAt: string;
}

export interface TicketInvitationSecretProtector {
  /** Local authenticated encryption only; must not perform network I/O. */
  protect(token: string, context: TicketInvitationSecretContext): string;
  /** Decrypt only for the same tenant, ticket, invitation and expiry. */
  unprotect(envelope: string, context: TicketInvitationSecretContext): string;
}

export class TicketInvitationSecretError extends Error {
  constructor() {
    super('The invitation delivery secret is unavailable.');
    this.name = 'TicketInvitationSecretError';
  }
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;

function canonicalToken(value: unknown): value is string {
  if (typeof value !== 'string' || !tokenPattern.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === value;
}

function contextBytes(context: TicketInvitationSecretContext): Buffer {
  if (!context || !opaque(context.workspaceId) || !opaque(context.ticketId) || !opaque(context.invitationId)
    || typeof context.expiresAt !== 'string' || !Number.isFinite(Date.parse(context.expiresAt))
    || new Date(context.expiresAt).toISOString() !== context.expiresAt) throw new TicketInvitationSecretError();
  return Buffer.from(JSON.stringify([
    'alpha-ticket-invitation-v1', context.workspaceId, context.ticketId, context.invitationId, context.expiresAt,
  ]), 'utf8');
}

function decodeCanonical(value: string, bytes: number): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) throw new TicketInvitationSecretError();
  return decoded;
}

/** AES-256-GCM envelope for an outbox retry. Raw invitation tokens are never stored. */
export function createTicketInvitationSecretProtector(
  activeKeyId: string,
  configuredKeys: ReadonlyMap<string, Uint8Array>,
): TicketInvitationSecretProtector {
  if (!keyIdPattern.test(activeKeyId) || !configuredKeys || !Number.isSafeInteger(configuredKeys.size)
    || configuredKeys.size < 1 || typeof configuredKeys.entries !== 'function') {
    throw new TicketInvitationSecretError();
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, key] of configuredKeys) {
    if (!keyIdPattern.test(keyId) || !(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new TicketInvitationSecretError();
    }
    keys.set(keyId, Buffer.from(key));
  }
  if (!keys.has(activeKeyId)) throw new TicketInvitationSecretError();

  return {
    protect(token, context) {
      if (!canonicalToken(token)) throw new TicketInvitationSecretError();
      const key = keys.get(activeKeyId)!;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(contextBytes(context));
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${activeKeyId}.${nonce.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
    },
    unprotect(envelope, context) {
      try {
        if (typeof envelope !== 'string' || envelope.length > 512) throw new TicketInvitationSecretError();
        const parts = envelope.split('.');
        if (parts.length !== 5 || parts[0] !== 'v1' || !keyIdPattern.test(parts[1])) throw new TicketInvitationSecretError();
        const key = keys.get(parts[1]);
        if (!key) throw new TicketInvitationSecretError();
        const nonce = decodeCanonical(parts[2], 12);
        const tag = decodeCanonical(parts[3], 16);
        const ciphertext = decodeCanonical(parts[4], 43);
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(contextBytes(context));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        if (!canonicalToken(plaintext)) throw new TicketInvitationSecretError();
        return plaintext;
      } catch {
        // Authentication, key, context and payload failures intentionally look identical.
        throw new TicketInvitationSecretError();
      }
    },
  };
}
