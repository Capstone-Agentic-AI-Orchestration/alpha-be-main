import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnProcess = vi.hoisted(() => vi.fn());
vi.mock('./processManager.js', () => ({ processManager: { spawnProcess } }));
import { runVerification } from './verificationService.js';

const dirs: string[] = [];
function fixture(scripts: Record<string, string | undefined>, dependencies = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-execution-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts, ...(dependencies ? { devDependencies: { vitest: '3.2.7' } } : {})
  }));
  return dir;
}
afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('bounded repository verification', () => {
  it.each([
    { test: 'vite' },
    { test: 'next dev' },
    { test: 'vitest' },
    { test: 'vitest --watch' },
    { test: 'tsc --watch' },
    { test: 'npm run dev', dev: 'vite' },
    { test: 'pnpm run live', live: 'next start' },
    { test: 'yarn live', live: 'python -m http.server' },
    { test: 'node test.js', pretest: 'vite' },
    { test: 'node test.js', posttest: 'npm run dev', dev: 'vite' },
    { test: 'npm run other', other: 'npm test' },
    { test: 'node test.js & node server.js' },
    { test: 'echo checking\nnext dev' },
  ])('rejects unbounded script definitions before any install or check: %j', async scripts => {
    const result = await runVerification({ runId: 'blocked', cwd: fixture(scripts, true), requiredScripts: ['test'] });
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/bounded|preview|watch|cyclic/i);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it('keeps bounded scripts and supplies noninteractive execution settings', async () => {
    spawnProcess.mockImplementation(options => {
      const child = new EventEmitter();
      queueMicrotask(() => options.onExit(0, null));
      return child;
    });
    const result = await runVerification({ runId: 'bounded', cwd: fixture({ test: 'vitest run', typecheck: 'tsc --noEmit' }) });
    expect(result.status).toBe('passed');
    expect(spawnProcess).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ CI: 'true' }),
      timeoutMs: expect.any(Number)
    }));
  });
  it('never reports missing required checks as passed', async () => {
    spawnProcess.mockImplementation(options => {
      const child = new EventEmitter();
      queueMicrotask(() => options.onExit(0, null));
      return child;
    });
    const result = await runVerification({ runId: 'missing', cwd: fixture({ test: 'node test.js' }), requiredScripts: ['test', 'lint'] });
    expect(result.status).toBe('failed');
    expect(result.missingScripts).toEqual(['lint']);
  });
  it('reports a forced timeout as failed even if the child exits zero', async () => {
    spawnProcess.mockImplementation(options => {
      const child = new EventEmitter();
      queueMicrotask(() => options.onExit(0, null, 'timeout'));
      return child;
    });
    const result = await runVerification({ runId: 'timeout', cwd: fixture({ test: 'node test.js' }) });
    expect(result.status).toBe('failed');
    expect(result.commands[0].output).toMatch(/timed out/i);
  });
});
