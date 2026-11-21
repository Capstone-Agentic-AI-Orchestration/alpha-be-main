import { describe, expect, it, vi } from 'vitest';

import type { DeliveryRecord } from './orchestrationDelivery.js';
import { mergeFromChat, type ChatMergeDeps } from './orchestrationChatMerge.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { WorkspaceContext } from './workspaceRegistry.js';

/**
 * "Merge it" in a project chat. The Orchestrator merges through delivery, with its guards;
 * agents still cannot merge. A refusal is always a plain reply, never a thrown error.
 */
const dev = { workspaceId: 'ws', userId: 'lloyd', role: 'dev' } as WorkspaceContext;
const build = (status: string) => ({ run: { id: 'build-1', status } }) as unknown as OrchestrationSnapshot;
const record = (stage: DeliveryRecord['stage'], reason = 'Required checks passed.') => ({
  runId: 'build-1', revision: 3, stage, reason,
  repositories: [{ repository: 'acme/project-a-fe', prNumber: 1 }]
}) as unknown as DeliveryRecord;

function deps(over: Partial<ChatMergeDeps> & { stage?: DeliveryRecord['stage']; status?: string } = {}) {
  const act = vi.fn(async (input: { expectedRevision: number; key: string }) => record('dev_checks'));
  const value: ChatMergeDeps = {
    latestBuild: () => build(over.status ?? 'completed'),
    delivery: {
      ensure: () => record('pr_checks'),
      refresh: async () => record(over.stage ?? 'dev_approval', over.stage === 'pr_checks' ? 'Waiting for required CI checks on the published PR commits.' : 'Required checks passed.'),
      act: act as unknown as ChatMergeDeps['delivery']['act']
    },
    canPromote: () => true,
    ...over
  };
  return { value, act };
}

const ask = (d: ChatMergeDeps, context = dev) => mergeFromChat({ context, projectId: 'p', threadId: 'chat-1', messageId: 'm1' }, d);

describe('merging from chat', () => {
  it('merges into dev through delivery, as the person, keyed by their message', async () => {
    const { value, act } = deps();
    expect(await ask(value)).toBe('Merged project-a-fe pull request #1 into dev. CI runs on dev next; promotion to UAT is a separate step.');
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ context: dev, action: 'merge_dev', expectedRevision: 3, key: 'chat-merge-m1' }));
  });

  it('says why it cannot merge yet, without trying', async () => {
    const { value, act } = deps({ stage: 'pr_checks' });
    expect(await ask(value)).toBe("I can't merge it yet: Waiting for required CI checks on the published PR commits.");
    expect(act).not.toHaveBeenCalled();
  });

  it('turns a delivery refusal into a reply', async () => {
    const { value } = deps();
    value.delivery.act = async () => { throw new Error('Current PR checks or mergeability do not permit this merge.'); };
    expect(await ask(value)).toBe("I can't merge it: Current PR checks or mergeability do not permit this merge.");
  });

  it('has nothing to merge before the pull request exists or without a build', async () => {
    expect(await ask(deps({ status: 'awaiting_approval' }).value)).toMatch(/Approve the build first/);
    expect(await ask(deps({ latestBuild: () => undefined }).value)).toMatch(/no finished build/);
    expect(await ask(deps({ delivery: { ...deps().value.delivery, ensure: () => undefined } }).value)).toMatch(/changed no repository/);
  });

  it('is refused for a role that cannot promote builds', async () => {
    const { value, act } = deps({ canPromote: () => false });
    expect(await ask(value, { ...dev, role: 'client' } as WorkspaceContext)).toMatch(/cannot merge builds/);
    expect(act).not.toHaveBeenCalled();
  });
});
