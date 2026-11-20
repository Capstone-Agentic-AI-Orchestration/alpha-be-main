import type { DeliveryRecord } from './orchestrationDelivery.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { WorkspaceContext } from './workspaceRegistry.js';

/**
 * "Merge it" in a project chat: the Orchestrator merges the build's reviewed pull
 * request(s) into dev, through the same delivery step as the project's delivery panel.
 *
 * Agents never merge. Their GitHub access cannot, and that stays: the merge is the
 * Orchestrator's, on a person's explicit request, and only with every delivery guard
 * holding (checks passed, pull request mergeable, commits unchanged since review,
 * independent review and validation accepted). Promotion to UAT and anything beyond
 * stay separate steps.
 */
export interface ChatMergeDeps {
  latestBuild(projectId: string, threadId: string): OrchestrationSnapshot | undefined;
  delivery: {
    ensure(snapshot: OrchestrationSnapshot): DeliveryRecord | undefined;
    refresh(workspaceId: string, runId: string): Promise<DeliveryRecord>;
    act(input: { context: WorkspaceContext; runId: string; projectId: string; expectedRevision: number; action: 'merge_dev'; key: string }): Promise<DeliveryRecord>;
  };
  canPromote(context: WorkspaceContext): boolean;
}

const repoName = (repository: string) => repository.split('/').pop() || repository;

/** What the Orchestrator says after a merge request in chat. Never throws: a refusal is a reply. */
export async function mergeFromChat(input: { context: WorkspaceContext; projectId: string; threadId: string; messageId: string }, deps: ChatMergeDeps): Promise<string> {
  if (!deps.canPromote(input.context)) {
    return 'Your workspace role cannot merge builds. A developer, PM, or admin can ask me to merge it.';
  }
  const build = deps.latestBuild(input.projectId, input.threadId);
  if (!build || build.run.status !== 'completed') {
    return build && ['awaiting_approval', 'publishing'].includes(build.run.status)
      ? 'There is no pull request to merge yet. Approve the build first, and I will open the pull request.'
      : 'There is no finished build with a pull request in this conversation to merge.';
  }
  const existing = deps.delivery.ensure(build);
  if (!existing) return 'This build has no pull request to merge; it changed no repository.';
  try {
    const current = await deps.delivery.refresh(input.context.workspaceId, build.run.id);
    if (current.stage !== 'dev_approval') return `I can't merge it yet: ${current.reason}`;
    const merged = await deps.delivery.act({ context: input.context, runId: build.run.id, projectId: input.projectId,
      expectedRevision: current.revision, action: 'merge_dev', key: `chat-merge-${input.messageId}` });
    const names = merged.repositories.map(repo => `${repoName(repo.repository)} pull request #${repo.prNumber}`).join(', ');
    return `Merged ${names} into dev. CI runs on dev next; promotion to UAT is a separate step.`;
  } catch (error) {
    return `I can't merge it: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The real stores and delivery service, loaded only when a merge is actually asked for. */
export async function defaultChatMergeDeps(): Promise<ChatMergeDeps> {
  const [{ sqliteService }, { orchestrationDeliveryService }, { workspaceRegistry }] = await Promise.all([
    import('./sqliteService.js'), import('./orchestrationDeliveryRuntime.js'), import('./workspaceRegistry.js')
  ]);
  return {
    latestBuild: (projectId, threadId) => sqliteService.getLatestOrchestrationSnapshot(projectId, threadId),
    delivery: orchestrationDeliveryService,
    canPromote: context => workspaceRegistry.can(context.role, 'project.promote_uat') && ['dev', 'pm', 'admin'].includes(context.role)
  };
}
