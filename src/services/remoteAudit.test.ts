import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A record of what reached the remote, and who sent it.
 *
 * Agents can push two ways — the MCP tools, and raw git through Bash, which a
 * run permits — and Alpha's pipeline pushes on their behalf. None of it was
 * recorded anywhere a person could read: the agent's went to the CLI's own
 * scrollback, Alpha's to a stage log line the next stage overwrote.
 *
 * The table has no foreign key to runs on purpose, and one test pins that: an
 * audit trail that disappears with the thing it describes is not one.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startDaemon() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);
  return sql.sqliteService as any;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-audit-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('remote action audit', () => {
  it('records an action and reads it back', async () => {
    const svc = await startDaemon();
    svc.recordRemoteAction({
      runId: 'run-1',
      agentId: 'agent-architect',
      issueId: 'iss-1',
      actor: 'agent',
      action: 'push',
      target: 'feat/alf-101',
      detail: 'feat: add the thing',
      succeeded: true
    });

    const [a] = svc.getRemoteActions('run-1');
    expect(a).toMatchObject({
      runId: 'run-1',
      actor: 'agent',
      action: 'push',
      target: 'feat/alf-101',
      succeeded: true
    });
    expect(a.id).toBeTruthy();
    expect(a.createdAt).toBeTruthy();
  });

  it('keeps failures, which are the ones worth seeing', async () => {
    // An agent refused a protected branch is exactly what a reviewer wants.
    const svc = await startDaemon();
    svc.recordRemoteAction({
      runId: 'run-1', actor: 'agent', action: 'push',
      target: 'main', detail: 'Refused: protected branch.', succeeded: false
    });

    const [a] = svc.getRemoteActions('run-1');
    expect(a.succeeded).toBe(false);
    expect(a.detail).toContain('protected branch');
  });

  it('distinguishes who acted', async () => {
    const svc = await startDaemon();
    svc.recordRemoteAction({ runId: 'run-1', actor: 'agent', action: 'push', succeeded: true });
    svc.recordRemoteAction({ runId: 'run-1', actor: 'alpha', action: 'open_pull_request', succeeded: true });
    svc.recordRemoteAction({ runId: 'run-1', actor: 'user', action: 'merge_pull_request', succeeded: true });

    expect(svc.getRemoteActions('run-1').map((a: any) => a.actor)).toEqual(['agent', 'alpha', 'user']);
  });

  it('returns a run history oldest first', async () => {
    // The trail is a sequence — push, then open, then merge — and reversing it
    // would make the merge look like it came before the work.
    const svc = await startDaemon();
    for (const [i, action] of ['push', 'open_pull_request', 'merge_pull_request'].entries()) {
      svc.recordRemoteAction({
        runId: 'run-1', actor: 'alpha', action, succeeded: true,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
      });
    }

    expect(svc.getRemoteActions('run-1').map((a: any) => a.action))
      .toEqual(['push', 'open_pull_request', 'merge_pull_request']);
  });

  it('keeps runs separate', async () => {
    const svc = await startDaemon();
    svc.recordRemoteAction({ runId: 'run-1', actor: 'agent', action: 'push', succeeded: true });
    svc.recordRemoteAction({ runId: 'run-2', actor: 'agent', action: 'push', succeeded: true });

    expect(svc.getRemoteActions('run-1')).toHaveLength(1);
    expect(svc.getRemoteActions('run-2')).toHaveLength(1);
  });

  /**
   * No foreign key to runs, deliberately.
   *
   * An action recorded against a run that is later deleted must survive it —
   * the whole point of the record is that it outlives what it describes. A
   * cascade would erase the evidence along with the run.
   */
  it('accepts an action for a run that does not exist', async () => {
    const svc = await startDaemon();
    svc.recordRemoteAction({ runId: 'run-never-existed', actor: 'agent', action: 'push', succeeded: true });
    expect(svc.getRemoteActions('run-never-existed')).toHaveLength(1);
  });

  it('accepts an action with no run at all', async () => {
    // A person merging from the UI outside any run still touched the remote.
    const svc = await startDaemon();
    svc.recordRemoteAction({ actor: 'user', action: 'merge_pull_request', target: 'https://x/pull/1', succeeded: true });
    expect(svc.getRemoteActions().some((a: any) => a.action === 'merge_pull_request')).toBe(true);
  });

  /**
   * A failing audit write must not take down the push it describes.
   *
   * The push already happened; losing the note about it is the lesser loss, and
   * throwing here would turn a successful mutation into a failed tool call.
   */
  it('never throws, even on a malformed write', async () => {
    const svc = await startDaemon();
    expect(() =>
      svc.recordRemoteAction({ actor: undefined as any, action: undefined as any, succeeded: true })
    ).not.toThrow();
  });
});
