import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrototypeRun, RunUsage } from '../models/index.js';

/**
 * Token figures have to survive the database, and survive the rest of the run
 * writing to the same row.
 *
 * Loads sqliteService, which opens a real database — hence the temp ALPHA_HOME
 * and the dynamic import, matching agentFileWriteThrough.test.ts.
 */

let tmp: string;
let sqlite: typeof import('./sqliteService.js')['sqliteService'];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-usage-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  sqlite = (await import('./sqliteService.js')).sqliteService;
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim it */
  }
});

const run = (id: string, usage?: RunUsage): PrototypeRun => ({
  id,
  issueId: 'issue-101',
  projectId: 'proj-alpha',
  agentId: 'agent-ada',
  status: 'completed',
  plan: [],
  currentStageIndex: 4,
  stages: [],
  usage,
  createdAt: '2026-09-02T10:00:00.000Z',
  updatedAt: '2026-09-02T10:01:00.000Z'
});

const reload = (id: string) => sqlite.getPrototypeRuns().find(r => r.id === id);

describe('run usage persistence', () => {
  it('round-trips every reported figure', () => {
    sqlite.savePrototypeRun(run('run-full', {
      inputTokens: 4,
      outputTokens: 368,
      cacheReadTokens: 68492,
      cacheCreationTokens: 70747,
      thinkingTokens: 12,
      costUsd: 0.750936,
      numTurns: 3
    }));

    expect(reload('run-full')?.usage).toEqual({
      inputTokens: 4,
      outputTokens: 368,
      cacheReadTokens: 68492,
      cacheCreationTokens: 70747,
      thinkingTokens: 12,
      costUsd: 0.750936,
      numTurns: 3
    });
  });

  it('keeps an unreported figure absent instead of storing zero', () => {
    // Antigravity reports no cost and codex no cache reads. A DEFAULT 0 column
    // would turn both into a confident zero on the billing screen — the same
    // fabrication as the `|| 45` insertions this codebase already removed.
    sqlite.savePrototypeRun(run('run-partial', { inputTokens: 18373, outputTokens: 153 }));

    const usage = reload('run-partial')?.usage;
    expect(usage).toEqual({ inputTokens: 18373, outputTokens: 153 });
    expect(usage).not.toHaveProperty('costUsd');
    expect(usage).not.toHaveProperty('cacheReadTokens');
  });

  it('distinguishes a reported zero from an unreported figure', () => {
    sqlite.savePrototypeRun(run('run-zero', { inputTokens: 0 }));

    const usage = reload('run-zero')?.usage;
    expect(usage?.inputTokens).toBe(0);
    expect(usage).not.toHaveProperty('outputTokens');
  });

  it('leaves usage undefined for a run that reported nothing', () => {
    // Every run recorded before these columns existed. "Unmeasured" is not
    // "free", and the UI needs to be able to tell them apart.
    sqlite.savePrototypeRun(run('run-legacy'));
    expect(reload('run-legacy')?.usage).toBeUndefined();
  });

  it('loses usage when a stale copy of the row is saved back', () => {
    /**
     * The failure mode handleProcessExit had to be fixed for.
     *
     * It read the run at entry, then awaited a git commit, push and PR
     * creation before spreading that copy into the final row. The `result`
     * event carrying the token totals lands while the process is exiting, so
     * the totals were written in between — and then overwritten by a snapshot
     * taken before they existed. This test pins the underlying behaviour that
     * makes the re-read necessary; if `savePrototypeRun` ever starts merging
     * instead of replacing, it should be reconsidered.
     */
    sqlite.savePrototypeRun(run('run-race'));
    const stale = reload('run-race')!;

    sqlite.savePrototypeRun({ ...reload('run-race')!, usage: { inputTokens: 900 } });
    expect(reload('run-race')?.usage?.inputTokens).toBe(900);

    sqlite.savePrototypeRun({ ...stale, status: 'awaiting_approval' });
    expect(reload('run-race')?.usage).toBeUndefined();

    // ...and re-reading first, which is what handleProcessExit now does.
    sqlite.savePrototypeRun({ ...reload('run-race')!, usage: { inputTokens: 900 } });
    sqlite.savePrototypeRun({ ...reload('run-race')!, status: 'awaiting_approval' });
    expect(reload('run-race')?.usage?.inputTokens).toBe(900);
  });
});

describe('agent stats', () => {
  const ada = () => sqlite.getAgents().find(a => a.id === 'agent-ada') as any;

  it('reports zeroes for an agent that has never run', () => {
    // These were hardcoded to 142 runs / 98.4% / 620,000 tokens / 280ms for
    // every agent, on every install, including one created a second ago.
    expect(ada().stats).toMatchObject({ totalRuns: 0, successRate: 0, tokensUsed: 0 });
  });

  it('totals real tokens across an agent\'s runs', () => {
    sqlite.savePrototypeRun(run('run-a', { inputTokens: 4, outputTokens: 368, cacheReadTokens: 68492 }));
    sqlite.savePrototypeRun(run('run-b', { inputTokens: 5650, outputTokens: 560, thinkingTokens: 481 }));

    expect(ada().stats.tokensUsed).toBe(4 + 368 + 68492 + 5650 + 560 + 481);
    expect(ada().stats.totalRuns).toBe(2);
    expect(ada().stats.successRate).toBe(100);
  });

  it('excludes cancelled runs from the success rate', () => {
    // The operator stopped it. That says nothing about the agent.
    sqlite.savePrototypeRun({ ...run('run-ok'), status: 'completed' });
    sqlite.savePrototypeRun({ ...run('run-bad'), status: 'failed' });
    sqlite.savePrototypeRun({ ...run('run-stopped'), status: 'cancelled' });

    expect(ada().stats.totalRuns).toBe(3);
    expect(ada().stats.successRate).toBe(50);
  });
});
