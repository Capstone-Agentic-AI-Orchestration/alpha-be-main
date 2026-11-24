import type { SQLiteService } from './sqliteService.js';
import type { OrchestrationService } from './orchestrationService.js';
import type { OrchestrationRecoveryService } from './orchestrationRecoveryService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { BlockerResolutionService } from './blockerResolution.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import { plannerIdentity, readyProjectAgents, selectPlanner } from './planningAgents.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { getGitChangedPaths, getGitFileAtCommit, getHeadCommit } from '../utils/gitUtils.js';
import { productPictureFor, teamProductPicture } from './productPicture.js';
import { desktopProductPictureSource } from './productPictureSource.js';
import { readMemoryAtCommit, renderProjectMemory } from './repositoryMemory.js';
import { productRecordsOf } from './resolutionEvidence.js';

function workspacesOf(snapshot: OrchestrationSnapshot) {
  const { run } = snapshot;
  return run.repositoryWorkspaces?.length ? run.repositoryWorkspaces
    : [{ repository: run.repository, worktreePath: run.worktreePath ?? '', baseCommit: run.baseCommit ?? '' }];
}

/**
 * The resolver on this desktop: the build's own planning identity (fresh access, ready agents, as
 * milestone planning), this machine's git checkouts, the team product picture, and the normal
 * guided retry. Alpha keeps no provider credentials, so with no ready planner it does nothing.
 */
export function desktopBlockerResolution(input: {
  store: SQLiteService;
  orchestration: Pick<OrchestrationService, 'retryTask'>;
  recovery: Pick<OrchestrationRecoveryService, 'reconcileSnapshot' | 'flushPendingMilestones'>;
  planner?: OrchestrationPlanner;
}): BlockerResolutionService {
  const { store, orchestration, recovery } = input;
  const planner = input.planner ?? new OrchestrationPlanner();
  return new BlockerResolutionService({
    store,
    planner,
    async plannerFor(snapshot) {
      const { run } = snapshot;
      const context = await workspaceRegistry.resolve(run.createdBy, run.workspaceId);
      if (!context || !workspaceRegistry.can(context.role, 'squad.run') || !workspaceRegistry.canAccessProjectBuilds(context, run.projectId)) return undefined;
      const project = store.getProjects().find(item => item.id === run.projectId);
      if (!project) return undefined;
      const runtimes = store.getRuntimes();
      const eligible = await readyProjectAgents({ agents: store.getAgents(), runtimes, context, projectId: run.projectId, projectKey: project.key });
      const identity = selectPlanner(eligible, runtimes);
      return identity ? plannerIdentity(identity, runtimes) : undefined;
    },
    retryTask: retry => orchestration.retryTask(retry),
    git: { head: getHeadCommit, changedPaths: getGitChangedPaths, fileAtCommit: getGitFileAtCommit },
    productPicture(snapshot) {
      const project = store.getProjects().find(item => item.id === snapshot.run.projectId);
      if (!project) return { prompt: '', records: [] };
      const source = desktopProductPictureSource;
      const picture = teamProductPicture({
        project, issues: source.issues(project.id), snapshots: source.snapshots(project.id), approvedSpec: issueId => source.approvedSpec(issueId)
      });
      // Evidence is the brief and the recorded decisions only, as data: board cards, chat requests
      // and build goals are text anyone can write, and an open question cannot answer itself.
      return { prompt: productPictureFor(project, 'team', source), records: productRecordsOf(picture) };
    },
    async repositoryMemory(snapshot) {
      const entries = await Promise.all(workspacesOf(snapshot).filter(item => item.worktreePath).map(async item =>
        readMemoryAtCommit(item.repository, item.worktreePath, await getHeadCommit(item.worktreePath))));
      return renderProjectMemory(entries);
    },
    async afterRetry(snapshot) {
      recovery.reconcileSnapshot(snapshot);
      await recovery.flushPendingMilestones();
    },
    flushMilestones: () => recovery.flushPendingMilestones()
  });
}
