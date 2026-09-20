import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Whose conversations a developer can read.
 *
 * `chat_threads` had only `workspace_id`, so `GET /chat/threads` returned
 * every thread in the workspace to every member: any developer could read any
 * other developer's prompts by loading the chat list. There was no column to
 * filter on, which is why the filter was never written.
 *
 * The same rule is enforced twice, in two places that do not share code — here
 * in SQLite for the desktop, and in `0002_row_level_security.sql` for the
 * cloud database the desktop also reaches directly. `rlsPolicies.test.ts`
 * covers the other half.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function freshService() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const mod = await import('./sqliteService.js');
  opened.push(mod.sqliteService);
  return mod.sqliteService;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-chatown-'));
  opened = [];
});

afterEach(() => {
  for (const h of opened) { try { h.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows handle */ }
  vi.resetModules();
});

describe('chat thread ownership', () => {
  it('returns only the threads a given owner started', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 't-lloyd', title: 'Lloyd', ownerId: 'Lloyd1020' });
    svc.createChatThread({ id: 't-zane', title: 'Zane', ownerId: 'ZaneZamoraC1Cs' });

    expect(svc.getChatThreads('Lloyd1020').map(t => t.id)).toEqual(['t-lloyd']);
    expect(svc.getChatThreads('ZaneZamoraC1Cs').map(t => t.id)).toEqual(['t-zane']);
  });

  it('records the owner on the thread it returns', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 't1', title: 'Mine', ownerId: 'Lloyd1020' });
    expect(svc.getChatThreads('Lloyd1020')[0].ownerId).toBe('Lloyd1020');
  });

  it('gives a stranger nothing', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 't1', title: 'Mine', ownerId: 'Lloyd1020' });
    expect(svc.getChatThreads('someone-else')).toEqual([]);
  });

  /**
   * An unowned row is not public.
   *
   * `owner_id` had to land nullable, so rows written before it have none.
   * Matching `owner_id IS NULL` in the read would have been the convenient
   * choice and would have reinstated exactly the leak this closes — every
   * legacy thread visible to everyone. They are claimed instead.
   */
  it('hides a legacy thread with no owner rather than showing it to all', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 'legacy', title: 'Old' });

    expect(svc.getChatThreads('Lloyd1020')).toEqual([]);
    expect(svc.getChatThreads('ZaneZamoraC1Cs')).toEqual([]);
  });

  it('claims legacy threads for the person at this machine', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 'legacy', title: 'Old' });
    svc.createChatThread({ id: 'owned', title: 'New', ownerId: 'Lloyd1020' });

    expect(svc.claimUnownedThreads('Lloyd1020')).toBe(1);
    expect(svc.getChatThreads('Lloyd1020').map(t => t.id).sort()).toEqual(['legacy', 'owned']);
  });

  it('claims nothing on a second run', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 'legacy', title: 'Old' });

    expect(svc.claimUnownedThreads('Lloyd1020')).toBe(1);
    expect(svc.claimUnownedThreads('Lloyd1020')).toBe(0);
  });

  /**
   * Claiming must not reassign someone else's thread.
   *
   * On the desktop there is only one person, but the helper is a plain UPDATE
   * and a future caller could run it anywhere. Restricting it to NULL owners
   * is what keeps it from silently transferring ownership.
   */
  it('never reassigns a thread that already has an owner', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 't-zane', title: 'Zane', ownerId: 'ZaneZamoraC1Cs' });

    svc.claimUnownedThreads('Lloyd1020');
    expect(svc.getChatThreads('Lloyd1020')).toEqual([]);
    expect(svc.getChatThreads('ZaneZamoraC1Cs').map(t => t.id)).toEqual(['t-zane']);
  });

  /**
   * The unscoped call still exists for internal callers that resolved a single
   * thread the controller had already authorised. Nothing on a request path
   * may use it, which is why the HTTP layer always passes an owner.
   */
  it('still returns the whole workspace when no owner is given', async () => {
    const svc = await freshService();
    svc.createChatThread({ id: 't-lloyd', title: 'Lloyd', ownerId: 'Lloyd1020' });
    svc.createChatThread({ id: 't-zane', title: 'Zane', ownerId: 'ZaneZamoraC1Cs' });

    expect(svc.getChatThreads()).toHaveLength(2);
  });
});
