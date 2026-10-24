import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deleteTaskFile, editTaskFile, generateTaskLockfile, parseTaskFileScope, runTaskCheck, writeTaskFile, type TaskFileScope } from './taskFileAccess.js';

let dir: string;
let roots: Array<{ name: string; repo: string; dir: string }>;
const scope: TaskFileScope = { taskId: 'backend-task', repository: 'test/backend', kind: 'backend',
  includePaths: ['src/**', 'package-lock.json'], excludePaths: ['src/generated/**'], requiredChecks: ['test'], reportOnly: false };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-task-scope-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'api.ts'), 'before');
  roots = [{ name: 'backend', repo: 'test/backend', dir }];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('task authority before a file changes', () => {
  it.each(['../escape.ts', 'src/../escape.ts', '/absolute.ts', 'C:/elsewhere.ts', 'src\\api.ts', '.git/config', 'src/.env', 'src/generated/client.ts', 'frontend/App.tsx'])('denies %s before writing', target => {
    expect(() => writeTaskFile(roots, scope, { path: target, content: 'bad' })).toThrow();
    expect(fs.readFileSync(path.join(dir, 'src', 'api.ts'), 'utf8')).toBe('before');
  });
  it.each(['requirements', 'architecture', 'review', 'validation', 'delivery'] as const)('keeps %s tasks read-only even with a wide include', kind => {
    expect(() => writeTaskFile(roots, { ...scope, kind, includePaths: ['**'] }, { path: 'src/api.ts', content: 'bad', expected_content: 'before' })).toThrow('read-only');
  });
  it('binds the repository and refuses report-only retries', () => {
    expect(() => writeTaskFile(roots, { ...scope, repository: 'other/repo' }, { path: 'src/new.ts', content: 'bad' })).toThrow();
    expect(() => editTaskFile(roots, { ...scope, reportOnly: true }, { path: 'src/api.ts', old_text: 'before', new_text: 'bad' })).toThrow('read-only');
  });
  it('refuses linked files and directory junctions', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-task-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'protected.ts'), 'protected');
      fs.symlinkSync(outside, path.join(dir, 'src', 'linked'), 'junction');
      expect(() => writeTaskFile(roots, scope, { path: 'src/linked/new.ts', content: 'bad' })).toThrow('Linked');
      fs.linkSync(path.join(outside, 'protected.ts'), path.join(dir, 'src', 'hard.ts'));
      expect(() => editTaskFile(roots, scope, { path: 'src/hard.ts', old_text: 'protected', new_text: 'bad' })).toThrow('Linked');
      expect(fs.readFileSync(path.join(outside, 'protected.ts'), 'utf8')).toBe('protected');
    } finally { fs.rmSync(path.join(dir, 'src', 'linked'), { force: true, recursive: true }); fs.rmSync(outside, { force: true, recursive: true }); }
  });
  it('supports bounded creation, exact edits and guarded deletion', () => {
    writeTaskFile(roots, scope, { path: 'src/nested/new.ts', content: 'first' });
    expect(() => writeTaskFile(roots, scope, { path: 'src/api.ts', content: 'bad' })).toThrow('exact expected_content');
    editTaskFile(roots, scope, { path: 'src/api.ts', old_text: 'before', new_text: '$& after' });
    expect(fs.readFileSync(path.join(dir, 'src/api.ts'), 'utf8')).toBe('$& after');
    expect(() => deleteTaskFile(roots, scope, { path: 'src/api.ts', expected_content: 'stale' })).toThrow();
    deleteTaskFile(roots, scope, { path: 'src/api.ts', expected_content: '$& after' });
    expect(fs.existsSync(path.join(dir, 'src/api.ts'))).toBe(false);
  });
  it('rejects malformed authority rather than falling back to broad grants', () => {
    expect(parseTaskFileScope(undefined)).toBeUndefined();
    expect(() => parseTaskFileScope(JSON.stringify({ ...scope, kind: 'admin' }))).toThrow();
    expect(() => parseTaskFileScope(JSON.stringify({ ...scope, requiredChecks: ['deploy'] }))).toThrow();
  });
});

describe('managed task commands', () => {
  it('runs only assigned checks in a disposable copy, without secrets or dependencies', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=example');
    fs.mkdirSync(path.join(dir, 'node_modules')); fs.writeFileSync(path.join(dir, 'node_modules', 'marker'), 'cached');
    let copy = '';
    const verify = vi.fn(async (options: any) => {
      copy = options.cwd;
      expect(copy).not.toBe(dir);
      expect(fs.existsSync(path.join(copy, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(copy, 'node_modules'))).toBe(false);
      fs.writeFileSync(path.join(copy, 'src/api.ts'), 'test-generated');
      return { status: 'passed' as const, commands: [], missingScripts: [], summary: 'passed' };
    });
    await expect(runTaskCheck(roots, { ...scope, kind: 'validation' }, 'test', verify)).resolves.toMatchObject({ status: 'passed' });
    expect(fs.readFileSync(path.join(dir, 'src/api.ts'), 'utf8')).toBe('before');
    expect(fs.existsSync(copy)).toBe(false);
    await expect(runTaskCheck(roots, scope, 'deploy', verify)).rejects.toThrow('not authorized');
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it('generates a real npm lockfile through the bounded operation without running lifecycle scripts', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'task-fixture', version: '1.0.0', scripts: { preinstall: 'node -e "process.exit(99)"' } }));
    await expect(generateTaskLockfile(roots, scope)).resolves.toContain('package-lock.json');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).lockfileVersion).toBeGreaterThan(0);
    await expect(generateTaskLockfile(roots, { ...scope, includePaths: ['src/**'] })).rejects.toThrow('outside');
  }, 30_000);
});
