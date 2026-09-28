import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase, sqlFor } from '../../store/testDatabase.js';
import { recordHostingChange, type HostingAuditEntry } from './hostingAudit.js';

/**
 * The hosting audit, against the real migrations: every change is recorded,
 * no value can be, and nothing outside the server can read it.
 */

let db: PGlite;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

const entry = (overrides: Partial<HostingAuditEntry> = {}): HostingAuditEntry => ({
  workspaceId: 'ws-1',
  repo: 'example-org/shop-be',
  environment: 'uat',
  action: 'env_set',
  keys: ['STRIPE_KEY', 'DATABASE_URL'],
  actor: { login: 'dev-one', kind: 'user' },
  result: 'ok',
  ...overrides
});

describe('the hosting audit', () => {
  it('records who changed which keys where', async () => {
    await recordHostingChange(entry({ actor: { login: 'op-agent', kind: 'agent', runId: 'run-7', agentId: 'agent-operator' } }), sqlFor(db));

    const { rows } = await db.query<any>(
      `select repo, environment, action, keys, actor_login, actor_kind, run_id, agent_id, result
         from alpha_private.hosting_audit where run_id = 'run-7'`
    );
    expect(rows).toEqual([
      {
        repo: 'example-org/shop-be',
        environment: 'uat',
        action: 'env_set',
        keys: ['STRIPE_KEY', 'DATABASE_URL'],
        actor_login: 'op-agent',
        actor_kind: 'agent',
        run_id: 'run-7',
        agent_id: 'agent-operator',
        result: 'ok'
      }
    ]);
  });

  /** There is no column for a value; the keys column is the one place one could be slipped in. */
  it.each([['DATABASE_URL=postgres://app:secret@db/shop'], ['sk_live_abc123'], ['lower_case']])(
    'refuses anything but a variable name as a key: %s',
    async bad => {
      await expect(
        db.query(
          `insert into alpha_private.hosting_audit (workspace_id, repo, action, keys, actor_login, actor_kind, result)
           values ('ws-1', 'example-org/shop-be', 'env_set', $1, 'dev-one', 'user', 'ok')`,
          [[bad]]
        )
      ).rejects.toThrow(/check constraint/);
    }
  );

  it('keeps a platform error without the token it may carry', async () => {
    await recordHostingChange(entry({ result: 'failed', error: 'Render 401 for Bearer rnd_abcdef123', repo: 'example-org/err-case' }), sqlFor(db));

    const { rows } = await db.query<{ error: string }>(`select error from alpha_private.hosting_audit where repo = 'example-org/err-case'`);
    expect(rows[0].error).toBe('Render 401 for Bearer [redacted]');
  });

  it('is not readable with a database token', async () => {
    await db.exec('set role authenticated');
    try {
      await expect(db.query('select * from alpha_private.hosting_audit')).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('reset role');
    }
  });
});
