import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

import type { VerifiedClientIdentity } from '../ticketing/clientActivation.js';
import type { TicketClientIdentityVerifier } from './ticketClientActivationService.js';

export type ClientEmailLinkType = 'invite' | 'magiclink';

export interface GeneratedClientEmailLink {
  userId: string;
  tokenHash: string;
  type: ClientEmailLinkType;
}

/**
 * Supabase Auth is used only to prove a client's email identity. Alpha's own
 * ticket grants remain the authorization boundary; neither token is exposed
 * to internal APIs or persisted in the browser.
 */
export class TicketClientIdentityProvider implements TicketClientIdentityVerifier {
  private readonly admin;
  private readonly verifier;

  constructor(private readonly url: string, private readonly anonKey: string, serviceRoleKey: string) {
    if (!/^https:\/\//.test(url) || !anonKey.trim() || !serviceRoleKey.trim()) {
      throw new Error('Client identity provider is not configured.');
    }
    const authOptions = {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      realtime: { transport: WebSocket as any },
    };
    this.admin = createClient(url, serviceRoleKey, authOptions);
    this.verifier = createClient(url, anonKey, authOptions);
  }

  async generateEmailLink(email: string, type: ClientEmailLinkType): Promise<GeneratedClientEmailLink> {
    const normalized = email.trim().toLowerCase();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error('Client identity provider could not generate the email link.');
    }
    let { data, error } = await this.admin.auth.admin.generateLink({ type, email: normalized });
    // An invited email may already have an Auth identity. In that case, give
    // it a one-time sign-in link; Alpha still grants only the original ticket
    // after the invitation token and verified email are both checked.
    if (error && type === 'invite') {
      const fallback = await this.admin.auth.admin.generateLink({ type: 'magiclink', email: normalized });
      data = fallback.data;
      error = fallback.error;
    }
    if (error || !data?.user?.id || !data.properties?.hashed_token
      || !['invite', 'magiclink'].includes(data.properties.verification_type)) {
      throw new Error('Client identity provider could not generate the email link.');
    }
    return {
      userId: data.user.id,
      tokenHash: data.properties.hashed_token,
      type: data.properties.verification_type as ClientEmailLinkType,
    };
  }

  private requestClient() {
    return createClient(this.url, this.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      realtime: { transport: WebSocket as any },
    });
  }

  async signInWithPassword(email: string, password: string): Promise<{ credential: string; identity: VerifiedClientIdentity } | null> {
    const { data, error } = await this.requestClient().auth.signInWithPassword({ email, password });
    if (error && (error.status === undefined || error.status >= 500)) throw new Error('Client authentication is unavailable.');
    if (error || !data.session?.access_token) return null;
    const credential = data.session.access_token;
    const identity = await this.verifyCredential(credential);
    return identity ? { credential, identity } : null;
  }

  /** Called only after the account application verifies a one-time setup/recovery proof. */
  async setPassword(credential: string, password: string): Promise<void> {
    const identity = await this.verifyCredential(credential);
    if (!identity?.emailVerified) throw new Error('Password setup is unavailable.');
    const { data, error } = await this.admin.auth.admin.updateUserById(identity.userId, { password });
    if (error || data.user?.id !== identity.userId || data.user.email?.toLowerCase() !== identity.email?.toLowerCase()) {
      throw new Error('Password setup is unavailable.');
    }
  }

  async generateRecoveryLink(email: string): Promise<{ userId: string; tokenHash: string }> {
    const { data, error } = await this.admin.auth.admin.generateLink({ type: 'recovery', email });
    if (error || !data.user?.id || !data.properties?.hashed_token || data.properties.verification_type !== 'recovery') {
      throw new Error('Password recovery is unavailable.');
    }
    return { userId: data.user.id, tokenHash: data.properties.hashed_token };
  }

  async verifyEmailLink(tokenHash: string, type: ClientEmailLinkType | 'recovery'): Promise<{ credential: string; identity: VerifiedClientIdentity } | null> {
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(tokenHash) || !['invite', 'magiclink', 'recovery'].includes(type)) return null;
    try {
      // OTP verification changes provider session state; isolate it per request.
      const { data, error } = await this.requestClient().auth.verifyOtp({ token_hash: tokenHash, type });
      const credential = data.session?.access_token;
      if (error || typeof credential !== 'string' || !credential || credential.length > 8192) return null;
      const identity = await this.verifyCredential(credential);
      return identity ? { credential, identity } : null;
    } catch {
      // Provider/network errors are not safe for the general API error path.
      // The caller can offer a fresh one-time link without exposing details.
      return null;
    }
  }

  async verifyCredential(credential: string): Promise<VerifiedClientIdentity | null> {
    if (typeof credential !== 'string' || credential.length > 8192 || !credential.trim()) return null;
    const { data, error } = await this.verifier.auth.getUser(credential);
    const user = data.user;
    if (error || !user || typeof user.id !== 'string' || !user.id.trim()
      || typeof user.email !== 'string' || !user.email.trim()) return null;
    return {
      userId: user.id,
      email: user.email,
      emailVerified: Boolean(user.email_confirmed_at),
    };
  }

  async getVerifiedEmail(userId: string): Promise<string | null> {
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 200 || userId.trim() !== userId) return null;
    try {
      const { data, error } = await this.admin.auth.admin.getUserById(userId);
      const user = data.user;
      const email = typeof user?.email === 'string' ? user.email.trim() : '';
      if (error || user?.id !== userId || !user.email_confirmed_at
        || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
      return email;
    } catch {
      return null;
    }
  }
}
