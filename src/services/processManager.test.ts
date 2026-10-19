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
  it('settles a failed spawn with no PID even when no exit event arrives', () => {
    const child = fakeChild(); delete child.pid; spawnMock.mockReturnValueOnce(child);
    const manager = new ProcessManager(); const onExit = vi.fn();
    manager.spawnProcess({ runId: 'no-binary', bin: 'missing-cli', args: [], cwd: process.cwd(), onExit });
    child.emit('error', new Error('ENOENT'));
    expect(onExit).toHaveBeenCalledExactlyOnceWith(null, null, 'spawn_error');
    expect(manager.isRunActive('no-binary')).toBe(false);
    child.emit('exit', 1, null);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
  it('does not mistake an error on a live PID for completed execution', () => {
    const child = fakeChild(); spawnMock.mockReturnValueOnce(child);
    const manager = new ProcessManager(); const onExit = vi.fn();
    manager.spawnProcess({ runId: 'live-error', bin: 'node', args: [], cwd: process.cwd(), onExit });
    child.emit('error', new Error('An IPC operation failed'));
    expect(onExit).not.toHaveBeenCalled(); expect(manager.isRunActive('live-error')).toBe(true);
    child.emit('exit', 1, null); expect(onExit).toHaveBeenCalledOnce(); expect(manager.isRunActive('live-error')).toBe(false);
  });
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

  it('keeps the process active until exit is confirmed after a stop request', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    treeKillMock.mockImplementationOnce((_pid: number, _signal: string, done: (error?: Error | null) => void) => done(null));

    const manager = new ProcessManager();
    manager.spawnProcess({ runId: 'run-wait-for-exit', bin: 'node', args: [], cwd: process.cwd() });
    let completed = false;
    const stopping = manager.terminateProcessAndWait('run-wait-for-exit', 'cancelled', 1_000, 1_000).then(() => { completed = true; });
    await Promise.resolve();

    expect(completed).toBe(false);
    expect(manager.isRunActive('run-wait-for-exit')).toBe(true);
    child.emit('exit', null, 'SIGTERM');
    await stopping;

    expect(completed).toBe(true);
    expect(manager.isRunActive('run-wait-for-exit')).toBe(false);
  });

  it('escalates to SIGKILL and leaves an unconfirmed process tracked', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const signals: string[] = [];
    treeKillMock.mockImplementation((_pid: number, signal: string, done: (error?: Error | null) => void) => {
      signals.push(signal);
      done(null);
    });

    const manager = new ProcessManager();
    manager.spawnProcess({ runId: 'run-force-stop', bin: 'node', args: [], cwd: process.cwd() });
    await expect(manager.terminateProcessAndWait('run-force-stop', 'cancelled', 0, 0))
      .rejects.toThrow(/process remains tracked/);

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(manager.isRunActive('run-force-stop')).toBe(true);
    child.emit('exit', null, 'SIGKILL');
    expect(manager.isRunActive('run-force-stop')).toBe(false);
  });
});
