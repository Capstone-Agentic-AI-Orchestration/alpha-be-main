import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cloned: string[] = [];
vi.mock('./githubService.js', () => ({
  githubService: {
    cloneRepository: vi.fn(async (repo: string, intoDir: string) => {
      const target = path.join(intoDir, repo.split('/').pop()!);
      fs.mkdirSync(path.join(target, '.git'), { recursive: true });
      cloned.push(repo);
      return target;
    })
  }
}));

import { BindingError, cloneProjectInto } from './projectBindings.js';
import type { Project } from '../models/index.js';

const project = {
  id: 'project-1', name: 'Money tracker', key: 'MON',
  resources: [
    { id: 'r1', type: 'github_repo', name: 'app-fe', pathOrUrl: 'https://github.com/acme/app-fe' },
    { id: 'r2', type: 'github_repo', name: 'app-be', pathOrUrl: 'https://github.com/acme/app-be' }
  ]
} as unknown as Project;

const dirs: string[] = [];
const folder = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-clone-to-')); dirs.push(dir); return dir; };
afterEach(() => { cloned.length = 0; for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('cloning a project into a chosen folder', () => {
  it('clones only the chosen repositories, one folder each', async () => {
    const into = folder();
    const results = await cloneProjectInto(project, into, ['acme/app-fe'], false);
    expect(cloned).toEqual(['acme/app-fe']);
    expect(results).toEqual([{ repo: 'acme/app-fe', path: path.join(into, 'app-fe'), cloned: true, bound: false }]);
  });

  it('reuses a checkout already there and reports a folder in the way without stopping the others', async () => {
    const into = folder();
    fs.mkdirSync(path.join(into, 'app-fe', '.git'), { recursive: true });
    fs.mkdirSync(path.join(into, 'app-be'));
    fs.writeFileSync(path.join(into, 'app-be', 'notes.txt'), 'mine');
    const results = await cloneProjectInto(project, into, ['acme/app-fe', 'acme/app-be'], false);
    expect(cloned).toEqual([]);
    expect(results[0]).toMatchObject({ repo: 'acme/app-fe', cloned: false });
    expect(results[1].error).toContain('already exists');
  });

  it('refuses repositories outside the project and folders that do not exist', async () => {
    await expect(cloneProjectInto(project, folder(), ['someone/else'], false)).rejects.toBeInstanceOf(BindingError);
    await expect(cloneProjectInto(project, path.join(folder(), 'missing'), ['acme/app-fe'], false)).rejects.toThrow('is not a folder');
    await expect(cloneProjectInto(project, 'relative/path', ['acme/app-fe'], false)).rejects.toThrow('Choose a folder');
  });
});

