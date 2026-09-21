import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ALPHA_SESSION_SECRET, DB_PATH, SESSION_TTL_MS } from '../config/env.js';
import type { AlphaRole } from './identityService.js';

/**
 * Browser sessions, for the hosted deployment.
 *
 * The daemon had no notion of a caller. `workspaceContext` asked
 * `currentIdentity()`, which is a process-global cached answer from the local
 * `gh` CLI — correct on a workstation, where one process serves one human, and
 * meaningless on Render, where one process serves everyone. Every request
 * resolved to the same identity, so the whole RBAC layer was gating on a
 * constant.
 *
 * This is the missing half. `githubRequestContext.ts` was written for it and
 * says so in its own comment — "populated by middleware once sessions exist" —
 * and has sat unused since.
 *
 * ## What a session holds, and why
 *
 * The GitHub token never reaches the browser. The browser gets an opaque
 * random id in an httpOnly cookie; the token stays here, encrypted, and is
 * replayed per request through `withGitHubIdentity()`. A cookie that leaks is
 * a revocable session. A token that leaks is the user's repositories.
 *
 * The role is resolved once at sign-in and cached on the row. Deriving it per
 * request would mean a GitHub team lookup on every API call — several hundred
 * milliseconds, on a service whose free tier already cold-starts.
 *
 * ## Storage
 *
 * SQLite today, because that is what the daemon has. On Render this means
 * sessions do not survive a deploy or a spin-down: everyone signs in again.
 * That is an inconvenience rather than a defect, and it disappears when the
 * Postgres store lands — this module is deliberately small so that move is a
 * driver swap rather than a rewrite.
 */

export interface Session {
  /** GitHub login. The identity everything else keys on. */
  login: string;
  name?: string;
  role: AlphaRole;
  /** Decrypted per request, never stored decrypted and never logged. */
  githubToken: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  login: string;
  name: string | null;
  role: string;
  token_cipher: string;
  token_iv: string;
  token_tag: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
}

/**
 * The stored id is a hash of the cookie value.
 *
 * Sessions are bearer credentials: whoever holds the cookie is the user. If
 * the table stored them verbatim, read access to the database would be enough
 * to impersonate every signed-in person — the same reason passwords are not
 * stored in the clear. A hash is enough to look a session up, and useless for
 * minting one.
 *
 * Unsalted SHA-256 deliberately. The input is 32 bytes of CSPRNG output, so
 * there is no dictionary to attack and nothing for a salt to defend against;
 * a slow KDF here would only add latency to every authenticated request.
 */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function encryptionKey(): Buffer {
  if (!ALPHA_SESSION_SECRET) {
    throw new Error(
      'ALPHA_SESSION_SECRET is required to store GitHub tokens. ' +
        'Set it to a long random value in the server environment.'
    );
  }
  return createHash('sha256').update(ALPHA_SESSION_SECRET).digest();
}

/** AES-256-GCM, so a tampered ciphertext fails to decrypt rather than decoding to garbage. */
function encrypt(plain: string): { cipher: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const cipher = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return {
    cipher: cipher.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64')
  };
}

function decrypt(row: Pick<SessionRow, 'token_cipher' | 'token_iv' | 'token_tag'>): string {
  const d = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.token_iv, 'base64'));
  d.setAuthTag(Buffer.from(row.token_tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(row.token_cipher, 'base64')), d.final()]).toString('utf8');
}

class SessionService {
  private db: Database.Database | null = null;

  /**
   * Opened on first use, not in a constructor.
   *
   * This module is imported by the cloud build, which must not open SQLite at
   * all — `workspaceRegistry` and `sqliteService` both open it from
   * module-level singletons, which is the pattern the store-driver work exists
   * to undo. Starting lazily keeps this file from adding a third.
   */
  private handle(): Database.Database {
    if (this.db) return this.db;
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL,
        token_cipher TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        token_tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_login ON sessions(login);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
    this.db = db;
    return db;
  }

  /**
   * Mint a session. Returns the raw cookie value, which is never stored and
   * cannot be recovered afterwards — only compared against.
   */
  create(input: { login: string; name?: string; role: AlphaRole; githubToken: string }): {
    cookieValue: string;
    expiresAt: string;
  } {
    const raw = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const { cipher, iv, tag } = encrypt(input.githubToken);

    this.handle()
      .prepare(
        `INSERT INTO sessions
           (id, login, name, role, token_cipher, token_iv, token_tag, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        hashToken(raw),
        input.login,
        input.name ?? null,
        input.role,
        cipher,
        iv,
        tag,
        now.toISOString(),
        expiresAt,
        now.toISOString()
      );

    this.sweep();
    return { cookieValue: raw, expiresAt };
  }

  /** The session behind a cookie value, or null when there is not a live one. */
  resolve(cookieValue: string | undefined): Session | null {
    if (!cookieValue) return null;

    const row = this.handle()
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(hashToken(cookieValue)) as SessionRow | undefined;
    if (!row) return null;

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.handle().prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return null;
    }

    /**
     * Compared rather than trusted.
     *
     * The lookup already matched on the hash, so this is belt-and-braces
     * against a future change that makes the lookup fuzzy — and it is constant
     * time, so it cannot be turned into an oracle for guessing ids.
     */
    const expected = Buffer.from(row.id, 'hex');
    const actual = Buffer.from(hashToken(cookieValue), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    this.handle()
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);

    return {
      login: row.login,
      name: row.name ?? undefined,
      role: row.role as AlphaRole,
      githubToken: decrypt(row),
      expiresAt: row.expires_at
    };
  }

  /** Sign out. Idempotent: an unknown or already-revoked value is not an error. */
  revoke(cookieValue: string | undefined): void {
    if (!cookieValue) return;
    this.handle().prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(cookieValue));
  }

  /** Every session for a login, for revoking access when someone leaves. */
  revokeAllFor(login: string): number {
    return this.handle().prepare('DELETE FROM sessions WHERE login = ?').run(login).changes;
  }

  /** Drop expired rows. Cheap, and called on create so it needs no scheduler. */
  sweep(): number {
    return this.handle()
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(new Date().toISOString()).changes;
  }

  /** For tests, which open and discard temporary databases. */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export const sessionService = new SessionService();
