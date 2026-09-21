import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a session is allowed to leak, and what it must not.
 *
 * A session row holds a `repo`-scoped GitHub token. The threat this file keeps
 * honest is not "can someone sign in" but "what does an attacker get from the
 * database alone" — a leaked backup, a stray copy of alpha.db, a misconfigured
 * volume. The answers that matter: not a usable cookie, and not a usable token.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function freshService(secret = 'a-long-random-test-secret-value') {
  process.env.ALPHA_HOME = tmp;
  process.env.ALPHA_SESSION_SECRET = secret;
  vi.resetModules();
  const mod = await import('./sessionService.js');
  opened.push(mod.sessionService);
  return mod.sessionService;
}

function rawDb() {
  // Read the file the service wrote, as an attacker with the database would.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(tmp, 'alpha.db'));
  opened.push(db);
  return db;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-session-'));
  opened = [];
});

afterEach(() => {
  for (const h of opened) { try { h.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  delete process.env.ALPHA_SESSION_SECRET;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows handle */ }
  vi.resetModules();
});

describe('sessions', () => {
  it('round-trips a signed-in user', async () => {
    const svc = await freshService();
    const { cookieValue } = svc.create({
      login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret'
    });

    const session = svc.resolve(cookieValue);
    expect(session?.login).toBe('LloydLim1');
    expect(session?.role).toBe('pm');
    expect(session?.githubToken).toBe('gho_secret');
  });

  it('does not resolve a value it never issued', async () => {
    const svc = await freshService();
    svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret' });
    expect(svc.resolve('not-a-real-session')).toBeNull();
    expect(svc.resolve(undefined)).toBeNull();
  });

  /**
   * The cookie is a bearer credential: holding it *is* being the user. Storing
   * it verbatim would make read access to the database enough to impersonate
   * everyone signed in, which is the reason passwords are not stored either.
   */
  it('stores a hash, so the database cannot mint a cookie', async () => {
    const svc = await freshService();
    const { cookieValue } = svc.create({
      login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret'
    });

    const row = rawDb().prepare('SELECT * FROM sessions').get();
    expect(row.id).not.toBe(cookieValue);
    expect(JSON.stringify(row)).not.toContain(cookieValue);
  });

  /**
   * The token is the valuable half. A cookie that leaks is one revocable
   * session; a token that leaks is every private repository the user can read
   * and write, and it keeps working after they sign out of Alpha.
   */
  it('encrypts the github token at rest', async () => {
    const svc = await freshService();
    svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 'gho_verysecret' });

    const row = rawDb().prepare('SELECT * FROM sessions').get();
    expect(JSON.stringify(row)).not.toContain('gho_verysecret');
    expect(row.token_cipher).toBeTruthy();
    expect(row.token_iv).toBeTruthy();
    expect(row.token_tag).toBeTruthy();
  });

  it('cannot decrypt a token with a different secret', async () => {
    const svc = await freshService('secret-number-one-aaaaaaaaaaaaaaa');
    const { cookieValue } = svc.create({
      login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret'
    });
    svc.close();

    const other = await freshService('secret-number-two-bbbbbbbbbbbbbbb');
    expect(() => other.resolve(cookieValue)).toThrow();
  });

  /** GCM authenticates as well as encrypts: a tampered row fails, not decodes. */
  it('refuses a tampered ciphertext rather than returning garbage', async () => {
    const svc = await freshService();
    const { cookieValue } = svc.create({
      login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret'
    });

    const db = rawDb();
    const row = db.prepare('SELECT * FROM sessions').get();
    const flipped = Buffer.from(row.token_cipher, 'base64');
    flipped[0] ^= 0xff;
    db.prepare('UPDATE sessions SET token_cipher = ? WHERE id = ?')
      .run(flipped.toString('base64'), row.id);

    expect(() => svc.resolve(cookieValue)).toThrow();
  });

  it('stops resolving an expired session and drops the row', async () => {
    process.env.SESSION_TTL_MS = '-1000';
    const svc = await freshService();
    const { cookieValue } = svc.create({
      login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret'
    });

    expect(svc.resolve(cookieValue)).toBeNull();
    expect(rawDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
    delete process.env.SESSION_TTL_MS;
  });

  it('revokes on sign-out, and tolerates signing out twice', async () => {
    const svc = await freshService();
    const { cookieValue } = svc.create({
      login: 'LloydLim1', role: 'pm', githubToken: 'gho_secret'
    });

    svc.revoke(cookieValue);
    expect(svc.resolve(cookieValue)).toBeNull();
    expect(() => svc.revoke(cookieValue)).not.toThrow();
  });

  /** For removing someone who has left: every device, not just this one. */
  it('revokes every session a login holds', async () => {
    const svc = await freshService();
    const a = svc.create({ login: 'Zane', role: 'dev', githubToken: 't1' });
    const b = svc.create({ login: 'Zane', role: 'dev', githubToken: 't2' });
    const other = svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 't3' });

    expect(svc.revokeAllFor('Zane')).toBe(2);
    expect(svc.resolve(a.cookieValue)).toBeNull();
    expect(svc.resolve(b.cookieValue)).toBeNull();
    expect(svc.resolve(other.cookieValue)?.login).toBe('LloydLim1');
  });

  it('issues a different cookie for every session', async () => {
    const svc = await freshService();
    const a = svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 't' });
    const b = svc.create({ login: 'LloydLim1', role: 'pm', githubToken: 't' });
    expect(a.cookieValue).not.toBe(b.cookieValue);
  });

  it('refuses to store a token with no encryption key configured', async () => {
    const svc = await freshService('');
    expect(() => svc.create({ login: 'x', role: 'pm', githubToken: 't' })).toThrow(
      /ALPHA_SESSION_SECRET/
    );
  });
});
