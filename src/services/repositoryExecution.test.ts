import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeRepositoryExecution, verificationScriptProblem } from './repositoryExecution.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('repository execution grounding', () => {
  it('uses the declared manager consistently and refreshes checks after a source change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-profile-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    const manifest = (scripts: Record<string, string>) => fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts }));
    manifest({ test: 'vitest run', dev: 'vite' });
    const first = describeRepositoryExecution(dir, ['test', 'lint']);
    expect(first).toContain('Package manager: pnpm.');
    expect(first).toContain('test: pnpm run test');
    expect(first).toContain('Missing assigned checks: lint');
    expect(first).toContain('managed');
    manifest({ test: 'vite' });
    expect(describeRepositoryExecution(dir, ['test'])).toContain('unavailable: Development servers');
  });
  it.each([
    'vitest run', 'vitest --run', 'jest', 'tsc --noEmit', 'vite build', 'next build',
    'node --test', 'echo "vite && npm run dev" && node test.js', 'cross-env MODE=test vitest run',
    'jest -w 2', 'jest --watchAll=false', 'node test.js 2>&1', 'echo "&" && node test.js', 'echo --watch && node test.js'
  ])('allows bounded check commands: %s', test => {
    expect(verificationScriptProblem({ test }, 'test')).toBeUndefined();
  });
  it('checks aliases and lifecycle hooks without rejecting a shared acyclic prerequisite', () => {
    expect(verificationScriptProblem({ test: 'npm run typecheck && npm run typecheck', typecheck: 'tsc --noEmit' }, 'test')).toBeUndefined();
    expect(verificationScriptProblem({ test: 'npm run missing' }, 'test')).toContain('Missing referenced');
  });
});
