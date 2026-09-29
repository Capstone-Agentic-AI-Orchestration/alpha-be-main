import { describe, expect, it } from 'vitest';

import {
  describePending,
  grantedRepo,
  grantForToken,
  holdHostingChange,
  mintRunGrant,
  pendingForRun,
  revokeRunGrant,
  takePending
} from './runBridge.js';
import { redactToolInput } from './toolInputRedaction.js';

/** A run's tools act for that run only, for as long as it lasts; production waits for a person. */

const grant = (runId: string) => ({
  runId,
  agentId: 'agent-operator',
  workspaceId: 'ws-1',
  repos: { 'example-org/shop-fe': { repo: 'example-org/shop-fe', stack: 'react' } },
  access: 'write' as const
});

describe('run grants', () => {
  it('answers a minted token with its run, and nothing once the run is over', () => {
    const token = mintRunGrant(grant('run-1'));

    expect(grantForToken(token)?.runId).toBe('run-1');
    revokeRunGrant('run-1');
    expect(grantForToken(token)).toBeNull();
  });

  it('replaces a run’s earlier token when it is minted again', () => {
    const first = mintRunGrant(grant('run-2'));
    const second = mintRunGrant(grant('run-2'));

    expect(grantForToken(first)).toBeNull();
    expect(grantForToken(second)?.runId).toBe('run-2');
  });

  it.each([undefined, '', 'not-hex', 'a'.repeat(63)])('refuses a malformed token: %s', token => {
    expect(grantForToken(token)).toBeNull();
  });

  it('reaches only the run’s own repositories, case-insensitively', () => {
    const g = grant('run-3');

    expect(grantedRepo(g, 'Example-Org/Shop-FE')?.repo).toBe('example-org/shop-fe');
    expect(grantedRepo(g, 'example-org/payroll')).toBeNull();
  });
});

describe('production changes waiting for approval', () => {
  const change = (runId: string) =>
    holdHostingChange({
      runId,
      agentId: 'agent-operator',
      workspaceId: 'ws-1',
      repo: 'example-org/shop-fe',
      hints: { stack: 'react' },
      environment: 'main',
      vars: [{ key: 'VITE_STRIPE_PK', value: 'pk_live_1' }],
      redeploy: true
    });

  it('shows a reviewer the keys, never the values', () => {
    const held = change('run-10');

    const shown = describePending(held);

    expect(shown).toMatchObject({ id: held.id, runId: 'run-10', repo: 'example-org/shop-fe', keys: ['VITE_STRIPE_PK'] });
    expect(JSON.stringify(shown)).not.toContain('pk_live_1');
  });

  it('is decided once, and only within its own run', () => {
    const held = change('run-11');

    expect(takePending('run-other', held.id)).toBeNull();
    expect(pendingForRun('run-11')).toHaveLength(1);
    expect(takePending('run-11', held.id)?.vars).toEqual([{ key: 'VITE_STRIPE_PK', value: 'pk_live_1' }]);
    expect(takePending('run-11', held.id)).toBeNull();
    expect(pendingForRun('run-11')).toEqual([]);
  });
});

describe('logging an agent’s tool calls', () => {
  it.each(['hosting_env_set', 'mcp__alpha-hosting__hosting_env_set', 'alpha-hosting.hosting_env_set'])(
    'masks the values a %s call sets',
    name => {
      const logged = redactToolInput(name, { repo: 'example-org/shop-fe', environment: 'uat', vars: [{ key: 'API_SECRET', value: 's3cret' }] });

      expect(logged).toEqual({ repo: 'example-org/shop-fe', environment: 'uat', vars: [{ key: 'API_SECRET', value: '[redacted]' }] });
    }
  );

  it('leaves every other tool’s input as it was', () => {
    const input = { path: 'src/index.ts', value: 'kept' };

    expect(redactToolInput('Write', input)).toBe(input);
    expect(redactToolInput('mcp__alpha-hosting__hosting_logs', input)).toBe(input);
  });
});
