import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnProcess = vi.hoisted(() => vi.fn());

vi.mock('./processManager.js', () => ({
  processManager: { spawnProcess }
}));

import { discoverVerificationCommands, runVerification } from './verificationService.js';

const tempDirectories: string[] = [];

function fixture(scripts: Record<string, string>, packageManager?: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-verification-'));
  tempDirectories.push(cwd);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ packageManager, scripts }), 'utf8');
  return cwd;
}

afterEach(() => {
  spawnProcess.mockReset();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('verificationService', () => {
  it('prefers one repository-owned combined verification script', () => {
    const cwd = fixture({
      verify: 'npm run test && npm run typecheck',
      test: 'vitest run',
      typecheck: 'tsc --noEmit'
    }, 'pnpm@9.0.0');

    expect(discoverVerificationCommands(cwd)).toEqual([{
      script: 'verify',
      bin: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      args: ['run', 'verify'],
      display: 'pnpm run verify'
    }]);
  });

  it('discovers conventional test, typecheck, and lint scripts in order', () => {
    const cwd = fixture({
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      test: 'vitest run'
    });

    expect(discoverVerificationCommands(cwd).map(command => command.display)).toEqual([
      'npm run test',
      'npm run typecheck',
      'npm run lint'
    ]);
  });

  it('runs explicitly required scripts without substituting a combined verify script', async () => {
    const cwd = fixture({
      verify: 'npm run test',
      test: 'vitest run',
      typecheck: 'tsc --noEmit'
    });
    spawnProcess.mockImplementation((options: any) => {
      const child = new EventEmitter();
      queueMicrotask(() => options.onExit?.(0, null));
      return child;
    });

    const result = await runVerification({ runId: 'run-required-checks', cwd, requiredScripts: ['test', 'lint'] });

    expect(result.commands).toEqual([]);
    expect(result.missingScripts).toEqual(['lint']);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Required checks unavailable: lint.');
  });

  it('captures command output and reports a nonzero exit as failed', async () => {
    const cwd = fixture({ test: 'node test.js', typecheck: 'tsc --noEmit' });
    spawnProcess.mockImplementation((options: any) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        options.onStdout?.(Buffer.from('checking files\n'));
        options.onStderr?.(Buffer.from('one assertion failed\n'));
        options.onExit?.(1, null);
      });
      return child;
    });

    const result = await runVerification({ runId: 'run-verification', cwd });

    expect(result.status).toBe('failed');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].exitCode).toBe(1);
    expect(result.commands[0].output).toContain('one assertion failed');
    expect(result.summary).toContain('npm run test (exit 1)');
    expect(spawnProcess).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-verification',
      cwd,
      bin: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', 'test']
    }));
  });

  it('runs every conventional check and reports verified only after all pass', async () => {
    const cwd = fixture({ test: 'node test.js', typecheck: 'tsc --noEmit' });
    spawnProcess.mockImplementation((options: any) => {
      const child = new EventEmitter();
      queueMicrotask(() => options.onExit?.(0, null));
      return child;
    });

    const result = await runVerification({ runId: 'run-verification-pass', cwd });

    expect(result.status).toBe('passed');
    expect(result.commands.map(item => item.exitCode)).toEqual([0, 0]);
    expect(result.summary).toBe('Verification passed: npm run test (exit 0); npm run typecheck (exit 0).');
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('asks the registry again when a stale package cache cannot find a pinned version', async () => {
    const cwd = fixture({ test: 'jest' });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { browserslist: '^4.29.4' } }), 'utf8');
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}', 'utf8');
    const calls: string[][] = [];
    spawnProcess.mockImplementation((options: any) => {
      calls.push(options.args);
      const child = new EventEmitter();
      const stale = options.args.includes('--prefer-offline');
      queueMicrotask(() => {
        if (stale) options.onStderr?.(Buffer.from('npm error code ETARGET\nnpm error notarget No matching version found for browserslist@4.29.4.\n'));
        options.onExit?.(stale ? 1 : 0, null);
      });
      return child;
    });

    const result = await runVerification({ runId: 'run-stale-cache', cwd });

    expect(result.status).toBe('passed');
    expect(calls).toEqual([
      ['ci', '--no-audit', '--no-fund', '--prefer-offline'],
      ['ci', '--no-audit', '--no-fund', '--prefer-online'],
      ['run', 'test']
    ]);
  });

  it('leaves the run unverified when the repository has no supported scripts', async () => {
    const cwd = fixture({ dev: 'vite' });

    const result = await runVerification({ runId: 'run-unverified', cwd });

    expect(result.status).toBe('skipped');
    expect(result.commands).toEqual([]);
    expect(result.summary).toContain('No configured verification commands');
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
