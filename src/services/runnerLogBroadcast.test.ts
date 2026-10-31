import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a run sends to Supabase Realtime while it works.
 *
 * Raw log lines never go: the desktop shows them over its local socket and
 * the cloud gets them with the run row. The activity feed goes only when
 * ALPHA_CLOUD_RUN_ACTIVITY is on, because it is one message per line on top
 * of that, and the full feed reaches the cloud with the run's final event.
 */

let tmp: string;
let sqlite: any;

async function load(cloudActivity: boolean) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-run-log-'));
  process.env.ALPHA_HOME = tmp;
  if (cloudActivity) process.env.ALPHA_CLOUD_RUN_ACTIVITY = '1';
  else delete process.env.ALPHA_CLOUD_RUN_ACTIVITY;
  vi.resetModules();
  sqlite = (await import('./sqliteService.js')).sqliteService;
  const runner = (await import('./runnerService.js')).runnerService;
  const cloud = await import('./supabaseService.js');
  return { runner, supabase: cloud.supabaseService, runToCloudRow: cloud.runToCloudRow };
}

afterEach(() => {
  try { sqlite?.close(); } catch { /* already closed */ }
  delete process.env.ALPHA_HOME;
  delete process.env.ALPHA_CLOUD_RUN_ACTIVITY;
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

const lines = ['$ npm test (exit 0)', '[npm test] 12 passed', '[Tool Result] wrote src/index.ts'];

async function runLines(cloudActivity: boolean) {
  const { runner, supabase, runToCloudRow } = await load(cloudActivity);
  plantRunningRun();
  vi.spyOn(supabase, 'isConfigured').mockReturnValue(true);
  const broadcast = vi.spyOn(supabase, 'broadcastRunEvent').mockResolvedValue(undefined);
  const local = { log_chunk: [] as string[], run_activity: [] as string[] };
  runner.on('log_chunk', (event: { message: string }) => local.log_chunk.push(event.message));
  runner.on('run_activity', (event: { activity: { message: string } }) => local.run_activity.push(event.activity.message));

  for (const line of lines) runner['appendLog']('run-log', 'tests', line);

  const saved = sqlite.getPrototypeRuns().find((run: any) => run.id === 'run-log');
  return {
    local,
    sent: broadcast.mock.calls.map(([, event]: any) => event.type),
    saved,
    cloudRow: runToCloudRow(saved, 'ws-1', 'dev-1') as any
  };
}

describe('what a run sends to Supabase Realtime', () => {
  it('sends neither log lines nor the activity feed by default', async () => {
    const { local, sent, saved, cloudRow } = await runLines(false);

    // The desktop still gets everything live.
    expect(local.log_chunk).toEqual(lines);
    expect(local.run_activity).toEqual(lines);
    expect(sent).toEqual([]);

    // And the cloud gets all of it with the run row.
    expect(saved.stages[0].logs).toEqual(lines);
    expect(cloudRow.stages[0].logs).toEqual(lines);
    expect(cloudRow.activities.map((a: any) => a.message)).toEqual(lines);
  });

  it('sends the activity feed, never log lines, when ALPHA_CLOUD_RUN_ACTIVITY is on', async () => {
    const { local, sent } = await runLines(true);

    expect(local.log_chunk).toEqual(lines);
    expect(sent).toEqual(['run_activity', 'run_activity', 'run_activity']);
  });
});
