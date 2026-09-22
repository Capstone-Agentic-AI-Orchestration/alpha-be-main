import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import { SessionService } from './sessionService.js';

/**
 * What a session is allowed to leak, and what it must not.
 *
 * A session row holds a `repo`-scoped GitHub token. The threat this file keeps
 * honest is not "can someone sign in" but "what does an attacker get from the
 * database alone" — a leaked backup, a stolen connection string, a table
 * someone exposes by mistake. The answers that matter: not a usable cookie,
 * and not a usable token.
 *
 * Against the real migrations, in PGlite, so the table these statements name
 * is the one 0007 creates.
 */

const SECRET = 'a-long-random-test-secret-value';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('truncate alpha_private.sessions');
});

function service(options: { secret?: string; ttlMs?: number } = {}) {
  return new SessionService({ sql: () => sqlFor(db), secret: SECRET, ...options });
}

/** The rows as they sit in the table, read the way an attacker with the database would. */
async function rawRows(): Promise<any[]> {
  return (await db.query('select * from alpha_private.sessions')).rows;
}

describe('sessions', () => {
  it('round-trips a signed-in user', async () => {
    const svc = service();
    const { cookieValue } = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });

    const session = await svc.resolve(cookieValue);
    expect(session?.login).toBe('LloydLim1');
    expect(session?.role).toBe('pm');
    expect(session?.githubToken).toBe('gho_secret');
  });

  /** The reason they moved: Render replaces the process on every deploy. */
  it('survives the process that created it', async () => {
    const { cookieValue } = await service().create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });

    const afterRestart = service();
    expect((await afterRestart.resolve(cookieValue))?.login).toBe('LloydLim1');
  });

  it('does not resolve a value it never issued', async () => {
    const svc = service();
    await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });
    expect(await svc.resolve('not-a-real-session')).toBeNull();
    expect(await svc.resolve(undefined)).toBeNull();
  });

  /**
   * The cookie is a bearer credential: holding it *is* being the user. Storing
   * it verbatim would make read access to the database enough to impersonate
   * everyone signed in, which is the reason passwords are not stored either.
   */
  it('stores a hash, so the database cannot mint a cookie', async () => {
    const { cookieValue } = await service().create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });

    const [row] = await rawRows();
    expect(row.id).not.toBe(cookieValue);
    expect(JSON.stringify(row)).not.toContain(cookieValue);
  });

  /**
   * The token is the valuable half. A cookie that leaks is one revocable
   * session; a token that leaks is every private repository the user can read
   * and write, and it keeps working after they sign out of Alpha.
   */
  it('encrypts the github token at rest', async () => {
    await service().create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_verysecret' });

    const [row] = await rawRows();
    expect(JSON.stringify(row)).not.toContain('gho_verysecret');
    expect(row.token_cipher).toBeTruthy();
    expect(row.token_iv).toBeTruthy();
    expect(row.token_tag).toBeTruthy();
  });

  /**
   * After the key is rotated, old sessions are dead -- and signed out, not
   * broken. A throw here would fail every request carrying the cookie until
   * it expired, with no way back but clearing cookies by hand.
   */
  it('signs out a session written under another secret, without revealing the token', async () => {
    const { cookieValue } = await service({ secret: 'secret-number-one-aaaaaaaaaaaaaaa' }).create({
      login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret'
    });

    expect(await service({ secret: 'secret-number-two-bbbbbbbbbbbbbbb' }).resolve(cookieValue)).toBeNull();
    expect(await rawRows()).toHaveLength(0);
  });

  /** GCM authenticates as well as encrypts: a tampered row fails, not decodes. */
  it('refuses a tampered ciphertext rather than returning garbage', async () => {
    const svc = service();
    const { cookieValue } = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });

    const [row] = await rawRows();
    const flipped = Buffer.from(row.token_cipher, 'base64');
    flipped[0] ^= 0xff;
    await db.query('update alpha_private.sessions set token_cipher = $1 where id = $2', [
      flipped.toString('base64'),
      row.id
    ]);

    expect(await svc.resolve(cookieValue)).toBeNull();
  });

  it('stops resolving an expired session and drops the row', async () => {
    const svc = service({ ttlMs: -1000 });
    const { cookieValue } = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });

    expect(await svc.resolve(cookieValue)).toBeNull();
    expect(await rawRows()).toHaveLength(0);
  });

  it('revokes on sign-out, and tolerates signing out twice', async () => {
    const svc = service();
    const { cookieValue } = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });

    await svc.revoke(cookieValue);
    expect(await svc.resolve(cookieValue)).toBeNull();
    await expect(svc.revoke(cookieValue)).resolves.toBeUndefined();
  });

  /** For removing someone who has left: every device, not just this one. */
  it('revokes every session a login holds', async () => {
    const svc = service();
    const a = await svc.create({ login: 'Zane', role: 'dev', githubToken: 't1' });
    const b = await svc.create({ login: 'Zane', role: 'dev', githubToken: 't2' });
    const other = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 't3' });

    expect(await svc.revokeAllFor('Zane')).toBe(2);
    expect(await svc.resolve(a.cookieValue)).toBeNull();
    expect(await svc.resolve(b.cookieValue)).toBeNull();
    expect((await svc.resolve(other.cookieValue))?.login).toBe('LloydLim1');
  });

  it('issues a different cookie for every session', async () => {
    const svc = service();
    const a = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 't' });
    const b = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 't' });
    expect(a.cookieValue).not.toBe(b.cookieValue);
  });

  it('refuses to store a token with no encryption key configured', async () => {
    await expect(
      service({ secret: '' }).create({ login: 'x', role: 'pm', githubToken: 't' })
    ).rejects.toThrow(/ALPHA_SESSION_SECRET/);
  });

  /** A write per request would double every request's database round trips. */
  it('refreshes last-seen only when it has gone stale', async () => {
    const svc = service();
    const { cookieValue } = await svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 't' });
    const lastSeen = async () => new Date((await rawRows())[0].last_seen_at).getTime();

    const justCreated = await lastSeen();
    await svc.resolve(cookieValue);
    expect(await lastSeen()).toBe(justCreated);

    await db.exec(`update alpha_private.sessions set last_seen_at = now() - interval '1 hour'`);
    const stale = await lastSeen();
    await svc.resolve(cookieValue);
    expect(await lastSeen()).toBeGreaterThan(stale);
  });
});

/**
 * The rows are the server's alone.
 *
 * The anon key ships in the web bundle, and every signed-in user holds a
 * database token. If either could read this table, "who is signed in, and
 * since when" would be public -- and the encryption would be the only thing
 * left standing between a stolen secret and every token.
 */
describe('the Data API roles', () => {
  for (const role of ['anon', 'authenticated'] as const) {
    it(`gives ${role} no way to read or write a session`, async () => {
      await service().create({ login: 'LloydLim1', role: 'pm', githubToken: 't' });

      await db.exec(`set role ${role}`);
      try {
        await expect(db.query('select * from alpha_private.sessions')).rejects.toThrow(/permission denied/);
        await expect(
          db.query(`insert into alpha_private.sessions (id, login, role, token_cipher, token_iv, token_tag, expires_at)
                    values ('x', 'y', 'admin', 'c', 'i', 't', now() + interval '1 day')`)
        ).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec('reset role');
      }
    });
  }
});
