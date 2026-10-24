import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencyInputs, readDependencyAuditEvidence, runDependencyAudit, stopDependencyAudits, type AuditCommand } from './dependencyAuditService.js';
import { taskCanAudit, writeTaskFile, type TaskFileScope } from './taskFileAccess.js';
import { taskAuditEvidence, finalDependencyAuditProblem } from './orchestrationAuditEvidence.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

let directory: string, repo: string, evidenceDirectory: string;
const spec = { scanner: 'npm', purpose: 'baseline', level: 'low' } as const;
const report = (vulnerable: boolean) => ({ vulnerabilities: vulnerable ? { example: { severity: 'high', range: '<2', isDirect: true, nodes: ['node_modules/example'], via: [{ title: 'Fixture advisory', url: 'https://example.test/advisory' }], fixAvailable: { name: 'example', version: '2.0.0', isSemVerMajor: true } } } : {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: vulnerable ? 1 : 0, critical: 0, total: vulnerable ? 1 : 0 } } });
const command = (vulnerable = true, failure = false): AuditCommand => async (bin, args, cwd) => {
  if (bin === 'git') return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
  if (args[0] === '--version') return { code: 0, stdout: '11.0.0', stderr: '' };
  if (args[0] === 'install') fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'fixture' } } }));
  return { code: failure ? 1 : args[0] === 'audit' && vulnerable ? 1 : 0, stdout: args[0] === 'audit' ? JSON.stringify(failure ? { error: { code: 'E401' } } : report(vulnerable)) : '', stderr: '' };
};
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-audit-test-'));
  repo = path.join(directory, 'repo'); fs.mkdirSync(repo);
  evidenceDirectory = path.join(directory, 'runs', 'run-one', 'audits');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { example: '1.0.0' }, scripts: { preinstall: 'must-never-run' } }));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function snapshot(ids: string[], purpose: 'baseline' | 'verification' | 'self-check' = 'baseline') {
  const task = { id: 'audit-one', repository: 'owner/repo', kind: 'audit', required: true, status: 'accepted', ownerAgentId: 'security', dependencyAudit: { ...spec, purpose } };
  const attempt = { id: 'attempt-one', taskId: task.id, agentId: 'security', prototypeRunId: 'run-one', status: 'accepted', createdAt: '2026-10-24T00:00:00Z' };
  const state = { run: { repository: 'owner/repo' }, tasks: [task], attempts: [attempt] } as unknown as OrchestrationSnapshot;
  return { state, task: state.tasks[0], attempt: state.attempts[0], ids };
}

