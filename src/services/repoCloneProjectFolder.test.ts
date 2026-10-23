import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cloneRepository } = vi.hoisted(() => ({
  cloneRepository: vi.fn(async (ownerRepo: string, parent: string) => {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(join(parent, ownerRepo.split('/')[1], '.git'), { recursive: true });
  })
}));
vi.mock('./githubService.js', () => ({
  githubService: {
    getRepository: async (ownerRepo: string) => ({ nameWithOwner: ownerRepo, defaultBranch: 'dev', isEmpty: false }),
    cloneRepository
  }
}));

import { cloneIntoProjectFolder } from './repoCloneService.js';

let folder: string;
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-clone-folder-'));
  cloneRepository.mockClear();
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

describe("cloning into a project's folder", () => {
  it('clones into <project folder>\\<repository>', async () => {
    const result = await cloneIntoProjectFolder('acme/app-be', folder);
    expect(result).toMatchObject({ localPath: path.join(folder, 'app-be'), action: 'cloned', branch: 'dev' });
    expect(cloneRepository).toHaveBeenCalledWith('acme/app-be', folder);
  });

  it("leaves a copy that is already there untouched, uncommitted work and all", async () => {
    const dir = path.join(folder, 'app-be');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'work-in-progress.ts'), 'unsaved idea');

    const result = await cloneIntoProjectFolder('acme/app-be', folder);

    expect(result.action).toBe('existing');
    expect(cloneRepository).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, 'work-in-progress.ts'), 'utf8')).toBe('unsaved idea');
  });

  it('refuses a folder in the way that is not a checkout', async () => {
    fs.mkdirSync(path.join(folder, 'app-be'));
    fs.writeFileSync(path.join(folder, 'app-be', 'notes.txt'), 'mine');
    await expect(cloneIntoProjectFolder('acme/app-be', folder)).rejects.toThrow(/not a git checkout/);
  });
});
