import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitDiffNumstat, getGitDiffPatch } from '../utils/gitUtils.js';
import { summarizeNpmLockfile } from './orchestrationService.js';

let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });

describe('review patches', () => {
  it('summarize an npm lockfile as declared ranges beside locked versions', () => {
    const summary = summarizeNpmLockfile(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fe', version: '0.1.0', dependencies: { react: '^19.0.0' }, devDependencies: { 'jest-environment-jsdom': '^29.7.0' } },
        'node_modules/react': { version: '19.0.0' },
        'node_modules/jest-environment-jsdom': { version: '29.7.0' },
        'node_modules/jsdom': { version: '20.0.3' }
      }
    }))!;
    expect(summary).toContain('lockfileVersion 3; root fe@0.1.0; 3 locked packages');
    expect(summary).toContain('dependencies react: declared ^19.0.0, locked 19.0.0');
    expect(summary).toContain('devDependencies jest-environment-jsdom: declared ^29.7.0, locked 29.7.0');
    expect(summarizeNpmLockfile('not json')).toBeUndefined();
  });

  it('leave lockfiles out of the patch and report them by line counts', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-review-patch-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fe"}\n');
    git('add', '.');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fe","devDependencies":{"jest":"^29"}}\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), Array.from({ length: 500 }, (_, i) => `"line-${i}"`).join('\n') + '\n');
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'yarn.lock'), 'a\nb\n');
    git('add', '.');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'deps');
    const result = git('rev-parse', 'HEAD');
    const names = ['package-lock.json', 'yarn.lock'];

    const patch = await getGitDiffPatch(dir, base, result, names);
    expect(patch).toContain('devDependencies');
    expect(patch).not.toContain('package-lock.json');
    expect(patch).not.toContain('yarn.lock');
    expect((await getGitDiffNumstat(dir, base, result, names)).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'package-lock.json', additions: 500, deletions: 0 },
      { path: 'web/yarn.lock', additions: 2, deletions: 0 }
    ]);
    expect(await getGitDiffPatch(dir, base, result)).toContain('package-lock.json');
  });
});

