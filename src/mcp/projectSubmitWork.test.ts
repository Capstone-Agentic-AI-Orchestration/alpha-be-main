import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAgentReport } from '../services/orchestrationAgentReport.js';

/** Alpha's task tools, started the way an agent CLI starts them, and spoken to over stdio. */
function startTaskTools(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'projectFilesMcpServer.ts')], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const waiting = new Map<number, (message: any) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let nextId = 1;
  const request = (method: string, params: unknown = {}) => new Promise<any>(resolve => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request };
}

let root: string;
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('handing in work with project_submit_work', () => {
  it('says what is missing, then saves the report Alpha accepts', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-submit-'));
    const repo = path.join(root, 'web');
    fs.mkdirSync(repo);
    const reportFile = path.join(root, 'task-report.json');
    const tools = startTaskTools({
      ALPHA_PROJECT_ROOTS: JSON.stringify([{ repo: 'acme/web', dir: repo }]),
      ALPHA_TASK_SCOPE: JSON.stringify({ taskId: 'build-home', repository: 'acme/web', kind: 'frontend', includePaths: ['src/**'], excludePaths: [],
        requiredChecks: [], reportFile, reportSchemaVersion: 1 })
    });
    stop = () => tools.child.kill();
    await tools.request('initialize', { protocolVersion: '2025-06-18' });
    const listed = await tools.request('tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain('project_submit_work');

    const missing = await tools.request('tools/call', { name: 'project_submit_work', arguments: { report: { summary: 'Built the homepage.' } } });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toMatch(/^Not accepted yet: .*Fix that and call project_submit_work again\.$/s);
    expect(fs.existsSync(reportFile)).toBe(false);

    const report = { summary: 'Built the homepage with a responsive header.', requirementCoverage: [], criteriaEvidence: [],
      deliverables: [{ summary: 'The homepage.', paths: ['src/App.tsx'] }], reportedChecks: [], blockers: [] };
    // Sent as a JSON string, as some models do; schemaVersion and taskId are filled in.
    const accepted = await tools.request('tools/call', { name: 'project_submit_work', arguments: { report: JSON.stringify(report) } });
    expect(accepted.result.isError).toBeUndefined();
    expect(accepted.result.content[0].text).toContain('Received.');
    const saved = fs.readFileSync(reportFile, 'utf8');
    expect(parseAgentReport(saved, 1).report).toMatchObject({ taskId: 'build-home', summary: report.summary });
  }, 30_000);

  it('is not offered outside a task', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-submit-'));
    const tools = startTaskTools({ ALPHA_PROJECT_ROOTS: JSON.stringify([{ repo: 'acme/web', dir: root }]) });
    stop = () => tools.child.kill();
    await tools.request('initialize', { protocolVersion: '2025-06-18' });
    const listed = await tools.request('tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('project_submit_work');
  }, 30_000);
});
