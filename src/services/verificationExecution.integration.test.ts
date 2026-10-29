import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./sqliteService.js', () => ({ sqliteService: { isPathAllowed: () => true } }));
vi.mock('../utils/logger.js', () => ({ logInfo: vi.fn(), logError: vi.fn(), logAudit: vi.fn() }));
import { processManager } from './processManager.js';
import { runVerification } from './verificationService.js';

const dirs: string[] = [];
function fixture(source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-real-check-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  fs.writeFileSync(path.join(dir, 'check.cjs'), source);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('real managed check execution', () => {
  it('returns actual failure diagnostics, then passes after the fixture is repaired', async () => {
    const cwd = fixture("console.error('fixture assertion failed'); process.exitCode = 1;");
    const failed = await runVerification({ runId: 'real-failed', cwd });
    expect(failed.status).toBe('failed');
    expect(failed.commands[0].output).toContain('fixture assertion failed');
    fs.writeFileSync(path.join(cwd, 'check.cjs'), "if (process.env.CI !== 'true') process.exit(2); console.log('fixture repaired');");
    const passed = await runVerification({ runId: 'real-repaired', cwd });
    expect(passed.status).toBe('passed');
    expect(passed.commands[0].output).toContain('fixture repaired');
  });
  it('terminates an opaque server script at its deadline and releases the loopback port', async () => {
    const cwd = fixture("require('node:http').createServer((req,res) => res.end('fixture')).listen(0, '127.0.0.1', function() { console.log('PORT=' + this.address().port); });");
    const original = processManager.spawnProcess.bind(processManager);
    let port: number | undefined;
    vi.spyOn(processManager, 'spawnProcess').mockImplementation(options => original({
      ...options, timeoutMs: 3_000,
      onStdout: chunk => {
        const found = chunk.toString().match(/PORT=(\d+)/);
        if (found) port = Number(found[1]);
        options.onStdout?.(chunk);
      }
    }));
    const pending = runVerification({ runId: 'real-server-deadline', cwd });
    try {
      await vi.waitFor(() => expect(port).toBeGreaterThan(0), { timeout: 2_500 });
      expect(await (await fetch('http://127.0.0.1:' + port)).text()).toBe('fixture');
      const result = await pending;
      expect(result.status).toBe('failed');
      expect(result.commands[0].output).toContain('timed out');
      expect(processManager.isRunActive('real-server-deadline')).toBe(false);
      await expect(fetch('http://127.0.0.1:' + port)).rejects.toThrow();
    } finally {
      if (processManager.isRunActive('real-server-deadline')) await processManager.terminateProcessAndWait('real-server-deadline', 'cancelled');
      await pending;
    }
  });
});
