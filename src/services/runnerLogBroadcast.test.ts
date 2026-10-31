import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Raw log lines stay on the machine running the agent.
 *
 * Each line used to go to Supabase Realtime as well, one REST call per line
 * on top of the activity event that already carried it. The desktop shows the
 * lines over its local socket and the cloud gets them with the run row.
 */

let tmp: string;
let sqlite: any;
let runner: any;
let supabase: any;
let runToCloudRow: any;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-run-log-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  sqlite = (await import('./sqliteService.js')).sqliteService;
  runner = (await import('./runnerService.js')).runnerService;
  const cloud = await import('./supabaseService.js');
  supabase = cloud.supabaseService;
  runToCloudRow = cloud.runToCloudRow;
});

afterEach(() => {
  try { sqlite?.close(); } catch { /* already closed */ }
  delete process.env.ALPHA_HOME;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function plantRunningRun() {
  const project = sqlite.createProject({ id: 'proj-log', name: 'Log fixture', key: 'LOG' });
  const issue = sqlite.createIssue({ id: 'issue-log', projectId: project.id, title: 'Log fixture', status: 'agent_running' });
  const agent = sqlite.getAgents()[0];
  if (!agent) throw new Error('Expected seeded agent fixture');
  sqlite.savePrototypeRun({
    id: 'run-log',
    issueId: issue.id,
    projectId: issue.projectId,
    agentId: agent.id,
    status: 'running',
    plan: [],
    currentStageIndex: 0,
    stages: [{ id: 'tests', label: 'Running tests', description: 'Testing', status: 'running', logs: [] }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

describe('run log lines', () => {
  it('stream to the local socket and stay off Supabase Realtime', () => {
    plantRunningRun();
    vi.spyOn(supabase, 'isConfigured').mockReturnValue(true);
    const broadcast = vi.spyOn(supabase, 'broadcastRunEvent').mockResolvedValue(undefined);
    const local: string[] = [];
    runner.on('log_chunk', (event: { message: string }) => local.push(event.message));

    const lines = ['$ npm test (exit 0)', '[npm test] 12 passed', '[Tool Result] wrote src/index.ts'];
    for (const line of lines) runner['appendLog']('run-log', 'tests', line);

    expect(local).toEqual(lines);
    const sent = broadcast.mock.calls.map(([, event]: any) => event.type);
    expect(sent).not.toContain('log_chunk');
    expect(sent).toEqual(['run_activity', 'run_activity', 'run_activity']);

    const saved = sqlite.getPrototypeRuns().find((run: any) => run.id === 'run-log');
    expect(saved.stages[0].logs).toEqual(lines);
    // What the cloud row gets when the run ends: the same lines, in the stages column.
    expect(runToCloudRow(saved, 'ws-1', 'dev-1').stages[0].logs).toEqual(lines);
  });
});
