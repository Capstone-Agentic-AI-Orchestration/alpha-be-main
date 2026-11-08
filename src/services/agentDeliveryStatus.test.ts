import { describe, expect, it } from 'vitest';

import { deliveryStatusFor } from './agentDeliveryStatus.js';
import type { DeliveryRecord } from './orchestrationDelivery.js';

const record = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  runId: 'run-1', workspaceId: 'ws', projectId: 'p1', ownerId: 'u1', revision: 3,
  stage: 'repair_required', reason: 'CI failed.', repairAttempts: 1,
  createdAt: 't0', updatedAt: 't1',
  repositories: [{
    repository: 'acme/shop-be', branch: 'agent/fix', head: 'h', prNumber: 4, prUrl: 'https://github.com/acme/shop-be/pull/4',
    checks: [
      { name: 'unit-tests / Backend Unit Tests', state: 'failed', url: 'https://github.com/acme/shop-be/actions/runs/9' },
      { name: 'lint / Lint & Style Check', state: 'passed' },
      { name: 'build', state: 'pending' }
    ],
    requiredChecks: ['unit-tests / Backend Unit Tests', 'lint / Lint & Style Check', 'build']
  }],
  history: Array.from({ length: 12 }, (_, i) => ({ at: `t${i}`, actorId: 'system', action: `a${i}`, detail: `d${i}` })),
  ...overrides
});

describe('an agent reading delivery', () => {
  it('shows the stage, why, the failed and pending checks, and the last ten events', () => {
    const status = deliveryStatusFor(record(), ['acme/shop-be']);

    expect(status).toMatchObject({ stage: 'repair_required', reason: 'CI failed.', repairAttempts: 1 });
    expect(status.delivery).toMatch(/not enabled/);
    expect(status.repositories[0].failedChecks).toEqual([
      { name: 'unit-tests / Backend Unit Tests', url: 'https://github.com/acme/shop-be/actions/runs/9' }
    ]);
    expect(status.repositories[0].pendingChecks).toEqual(['build']);
    expect(status.recent).toHaveLength(10);
    expect(status.recent.at(-1)).toEqual({ at: 't11', action: 'a11', detail: 'd11' });
  });

  it('says when a person paused delivery', () => {
    const paused = record({ authorization: { actorId: 'u1', grantedAt: 't', paused: true, sources: [] } });
    expect(deliveryStatusFor(paused, []).delivery).toBe('paused by a person');
  });

  it('refuses a build that delivers outside the project', () => {
    expect(() => deliveryStatusFor(record(), ['acme/other'])).toThrow('outside this project');
  });
});
