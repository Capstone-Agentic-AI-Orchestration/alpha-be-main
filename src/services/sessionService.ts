import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ALPHA_SESSION_SECRET, SESSION_TTL_MS } from '../config/env.js';
import { database, type Sql } from '../store/database.js';
import { logError } from '../utils/logger.js';
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
 * Postgres, in `alpha_private.sessions` (migration 0007), out of the Data
 * API's reach. It was a SQLite file on Render's disk, which every deploy and
 * every free-tier spin-down replaced — so each of those signed everybody out.
 *
 * Only the cloud has sessions. The desktop's credential is `gh`, in the OS
 * keyring, and it never reads a session cookie.
 */

export interface Session {
  /** GitHub login. The identity everything else keys on. */
  login: string;
  name?: string;
  role: AlphaRole;
  /** Decrypted per request, never stored decrypted and never logged. */
  githubToken: string;
  expiresAt: string;
  /**
   * Server-only proof for sensitive ticket operations. Cookie sessions carry
   * the persisted hash id so a store can recheck revocation; a GitHub bearer
   * carries a request-scoped handle minted only after verification. Never
   * serialize this field or accept it from a request header/body.
   */
  ticketAuthentication:
    | { kind: 'session'; sessionId: string }
    | { kind: 'verified_github_bearer'; verificationId: string };
}

interface SessionRow {
  id: string;
  login: string;
  name: string | null;
  role: string;
  token_cipher: string;
  token_iv: string;
  token_tag: string;
  /** `timestamptz` arrives as a Date from `pg` and PGlite alike. */
  created_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string | null;
}

/**
 * How stale `last_seen_at` may get before a request refreshes it.
 *
 * Every API call resolves the session. Writing the column on each one doubled
 * the database round trips of every request, now that the database is across
 * a network rather than in the same process -- for a value nothing reads
 * except a person auditing who is active, to whom five minutes is nothing.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

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

function keyFrom(secret: string): Buffer {
  if (!secret) {
    throw new Error(
      'ALPHA_SESSION_SECRET is required to store GitHub tokens. ' +
        'Set it to a long random value in the server environment.'
    );
  }
  return createHash('sha256').update(secret).digest();
}

/** AES-256-GCM, so a tampered ciphertext fails to decrypt rather than decoding to garbage. */
function encrypt(plain: string, key: Buffer): { cipher: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const cipher = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return {
    cipher: cipher.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64')
  };
}

function decrypt(row: Pick<SessionRow, 'token_cipher' | 'token_iv' | 'token_tag'>, key: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(row.token_iv, 'base64'));
  d.setAuthTag(Buffer.from(row.token_tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(row.token_cipher, 'base64')), d.final()]).toString('utf8');
}

const iso = (value: Date | string): string => new Date(value).toISOString();

export interface SessionServiceOptions {
  /** Where the rows live. A function, so importing this module opens no connection. */
  sql: () => Sql;
  /** Defaults to ALPHA_SESSION_SECRET. */
  secret?: string;
  /** Defaults to SESSION_TTL_MS. */
  ttlMs?: number;
}

export class SessionService {
  constructor(private readonly options: SessionServiceOptions) {}

  private get sql(): Sql {
    return this.options.sql();
  }

  private key(): Buffer {
    return keyFrom(this.options.secret ?? ALPHA_SESSION_SECRET);
  }

  /**
   * Mint a session. Returns the raw cookie value, which is never stored and
   * cannot be recovered afterwards — only compared against.
   */
  async create(input: { login: string; name?: string; role: AlphaRole; githubToken: string }): Promise<{
    cookieValue: string;
    expiresAt: string;
  }> {
    const raw = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (this.options.ttlMs ?? SESSION_TTL_MS)).toISOString();
    const { cipher, iv, tag } = encrypt(input.githubToken, this.key());

    await this.sql.query(
      `insert into alpha_private.sessions
         (id, login, name, role, token_cipher, token_iv, token_tag, created_at, expires_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8)`,
      [hashToken(raw), input.login, input.name ?? null, input.role, cipher, iv, tag, now.toISOString(), expiresAt]
    );

    await this.sweep();
    return { cookieValue: raw, expiresAt };
  }

  /** The session behind a cookie value, or null when there is not a live one. */
  async resolve(cookieValue: string | undefined): Promise<Session | null> {
    if (!cookieValue) return null;
    const key = this.key();

    const { rows } = await this.sql.query<SessionRow>(
      'select * from alpha_private.sessions where id = $1',
      [hashToken(cookieValue)]
    );
    const row = rows[0];
    if (!row) return null;

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.remove(row.id);
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

    let githubToken: string;
    try {
      githubToken = decrypt(row, key);
    } catch {
      /**
       * A row this process cannot open: ALPHA_SESSION_SECRET has changed since
       * it was written, or the ciphertext was altered. It is useless to its
       * holder either way, so it answers "nobody" and is dropped.
       *
       * Throwing instead fails every request that carries the cookie, for as
       * long as the cookie lives: rotating the key would have meant a week of
       * errors for everyone signed in, with no way back short of clearing
       * cookies by hand. Now it signs them out, and signing in again works.
       */
      await this.remove(row.id);
      logError(`Dropped a session for ${row.login} that could not be decrypted; ALPHA_SESSION_SECRET may have changed.`);
      return null;
    }

    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeen >= TOUCH_INTERVAL_MS) {
      await this.sql.query('update alpha_private.sessions set last_seen_at = $1 where id = $2', [
        new Date().toISOString(),
        row.id
      ]);
    }

    return {
      login: row.login,
      name: row.name ?? undefined,
      role: row.role as AlphaRole,
      githubToken,
      expiresAt: iso(row.expires_at),
      ticketAuthentication: { kind: 'session', sessionId: row.id }
    };
  }

  /** Sign out. Idempotent: an unknown or already-revoked value is not an error. */
  async revoke(cookieValue: string | undefined): Promise<void> {
    if (!cookieValue) return;
    await this.remove(hashToken(cookieValue));
  }

  /** Every session for a login, for revoking access when someone leaves. */
  async revokeAllFor(login: string): Promise<number> {
    const { rows } = await this.sql.query('delete from alpha_private.sessions where login = $1 returning id', [login]);
    return rows.length;
  }

  /** Drop expired rows. Cheap, and called on create so it needs no scheduler. */
  async sweep(): Promise<number> {
    const { rows } = await this.sql.query('delete from alpha_private.sessions where expires_at <= $1 returning id', [
      new Date().toISOString()
    ]);
    return rows.length;
  }

  private async remove(id: string): Promise<void> {
    await this.sql.query('delete from alpha_private.sessions where id = $1', [id]);
  }
}

export const sessionService = new SessionService({ sql: database });
