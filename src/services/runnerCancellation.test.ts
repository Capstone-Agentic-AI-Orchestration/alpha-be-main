import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
let sqlite: any;
let runner: any;
let processManager: any;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-run-cancel-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const db = await import('./sqliteService.js');
  const service = await import('./runnerService.js');
  const processes = await import('./processManager.js');
  sqlite = db.sqliteService;
  runner = service.runnerService;
  processManager = processes.processManager;
});

afterEach(() => {
  try { sqlite?.close(); } catch { /* already closed */ }
  delete process.env.ALPHA_HOME;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function plantRun(status: 'queued' | 'running' | 'cancelled') {
  const project = sqlite.createProject({
    id: 'proj-cancel',
    name: 'Cancellation fixture',
    key: 'CAN'
  });
  const issue = sqlite.createIssue({
    id: 'issue-cancel',
    projectId: project.id,
    title: 'Cancellation fixture',
    status: 'agent_running'
  });
  const agent = sqlite.getAgents()[0];
  if (!agent) throw new Error('Expected seeded agent fixture');
  sqlite.savePrototypeRun({
    id: `run-${status}`,
    issueId: issue.id,
    projectId: issue.projectId,
    agentId: agent.id,
    status,
    plan: [],
    currentStageIndex: 0,
    stages: [{
      id: 'workspace',
      label: 'Preparing workspace',
      description: 'Preparing',
      status: status === 'cancelled' ? 'cancelled' : 'running',
      logs: []
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return issue;
}

describe('RunnerService cancellation', () => {
  it('cancels a queued run before it can reach the workspace queue', async () => {
    const issue = plantRun('queued');

    await runner.cancelRun('run-queued');

    expect(sqlite.getPrototypeRuns().find((run: any) => run.id === 'run-queued')?.status).toBe('cancelled');
    expect(sqlite.getIssues().find((item: any) => item.id === issue.id)?.status).toBe('in_progress');
  });

  it('does not allow a terminal run to be cancelled again', async () => {
    plantRun('cancelled');

    await expect(runner.cancelRun('run-cancelled')).rejects.toThrow('not cancellable');
  });

  it('persists and announces cancellation only after process termination is confirmed', async () => {
    plantRun('running');
    let confirmStopped!: () => void;
    const stopConfirmation = new Promise<void>(resolve => { confirmStopped = resolve; });
    vi.spyOn(processManager, 'terminateProcessAndWait').mockImplementation(async () => { await stopConfirmation; });
    const cancelled = vi.fn();
    runner.on('run_cancelled', cancelled);

    const stopping = runner.cancelRun('run-running');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sqlite.getPrototypeRuns().find((run: any) => run.id === 'run-running')?.status).toBe('running');
    expect(cancelled).not.toHaveBeenCalled();

    confirmStopped();
    await stopping;
    expect(sqlite.getPrototypeRuns().find((run: any) => run.id === 'run-running')?.status).toBe('cancelled');
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
