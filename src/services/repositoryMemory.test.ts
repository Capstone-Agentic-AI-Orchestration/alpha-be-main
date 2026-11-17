import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubApiError, type GitHubApi } from './githubApi.js';
import {
  MEMORY_HEADING, budgetMemory, fetchMemoryFromGitHub, memorySources, readMemoryAtCommit, readMemoryFromDir, renderProjectMemory
} from './repositoryMemory.js';

const dirs: string[] = [];
function folder(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-memory-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

/** Answers for GitHub's contents endpoint from a map of file name to text, counting calls. */
function fakeGitHub(files: Record<string, string>, failWith?: Error): GitHubApi & { calls: string[] } {
  const calls: string[] = [];
  const get = async <T>(url: string): Promise<T> => {
    calls.push(url);
    if (failWith) throw failWith;
    const name = url.split('/contents/')[1];
    if (!(name in files)) throw new GitHubApiError('Not Found', 404);
    return { type: 'file', sha: 'blob-' + name, encoding: 'base64', content: Buffer.from(files[name]).toString('base64') } as T;
  };
  const unused = async () => { throw new Error('not used'); };
  return { calls, get, getAll: unused, post: unused, patch: unused, put: unused, delete: unused } as unknown as GitHubApi & { calls: string[] };
}

describe('repository memory', () => {
  it('reads AGENTS.md first, then ALPHA.md and CLAUDE.md, ignoring comment-only files', () => {
    expect(readMemoryFromDir('org/fe', folder({ 'AGENTS.md': 'Use formatCurrency.', 'ALPHA.md': 'other' }))).toMatchObject({ file: 'AGENTS.md', text: 'Use formatCurrency.' });
    expect(readMemoryFromDir('org/fe', folder({ 'AGENTS.md': '<!-- template only -->', 'ALPHA.md': 'Keep components small.' }))).toMatchObject({ file: 'ALPHA.md' });
    expect(readMemoryFromDir('org/fe', folder({ 'CLAUDE.md': 'Run npm test.' }))).toMatchObject({ file: 'CLAUDE.md' });
    expect(readMemoryFromDir('org/fe', folder())).toEqual({ repository: 'org/fe', text: '', origin: 'checkout' });
  });

  it('reads memory as committed, so an edit after the commit cannot reach a running build', async () => {
    const dir = folder();
    git(dir, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Login: POST /api/auth/login');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'memory');
    const commit = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Edited after the build started');

    expect(await readMemoryAtCommit('org/be', dir, commit)).toMatchObject({ file: 'AGENTS.md', text: 'Login: POST /api/auth/login', version: commit, origin: 'commit' });
    expect((await readMemoryAtCommit('org/be', dir, 'not-a-commit')).text).toBe('');
  });

  it('fetches from GitHub, skipping missing files, and keeps a copy for five minutes', async () => {
    const cacheRoot = folder();
    const api = fakeGitHub({ 'ALPHA.md': '<!-- tip -->\nAPI base URL from VITE_API_URL.' });
    let now = Date.parse('2026-11-18T10:00:00Z');
    const options = { api, cacheRoot, now: () => now };

    expect(await fetchMemoryFromGitHub('org/fe', options)).toMatchObject({ file: 'ALPHA.md', text: 'API base URL from VITE_API_URL.', origin: 'github', version: 'blob-ALPHA.md' });
    expect(api.calls).toEqual(['/repos/org/fe/contents/AGENTS.md', '/repos/org/fe/contents/ALPHA.md']);

    now += 60_000;
    expect(await fetchMemoryFromGitHub('org/fe', options)).toMatchObject({ origin: 'cache', text: 'API base URL from VITE_API_URL.' });
    expect(api.calls).toHaveLength(2);

    expect(await fetchMemoryFromGitHub('org/fe', { ...options, refresh: true })).toMatchObject({ origin: 'github' });
    expect(api.calls).toHaveLength(4);
  });

  it('falls back to the last copy, marked stale, when GitHub cannot be reached', async () => {
    const cacheRoot = folder();
    let now = Date.parse('2026-11-18T10:00:00Z');
    await fetchMemoryFromGitHub('org/fe', { api: fakeGitHub({ 'AGENTS.md': 'Cookies carry the session.' }), cacheRoot, now: () => now });
    now += 10 * 60_000;
    const offline = fakeGitHub({}, new GitHubApiError('Service unavailable', 503));
    expect(await fetchMemoryFromGitHub('org/fe', { api: offline, cacheRoot, now: () => now })).toMatchObject({ text: 'Cookies carry the session.', origin: 'cache', stale: true });
    await expect(fetchMemoryFromGitHub('org/other', { api: offline, cacheRoot, now: () => now })).rejects.toThrow('Service unavailable');
  });

  it('puts every repository under one heading that frames memory as facts, within the budgets', () => {
    const block = renderProjectMemory([
      { repository: 'org/be', file: 'AGENTS.md', text: 'Login: POST /api/auth/login', origin: 'checkout' },
      { repository: 'org/fe', file: 'AGENTS.md', text: 'Send credentials: include.', origin: 'github' },
      { repository: 'org/docs', text: '', origin: 'github' }
    ]);
    expect(block.startsWith(MEMORY_HEADING)).toBe(true);
    expect(block).toContain('if the code contradicts them, the code wins');
    expect(block).toContain('### org/be (AGENTS.md)\nLogin: POST /api/auth/login');
    expect(block).toContain('### org/fe (AGENTS.md)');
    expect(block).not.toContain('org/docs');
    expect(renderProjectMemory([{ repository: 'org/fe', text: '', origin: 'checkout' }])).toBe('');
  });

  it('shortens each repository and the total, visibly', () => {
    const fitted = budgetMemory([
      { repository: 'a/a', file: 'AGENTS.md', text: 'x'.repeat(5_000), origin: 'checkout' },
      { repository: 'b/b', file: 'AGENTS.md', text: 'y'.repeat(5_000), origin: 'checkout' },
      { repository: 'c/c', file: 'AGENTS.md', text: 'z'.repeat(100), origin: 'checkout' }
    ], { PER_REPO: 3_000, TOTAL: 5_000 });
    expect(fitted.map(entry => entry.text.length)).toEqual([3_000, 2_000, 0]);
    expect(fitted.map(entry => entry.shortened)).toEqual([true, true, true]);
    expect(fitted[0].text.endsWith('… (shortened)')).toBe(true);
  });

  it('names the file and version each repository\'s memory came from', () => {
    expect(memorySources([
      { repository: 'org/be', file: 'AGENTS.md', text: 'x', origin: 'commit', version: 'abc123' },
      { repository: 'org/fe', text: '', origin: 'github' }
    ])).toEqual([{ repository: 'org/be', file: 'AGENTS.md', version: 'abc123' }]);
  });
});
