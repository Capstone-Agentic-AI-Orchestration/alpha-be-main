import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkWorkspace } from './workspaceValidation.js';

let tmp: string;

const dir = (...parts: string[]) => {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** A directory that looks like a checkout to everything that matters here. */
const repo = (...parts: string[]) => {
  const p = dir(...parts);
  fs.mkdirSync(path.join(p, '.git'), { recursive: true });
  return p;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-wscheck-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('checkWorkspace', () => {
  it('accepts a git repository', () => {
    expect(checkWorkspace(repo('project'))).toEqual({ ok: true });
  });

  it('requires a path', () => {
    for (const empty of ['', '   ', undefined, null, 42]) {
      const r = checkWorkspace(empty);
      expect(r.ok, String(empty)).toBe(false);
      expect(r.problem).toBe('missing');
    }
  });

  it('reports a path that does not exist', () => {
    const r = checkWorkspace(path.join(tmp, 'nowhere'));
    expect(r.problem).toBe('missing');
    expect(r.detail).toMatch(/Nothing exists at/);
  });

  it('reports a file', () => {
    const file = path.join(tmp, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    const r = checkWorkspace(file);
    expect(r.problem).toBe('not_a_directory');
  });

  /**
   * The failure this was written for. A project attached to a folder holding
   * three repositories produced a run that could not create a branch, edited
   * files anyway, and finished with no commit and no PR — reported only as a
   * "Git branch checkout notice" the run then ignored.
   */
  it('reports a folder that contains repositories rather than being one', () => {
    const parent = dir('workspace');
    repo('workspace', 'alpha-be-main');
    repo('workspace', 'alpha-fe-main');
    repo('workspace', 'alpha-desktop');

    const r = checkWorkspace(parent);
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('nested_repos');
    // Names them, because the fix is to pick one.
    expect(r.detail).toContain('alpha-be-main');
    expect(r.detail).toMatch(/contains 3/);
  });

  it('reports a plain directory that is no repository at all', () => {
    const r = checkWorkspace(dir('empty'));
    expect(r.problem).toBe('not_a_repo');
    expect(r.detail).toMatch(/git init/);
  });

  it('resolves a relative path before reporting it', () => {
    const r = checkWorkspace('./definitely-not-here');
    expect(r.problem).toBe('missing');
    // Absolute, so the message names the place actually checked.
    expect(path.isAbsolute(r.detail!.replace('Nothing exists at ', '').replace('.', ''))).toBe(true);
  });
});
