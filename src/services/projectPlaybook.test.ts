import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeProjectContext, detectRepositoryStack, readRepositoryPlaybook } from './projectPlaybook.js';

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-playbook-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('project playbook', () => {
  it('prefers ALPHA.md, falls back to AGENTS.md, and drops comments', () => {
    expect(readRepositoryPlaybook(repo({ 'ALPHA.md': '<!-- note -->\nUse the Button component.', 'AGENTS.md': 'other' }))).toEqual({ file: 'ALPHA.md', text: 'Use the Button component.' });
    expect(readRepositoryPlaybook(repo({ 'AGENTS.md': 'Run npm test before reporting.' }))?.file).toBe('AGENTS.md');
    expect(readRepositoryPlaybook(repo({ 'ALPHA.md': '<!-- only a comment -->', 'CLAUDE.md': 'Keep components small.' }))?.file).toBe('CLAUDE.md');
    expect(readRepositoryPlaybook(repo({}))).toBeUndefined();
  });

  it('names the stack from package.json and the lockfile', () => {
    const dir = repo({
      'package.json': JSON.stringify({ type: 'module', dependencies: { react: '^18.3.1' }, devDependencies: { vite: '^6.1.0', vitest: '^3.2.7', tailwindcss: '^3.4.17' } }),
      'package-lock.json': '{}'
    });
    expect(detectRepositoryStack(dir)).toBe('React 18.3.1, Vite 6.1.0, Tailwind CSS 3.4.17, Vitest 3.2.7, ES modules, npm');
    expect(detectRepositoryStack(repo({}))).toBeUndefined();
  });

  it('combines the description, each repository\'s stack and playbook, within the size limit', () => {
    const fe = repo({ 'package.json': JSON.stringify({ dependencies: { react: '18.3.1' } }), 'ALPHA.md': 'Money is shown with formatCurrency.' });
    const be = repo({});
    const context = composeProjectContext({ description: 'Personal finance app', repositories: [{ repository: 'org/fe', dir: fe }, { repository: 'org/be', dir: be }] });
    expect(context).toContain('Project: Personal finance app');
    expect(context).toContain('## org/fe\nDetected stack: React 18.3.1.');
    expect(context).toContain('Team playbook (ALPHA.md in this repository');
    expect(context).toContain('Money is shown with formatCurrency.');
    expect(context).not.toContain('org/be');
    const long = repo({ 'ALPHA.md': 'x'.repeat(20_000) });
    expect(composeProjectContext({ repositories: Array.from({ length: 4 }, (_, index) => ({ repository: 'r' + index, dir: long })) }).length).toBeLessThanOrEqual(8_000);
  });
});

