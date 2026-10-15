import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Purpose-separated encryption for short-lived setup proofs, never passwords. */
export function clientAccountProof(secret: string) {
  if (secret.length < 32) throw new Error('Client account encryption is unavailable.');
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('alpha-client-account-v1'), Buffer.from('setup-proof'), 32));
  return {
    seal(value: unknown, context: string): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [nonce, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
    },
    open(value: string, context: string): unknown {
      if (value.length > 24000) throw new Error('Account setup is unavailable.');
      const parts = value.split('.');
      if (parts.length !== 3) throw new Error('Account setup is unavailable.');
      const [nonce, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url'));
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('Account setup is unavailable.');
      const cipher = createDecipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8'));
    },
  };
}
