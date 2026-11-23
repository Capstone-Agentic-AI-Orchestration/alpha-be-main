import { describe, expect, it } from 'vitest';
import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import { resolvedWithoutYou } from './resolvedWithoutYou.js';

/**
 * The approval list of fixes the Orchestrator made on its own: only fixes it applied without the
 * person, that passed acceptance or are being applied now, with the problem, fix, evidence and tier.
 */

const snapshot = { tasks: [{ id: 'booking-ui', title: 'Show bookings' }, { id: 'api', title: 'Bookings API' }] } as any;

function episode(id: string, resolution: Record<string, unknown> | undefined, extra: Partial<OrchestrationRecoveryEpisode> = {}): OrchestrationRecoveryEpisode {
  return {
    id, workspaceId: 'ws-1', projectId: 'project-1', runId: 'run-1', issueId: 'issue-1', taskId: 'booking-ui', attemptId: 'attempt-1',
    source: 'acceptance', category: 'project_code', code: 'acceptance_project_code', summary: 'Required check “lint” failed.',
    fingerprint: `f-${id}`, phase: 'resolved', episodeNumber: 1, repairBudget: 4, attemptsUsed: 2, threadId: 'thread-1', buildMessageId: 'build-1',
    initiatedBy: 'orchestrator', revision: 3, createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:05:00.000Z',
    evidence: resolution ? { resolution: { fingerprint: `f-${id}`, turn: true, startedAt: '2026-11-24T10:01:00.000Z', ...resolution } } : {},
    ...extra
  } as OrchestrationRecoveryEpisode;
}

const fix = { instructions: 'Import formatDate from src/lib/date.ts instead of redefining it.', expectedFiles: [{ repository: 'acme/shop-fe', path: 'src/Bookings.tsx' }] };
const citations = [
  { source: 'repository', repository: 'acme/shop-fe', path: 'src/lib/date.ts', quote: 'export function formatDate(', commit: 'c'.repeat(40) },
  { source: 'product_picture', quote: 'Bookings show the local date.' }
];

describe('resolved without you', () => {
  it('lists an accepted Orchestrator fix with its problem, fix, evidence and tier', () => {
    const items = resolvedWithoutYou(snapshot, [episode('r1', {
      outcome: 'retry_accepted', tier: 0, diagnosis: 'formatDate is defined twice, so lint fails.', proposedFix: fix, citations,
      finishedAt: '2026-11-24T10:04:00.000Z'
    })]);

    expect(items).toEqual([{
      recoveryId: 'r1', taskId: 'booking-ui', taskTitle: 'Show bookings', status: 'retry_accepted', tier: 0,
      problem: 'formatDate is defined twice, so lint fails.',
      fix: 'Import formatDate from src/lib/date.ts instead of redefining it.',
      evidence: [
        { source: 'repository', repository: 'acme/shop-fe', path: 'src/lib/date.ts', quote: 'export function formatDate(' },
        { source: 'product_picture', quote: 'Bookings show the local date.' }
      ],
      resolvedAt: '2026-11-24T10:04:00.000Z'
    }]);
  });

  it('includes a fix the specialist is still applying, and falls back to the recovery summary', () => {
    const [item] = resolvedWithoutYou(snapshot, [episode('r1', { outcome: 'retrying', tier: 1, proposedFix: fix })]);

    expect(item).toMatchObject({ status: 'retrying', tier: 1, problem: 'Required check “lint” failed.', evidence: [], resolvedAt: '2026-11-24T10:05:00.000Z' });
  });

  it('leaves out fixes the person applied, failed or escalated fixes, and recoveries the Orchestrator never handled', () => {
    const items = resolvedWithoutYou(snapshot, [
      episode('applied', { outcome: 'retry_accepted', tier: 2, proposedFix: fix, appliedBy: 'pm-1' }),
      episode('failed', { outcome: 'retry_failed', tier: 0, proposedFix: fix }),
      episode('escalated', { outcome: 'escalated', escalation: 'sensitive', tier: 2, proposedFix: fix }),
      episode('superseded', { outcome: 'superseded', proposedFix: fix }),
      episode('resolving', { outcome: 'resolving' }),
      episode('plain', undefined)
    ]);

    expect(items).toEqual([]);
  });

  it('orders the list oldest first and keeps secrets and local paths out of the text', () => {
    const items = resolvedWithoutYou(snapshot, [
      episode('later', { outcome: 'retry_accepted', tier: 0, proposedFix: fix, finishedAt: '2026-11-24T12:00:00.000Z' }),
      episode('earlier', {
        outcome: 'retry_accepted', tier: 0, finishedAt: '2026-11-24T11:00:00.000Z',
        diagnosis: 'The build read C:\\Users\\dev\\secrets.env with api_key=abc123.',
        proposedFix: { ...fix, instructions: 'Use the token ghp_abcdefghijklmnop1234 from config.' },
        citations: [{ source: 'repository', repository: 'acme/shop-fe', path: 'src/a.ts', quote: `x${'y'.repeat(600)}`, commit: 'c'.repeat(40) }]
      }, { taskId: 'api' })
    ]);

    expect(items.map(item => item.recoveryId)).toEqual(['earlier', 'later']);
    expect(items[0].taskTitle).toBe('Bookings API');
    expect(items[0].problem).not.toMatch(/Users|abc123/);
    expect(items[0].fix).not.toContain('ghp_');
    expect(items[0].evidence[0].quote.length).toBeLessThanOrEqual(300);
  });
});
