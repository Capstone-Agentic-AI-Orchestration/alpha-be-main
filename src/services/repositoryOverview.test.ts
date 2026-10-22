import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryFileOverview } from './repositoryOverview.js';

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-overview-'));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('repository file overview for the planner', () => {
  it('marks a starter scaffold so the planner builds features instead of fixing missing ones', () => {
    const overview = repositoryFileOverview(repo({
      'package.json': '{}', 'vite.config.ts': '', 'src/main.tsx': '', 'src/App.tsx': '',
      'tests/unit/App.spec.tsx': '', 'node_modules/react/index.js': ''
    }));
    expect(overview).toContain('src/App.tsx');
    expect(overview).toContain('2 application source files');
    expect(overview).toContain('starter scaffold');
    expect(overview).not.toContain('node_modules');
  });

  it('lists a real app without the scaffold note', () => {
    const files: Record<string, string> = { 'package.json': '{}' };
    for (const name of ['App', 'TransactionList', 'TransactionForm', 'Budget', 'api']) files[`src/${name}.tsx`] = '';
    const overview = repositoryFileOverview(repo(files));
    expect(overview).toContain('src/TransactionForm.tsx');
    expect(overview).not.toContain('starter scaffold');
  });
});