describe('scoped dependency audits and trusted evidence', () => {
  it('captures vulnerability exit 1 as baseline evidence without changing or installing into the product', async () => {
    const before = dependencyInputs(repo).manifest;
    const evidence = await runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, command());
    expect(evidence.status).toBe('findings'); expect(evidence.passesPolicy).toBe(false);
    expect(evidence.findings[0].package).toBe('example'); expect(evidence.resolvedFromManifest).toBe(true);
    expect(fs.readdirSync(repo)).toEqual(['package.json']); expect(dependencyInputs(repo).manifest).toBe(before);
    const { state, task, attempt, ids } = snapshot([evidence.id]);
    expect(taskAuditEvidence(state, task, attempt, repo, ids, path.join(directory, 'runs'))[0].id).toBe(evidence.id);
    expect(finalDependencyAuditProblem(state, 'owner/repo', repo, [{ id: 'security', role: 'Security / Code Quality Agent' }])).toMatch(/Security verification/);
  });
  it('does not turn registry/authentication failure into clean evidence', async () => {
    const evidence = await runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, command(false, true));
    expect(evidence.status).toBe('error'); expect(evidence.passesPolicy).toBe(false);
    const { state, task, attempt, ids } = snapshot([evidence.id]);
    expect(() => taskAuditEvidence(state, task, attempt, repo, ids, path.join(directory, 'runs'))).toThrow(/stale, failed/);
  });
  it('rejects forged and stale evidence', async () => {
    const evidence = await runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, command(false));
    const { state, task, attempt, ids } = snapshot([evidence.id]);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"changed"}');
    expect(() => taskAuditEvidence(state, task, attempt, repo, ids, path.join(directory, 'runs'))).toThrow(/stale/);
    const file = path.join(evidenceDirectory, evidence.id + '.json');
    const forged = JSON.parse(fs.readFileSync(file, 'utf8')); forged.content.passesPolicy = false; fs.writeFileSync(file, JSON.stringify(forged));
    expect(() => readDependencyAuditEvidence(evidenceDirectory, [evidence.id])).toThrow(/integrity/);
    expect(() => readDependencyAuditEvidence(evidenceDirectory, ['../escape'])).toThrow(/identity/);
  });
  it('requires an independent current lock-bound verification, not a self-check', async () => {
    fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { example: '1.0.0' } } } }));
    const evidence = await runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec: { ...spec, purpose: 'verification' } }, command(false));
    const { state, task, attempt, ids } = snapshot([evidence.id], 'verification');
    const records = taskAuditEvidence(state, task, attempt, repo, ids, path.join(directory, 'runs'));
    attempt.result = { acceptanceEvidence: { dependencyAudits: records } };
    expect(finalDependencyAuditProblem(state, 'owner/repo', repo, [{ id: 'security', role: 'Security / Code Quality Agent' }])).toBeUndefined();
    expect(finalDependencyAuditProblem(state, 'owner/repo', repo, [{ id: 'security', role: 'Backend Agent' }])).toMatch(/Security verification/);
    fs.appendFileSync(path.join(repo, 'package-lock.json'), '\n');
    expect(finalDependencyAuditProblem(state, 'owner/repo', repo, [{ id: 'security', role: 'Security / Code Quality Agent' }])).toMatch(/stale/);
  });
  it('allows scoped self-audits but keeps the Security task read-only and independent', () => {
    const scope: TaskFileScope = { taskId: 'one', repository: 'owner/repo', kind: 'backend', role: 'Backend Agent', includePaths: ['package.json'], excludePaths: [], requiredChecks: [], reportOnly: false, auditDirectory: evidenceDirectory, dependencyAudit: { ...spec, purpose: 'self-check' } };
    expect(taskCanAudit(scope)).toBe(true);
    expect(taskCanAudit({ ...scope, dependencyAudit: spec })).toBe(false);
    const security: TaskFileScope = { ...scope, kind: 'audit', role: 'Security / Code Quality Agent', dependencyAudit: spec };
    expect(taskCanAudit(security)).toBe(true);
    expect(taskCanAudit({ ...security, reportOnly: true })).toBe(false);
    expect(() => writeTaskFile([{ name: 'repo', repo: 'owner/repo', dir: repo }], security, { path: 'package.json', content: '{}' })).toThrow(/read-only/);
  });
  it('lets a review route genuine remaining audit findings while keeping final acceptance blocked', async () => {
    fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { example: '1.0.0' } } } }));
    const evidence = await runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec: { ...spec, purpose: 'verification' } }, command(true));
    const { state, task, attempt, ids } = snapshot([evidence.id], 'verification');
    task.kind = 'review';
    expect(() => taskAuditEvidence(state, task, attempt, repo, ids, path.join(directory, 'runs'))).toThrow(/still reports/);
    attempt.result = { agentReport: { reviewFindings: [{ severity: 'blocking' }] } };
    const records = taskAuditEvidence(state, task, attempt, repo, ids, path.join(directory, 'runs'));
    attempt.result.acceptanceEvidence = { dependencyAudits: records };
    expect(finalDependencyAuditProblem(state, 'owner/repo', repo, [{ id: 'security', role: 'Security / Code Quality Agent' }])).toMatch(/Security verification/);
  });
  it('refuses non-registry dependency sources before launching a command', async () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { example: 'file:../../elsewhere' } }));
    await expect(runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, async () => { throw new Error('must not execute'); })).rejects.toThrow(/Non-registry/);
  });
  it('refuses workspace paths before npm can traverse outside the selected manifest', async () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['../../outside'] }));
    await expect(runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, async () => { throw new Error('must not execute'); })).rejects.toThrow(/Workspace dependency trees/);
  });
  it('rejects inconsistent scanner counts instead of claiming a clean policy result', async () => {
    const fake: AuditCommand = async (...args) => args[1][0] === 'audit'
      ? { code: 0, stdout: JSON.stringify({ ...report(true), metadata: report(false).metadata }), stderr: '' }
      : command()(...args);
    const evidence = await runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, fake);
    expect(evidence).toMatchObject({ status: 'error', passesPolicy: false, error: expect.stringContaining('inconsistent') });
  });
  it('rejects a stale lockfile and waits for cancellation before cleanup', async () => {
    fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
    const stale = await runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, command(false));
    expect(stale.error).toContain('does not match');
    fs.unlinkSync(path.join(repo, 'package-lock.json'));
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = runDependencyAudit({ directory: repo, evidenceDirectory, taskId: 'audit-one', repository: 'owner/repo', spec }, async (...args) => {
      if (args[1][0] !== 'audit') return command(false)(...args);
      started();
      return new Promise(resolve => args[3].addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: '' }), { once: true }));
    });
    await ready; await stopDependencyAudits();
    expect(await running).toMatchObject({ status: 'error', passesPolicy: false, error: expect.stringContaining('cancelled') });
    expect(fs.readdirSync(repo)).toEqual(['package.json']);
  });
});
