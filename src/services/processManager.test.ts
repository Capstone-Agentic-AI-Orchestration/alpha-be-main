import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const treeKillMock = vi.hoisted(() => vi.fn());

vi.mock('cross-spawn', () => ({ default: spawnMock }));
vi.mock('tree-kill', () => ({ default: treeKillMock }));
vi.mock('./sqliteService.js', () => ({
  sqliteService: { isPathAllowed: () => true }
}));
vi.mock('../utils/logger.js', () => ({
  logAudit: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn()
}));

import { ProcessManager } from './processManager.js';

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: vi.fn(), end: vi.fn() };
  return child;
}

describe('ProcessManager termination reasons', () => {
  it('passes a timeout reason through a delayed exit event', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    treeKillMock.mockImplementationOnce((_pid: number, _signal: string, done: (error?: Error | null) => void) => done(null));

    const onExit = vi.fn();
    const manager = new ProcessManager();
    manager.spawnProcess({ runId: 'run-timeout', bin: 'node', args: [], cwd: process.cwd(), onExit });

    await manager.killProcess('run-timeout', 'SIGTERM', 'timeout');
    child.emit('exit', null, 'SIGTERM');

    expect(onExit).toHaveBeenCalledWith(null, 'SIGTERM', 'timeout');
  });

  it('marks an explicit cancellation separately from a timeout', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    treeKillMock.mockImplementationOnce((_pid: number, _signal: string, done: (error?: Error | null) => void) => done(null));

    const onExit = vi.fn();
    const manager = new ProcessManager();
    manager.spawnProcess({ runId: 'run-cancel', bin: 'node', args: [], cwd: process.cwd(), onExit });

    await manager.killProcess('run-cancel', 'SIGTERM', 'cancelled');
    child.emit('exit', null, 'SIGTERM');

    expect(onExit).toHaveBeenCalledWith(null, 'SIGTERM', 'cancelled');
  });

  it('passes a provider error reason through a delayed exit event', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    treeKillMock.mockImplementationOnce((_pid: number, _signal: string, done: (error?: Error | null) => void) => done(null));

    const onExit = vi.fn();
    const manager = new ProcessManager();
    manager.spawnProcess({ runId: 'run-provider-error', bin: 'node', args: [], cwd: process.cwd(), onExit });

    await manager.killProcess('run-provider-error', 'SIGTERM', 'provider_error');
    child.emit('exit', null, 'SIGTERM');

    expect(onExit).toHaveBeenCalledWith(null, 'SIGTERM', 'provider_error');
  });
});
