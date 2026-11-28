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

  describe('root scripts that run each app\'s own script', () => {
    // The layout of a two-app repository: every root check runs the same-named script in each app.
    const rootScripts = Object.fromEntries(['build', 'test', 'typecheck', 'lint'].map(name =>
      [name, `npm run ${name} --prefix apps/api && npm run ${name} --prefix apps/web`]));
    function repo(web: Record<string, string> = { build: 'vite build', test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' }) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-monorepo-'));
      dirs.push(dir);
      const write = (sub: string, scripts: Record<string, string>) => {
        fs.mkdirSync(path.join(dir, sub), { recursive: true });
        fs.writeFileSync(path.join(dir, sub, 'package.json'), JSON.stringify({ scripts }));
      };
      write('.', rootScripts);
      write('apps/api', { build: 'tsc -p tsconfig.build.json', test: 'jest', typecheck: 'tsc --noEmit', lint: 'eslint . --max-warnings=0' });
      write('apps/web', web);
      return dir;
    }

    it('are not cycles: each delegates to another package', () => {
      const dir = repo();
      for (const check of ['build', 'test', 'typecheck', 'lint']) {
        expect(verificationScriptProblem(rootScripts, check, undefined, undefined, dir)).toBeUndefined();
      }
      // Without the repository to read, the delegated script is left opaque rather than called a cycle.
      expect(verificationScriptProblem(rootScripts, 'test')).toBeUndefined();
      expect(describeRepositoryExecution(dir, ['test'])).not.toContain('unavailable');
    });

    it('still finds a watcher or a real cycle in the app it delegates to', () => {
      expect(verificationScriptProblem(rootScripts, 'test', undefined, undefined, repo({ test: 'vitest' }))).toContain('Watch mode');
      expect(verificationScriptProblem(rootScripts, 'test', undefined, undefined, repo({ test: 'npm run test --prefix ../..' }))).toContain('Cyclic');
      expect(verificationScriptProblem({ test: 'npm run test' }, 'test')).toContain('Cyclic');
      expect(verificationScriptProblem({ test: 'npm run test --prefix apps/missing' }, 'test', undefined, undefined, repo())).toContain('Missing referenced verification package');
    });

    it('leaves workspace-wide commands to the process limit instead of calling them cycles', () => {
      for (const test of ['npm run test --workspaces', 'npm run test -w apps/api', 'pnpm -r test', 'pnpm --filter api test', 'yarn workspace api test']) {
        expect(verificationScriptProblem({ test }, 'test')).toBeUndefined();
      }
    });
  });
});
