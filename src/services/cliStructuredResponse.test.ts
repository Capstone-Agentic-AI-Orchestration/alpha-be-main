import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let directory: string;
let close: (() => void) | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-structured-response-'));
  process.env.ALPHA_HOME = directory;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks(); close?.(); close = undefined;
  delete process.env.ALPHA_HOME;
  // The target was created by this test under the OS temp directory.
  if (path.dirname(directory) === path.resolve(os.tmpdir())) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe('structured CLI completion boundary', () => {
  it.each(['success', 'nonzero', 'timeout', 'provider-error', 'cancelled'] as const)('handles %s with a valid response already in the stream', async outcome => {
    const { processManager } = await import('./processManager.js');
    const { sqliteService } = await import('./sqliteService.js');
    close = () => (sqliteService as any).close();
    const response = { intent: 'consent', target: 'plan', evidence: 'yes' };
    const spawn = vi.spyOn(processManager, 'spawnProcess').mockImplementation(options => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      setImmediate(() => {
        stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'This narration is not the contract.' }] } }) + '\n');
        stdout.write(JSON.stringify({ type: 'result', subtype: 'success', structured_output: response }) + '\n');
        stdout.end(); stderr.end();
        options.onExit?.(outcome === 'nonzero' ? 1 : 0, null,
          outcome === 'timeout' ? 'timeout' : outcome === 'provider-error' ? 'provider_error' : outcome === 'cancelled' ? 'cancelled' : undefined);
      });
      return { stdout, stderr } as any;
    });
    const { runCliTurn } = await import('./cliRunner.js');
    const result = await runCliTurn({ runId: 'structured-test', cwd: directory, provider: 'Anthropic', prompt: 'yes',
      mode: 'chat', approvalMode: 'ask', priorSession: null, skills: [], projectRoots: [], mcpServers: [],
      responseSchema: { type: 'object' }, toolFree: true, timeoutMs: 60000 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].timeoutMs).toBe(60000);
    if (outcome === 'success') { expect(JSON.parse(result.content)).toEqual(response); expect(result.failureKind).toBeNull(); }
    else if (outcome === 'cancelled') { expect(result.cancelled).toBe(true); expect(result.content).toBe(''); }
    else { expect(result.failureKind).toBe('empty'); expect(result.content).toBe(''); }
  });
});
