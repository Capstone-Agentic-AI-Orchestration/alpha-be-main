import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverInstalledSkills } from './skillDiscoveryService.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function writeSkill(filePath: string, name: string, description: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
}

describe('installed skill discovery', () => {
  it('reads user and project skill metadata without executing the files', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-skill-discovery-'));
    const userRoot = path.join(tempRoot, 'user', 'skills');
    const projectRoot = path.join(tempRoot, 'project', '.agents', 'skills');
    writeSkill(path.join(userRoot, 'animate', 'SKILL.md'), 'animate', 'Build motion carefully.');
    writeSkill(path.join(projectRoot, 'local-tool', 'SKILL.md'), 'local-tool', 'A project-only helper.');

    const skills = discoverInstalledSkills({
      roots: [
        { path: userRoot, source: 'user', label: 'Test user' },
        { path: projectRoot, source: 'project', label: 'Test project' }
      ],
      pluginCacheRoots: []
    });

    expect(skills.map(skill => skill.name)).toEqual(['animate', 'local-tool']);
    expect(skills.map(skill => skill.source)).toEqual(['user', 'project']);
    expect(skills.every(skill => skill.installed && skill.permissions === 'read_only')).toBe(true);
  });

  it('keeps one stable entry for multiple cached plugin versions', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-skill-plugin-'));
    const cacheRoot = path.join(tempRoot, 'cache');
    const oldFile = path.join(cacheRoot, 'market', 'demo-plugin', '1.0.0', 'skills', 'demo', 'SKILL.md');
    const newFile = path.join(cacheRoot, 'market', 'demo-plugin', '2.0.0', 'skills', 'demo', 'SKILL.md');
    writeSkill(oldFile, 'demo', 'Old copy.');
    writeSkill(newFile, 'demo', 'New copy.');
    const newer = new Date(Date.now() + 2_000);
    fs.utimesSync(newFile, newer, newer);

    const skills = discoverInstalledSkills({ roots: [], pluginCacheRoots: [cacheRoot] });
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('plugin');
    expect(skills[0].path).toBe(newFile);
  });
});

