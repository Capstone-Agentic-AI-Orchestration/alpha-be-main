export interface TicketClientSessionRecord {
  /** SHA-256 of the high-entropy cookie value; never the raw cookie. */
  sessionIdHash: string;
  providerUserId: string;
  /** SHA-256 of the readable CSRF cookie; never the raw CSRF value. */
  csrfHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface TicketClientSessionAudit {
  providerUserId: string;
  type: 'client_session_created' | 'client_session_revoked';
  occurredAt: string;
}

export interface TicketClientSessionTransaction {
  /** True only for a previously activated client with an active service grant.
   * Serialize against grant revocation; never create/reactivate access here.
   */
  hasActiveClientServiceGrant(providerUserId: string): Promise<boolean>;
  /** Insert-only, unique hash. No client workspace membership is created. */
  insertSession(record: TicketClientSessionRecord): Promise<void>;
  /** Revoke only this exact session hash; repeated revocation returns false. */
  revokeSession(sessionIdHash: string, providerUserId: string, revokedAt: string): Promise<boolean>;
  appendAudit(audit: TicketClientSessionAudit): Promise<void>;
}

export interface TicketClientSessionStore {
  /** Fresh hash lookup. The adapter must not cache session or revocation state. */
  resolveSession(sessionIdHash: string): Promise<TicketClientSessionRecord | null>;
  /**
   * Grant check + session insert/audit or exact revocation/audit atomically.
   * Session/service-grant checks must use the shared authorization-first lock
   * order required by ticket commands; never acquire a ticket lock here.
   */
  transaction<T>(work: (tx: TicketClientSessionTransaction) => Promise<T>): Promise<T>;
}
