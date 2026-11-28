import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { clearStaleIndexLock } from './gitUtils.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('clearStaleIndexLock', () => {
  it('removes a lock left by a dead git process and keeps a fresh one', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-lock-'));
    made.push(repo);
    execFileSync('git', ['init', '-q', repo]);
    const lock = path.join(repo, '.git', 'index.lock');

    fs.writeFileSync(lock, '');
    expect(await clearStaleIndexLock(repo)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);

    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    expect(await clearStaleIndexLock(repo)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
