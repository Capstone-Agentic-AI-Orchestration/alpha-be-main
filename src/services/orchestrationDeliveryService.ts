import type { SQLiteService } from './sqliteService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { WorkspaceContext } from './workspaceRegistry.js';
import { runWithWorkspace } from './workspaceContext.js';
import { DeliveryGithub, type DeliveryPull } from './orchestrationDeliveryGithub.js';
import { verifyDeliveryDeployment } from './orchestrationDeliveryHosting.js';
import { DeliveryError, deliveryPrNumber, type DeliveryRecord, type DeliveryAction, type DeliveryRepository } from './orchestrationDelivery.js';

type Store = Pick<SQLiteService, 'getOrchestrationSnapshot' | 'getOrchestrationDelivery' | 'saveOrchestrationDelivery' | 'listAllOrchestrationDeliveries' | 'hasOrchestrationDeliveryAction'>;
export type RepairPlanner = (record: DeliveryRecord, snapshot: OrchestrationSnapshot, context: WorkspaceContext) => Promise<string>;
const deliveryLocks = new WeakMap<object, Map<string, Promise<unknown>>>();

export class OrchestrationDeliveryService {
  private readonly locks: Map<string, Promise<unknown>>;
  constructor(private readonly store: Store, private readonly github = new DeliveryGithub(),
    private readonly verifyDeployment = verifyDeliveryDeployment, private readonly prepareRepair?: RepairPlanner) {
    this.locks = deliveryLocks.get(store) ?? new Map();
    deliveryLocks.set(store, this.locks);
  }

  private serialize<T>(workspaceId: string, runId: string, work: () => Promise<T>): Promise<T> {
    const key = workspaceId + ':' + runId;
    const result = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(() => runWithWorkspace(workspaceId, work));
    this.locks.set(key, result);
    void result.finally(() => { if (this.locks.get(key) === result) this.locks.delete(key); }).catch(() => {});
    return result;
  }
  ensure(snapshot: OrchestrationSnapshot): DeliveryRecord | undefined {
    return runWithWorkspace(snapshot.run.workspaceId, () => {
      const saved = this.store.getOrchestrationDelivery(snapshot.run.id);
      if (saved) return saved;
      const publications = snapshot.run.publications ?? (snapshot.run.publication ? [snapshot.run.publication] : []);
      if (snapshot.run.status !== 'completed' || !publications.length) return undefined;
      const repositories = publications.map(item => {
        const repository = item.repository ?? snapshot.run.repository;
        return { repository, branch: item.branchName, head: item.resultCommit, prNumber: deliveryPrNumber(item.pullRequestUrl, repository),
          prUrl: item.pullRequestUrl, requiredChecks: [], checks: [] };
      });
      const parent = this.store.listAllOrchestrationDeliveries().find(item => item.workspaceId === snapshot.run.workspaceId && item.repairRunId === snapshot.run.id);
      const now = new Date().toISOString();
      return this.store.saveOrchestrationDelivery({ runId: snapshot.run.id, workspaceId: snapshot.run.workspaceId,
        projectId: snapshot.run.projectId, ownerId: snapshot.run.createdBy, revision: 0, stage: 'pr_checks',
        reason: 'Build published. Delivery is checking the PRs; UAT readiness is not yet verified.', repositories,
        createdAt: now, updatedAt: now, repairAttempts: parent?.repairAttempts ?? 0, history: [] });
    });
  }
  private save(record: DeliveryRecord, actorId: string, action: string): DeliveryRecord {
    const now = new Date().toISOString();
    return this.store.saveOrchestrationDelivery({ ...record, revision: record.revision + 1, updatedAt: now,
      history: [...record.history, { at: now, actorId, action, detail: record.reason,
        commits: record.repositories.map(repo => ({ repository: repo.repository, source: repo.head, devBase: repo.devBase,
          devHead: repo.devHead, uatBase: repo.uatBase, uatHead: repo.uatHead })) }].slice(-200) }, record.revision);
  }
  private snapshot(record: DeliveryRecord) {
    const snapshot = this.store.getOrchestrationSnapshot(record.runId);
    if (!snapshot || snapshot.run.projectId !== record.projectId || snapshot.run.workspaceId !== record.workspaceId) {
      throw new DeliveryError('Delivery build is unavailable in this project.', 404);
    }
    return snapshot;
  }
  /**
   * Every repository that has a pull request in this delivery needs accepted independent
   * review and validation after its last code change. A repository the build left unchanged
   * has no pull request and nothing to review; requiring evidence for it blocked delivery of
   * the repositories that did change.
   */
  private assertIndependentReviews(snapshot: OrchestrationSnapshot, record: DeliveryRecord) {
    if (snapshot.findings.some(finding => finding.status === 'open' && ['blocking', 'critical'].includes(finding.severity))) {
      throw new DeliveryError('Resolve the blocking security findings before delivery.');
    }
    for (const repo of record.repositories) {
      const tasks = snapshot.tasks.filter(task => (task.repository ?? snapshot.run.repository).toLowerCase() === repo.repository.toLowerCase());
      const owners = new Set(tasks.filter(task => ['backend', 'frontend', 'database', 'mobile'].includes(task.kind)).map(task => task.ownerAgentId));
      const reviews = tasks.filter(task => task.kind === 'review' && task.status === 'accepted' && !owners.has(task.ownerAgentId));
      const validation = tasks.filter(task => task.kind === 'validation' && task.status === 'accepted' && !owners.has(task.ownerAgentId));
      // Role ownership was validated at task acceptance. Require review and
      // validation after every accepted implementation checkpoint as well.
      const latestCode = Math.max(0, ...snapshot.attempts.filter(attempt => tasks.some(task => task.id === attempt.taskId && owners.has(task.ownerAgentId)) && attempt.status === 'accepted').map(attempt => Date.parse(attempt.completedAt ?? attempt.createdAt)));
      const fresh = (taskIds: string[]) => snapshot.attempts.some(attempt => taskIds.includes(attempt.taskId) && attempt.status === 'accepted' && Date.parse(attempt.completedAt ?? attempt.createdAt) >= latestCode);
      if (!reviews.length || !validation.length || !fresh(reviews.map(task => task.id)) || !fresh(validation.map(task => task.id))) {
        throw new DeliveryError(`${repo.repository}: accepted independent Security review and Validation evidence are required after the implementation.`);
      }
    }
  }
  private assertPull(target: DeliveryRepository, pull: DeliveryPull, uat: boolean) {
    if (pull.head.repo.full_name.toLowerCase() !== target.repository.toLowerCase() || pull.base.repo.full_name.toLowerCase() !== target.repository.toLowerCase() ||
      pull.base.ref !== (uat ? 'uat' : 'dev') || pull.head.ref !== (uat ? 'dev' : target.branch) || pull.head.sha !== (uat ? target.devHead : target.head)) {
      throw new DeliveryError(`${target.repository}: PR identity or commit changed. Fresh review and approval are required.`);
    }
    if (uat && target.uatBase && !pull.merged && pull.base.sha !== target.uatBase) {
      throw new DeliveryError(`${target.repository}: the UAT target changed. Prepare a fresh promotion.`);
    }
    if (!pull.merged && pull.state !== 'open') throw new DeliveryError(`${target.repository}: the PR was closed without merging.`);
  }
  private async checkStage(target: DeliveryRepository, sha: string, branch: 'dev' | 'uat',
    pending: DeliveryRecord['stage'], passed: DeliveryRecord['stage'], mergeSha?: string | null): Promise<DeliveryRecord['stage']> {
    const checks = await this.github.checks(target.repository, sha, branch, mergeSha);
    target.checks = checks.checks; target.requiredChecks = checks.required;
    if (checks.state === 'failed') return 'repair_required';
    if (checks.state === 'pending') return pending;
    return passed;
  }
  private async observePromotion(target: DeliveryRepository): Promise<DeliveryRecord['stage']> {
    const promotion = await this.github.pull(target.repository, target.uatPrNumber!);
    this.assertPull(target, promotion, true);
    await this.github.assertScope(target.repository, target.uatPrNumber!);
    if (!promotion.merged) {
      // UAT-only failures need a new dev-based repair; never patch UAT directly.
      return this.checkStage(target, target.devHead!, 'uat', 'uat_checks', 'uat_approval', promotion.merge_commit_sha);
    }
    target.uatHead ??= promotion.merge_commit_sha ?? undefined;
    if (!target.uatHead || await this.github.branch(target.repository, 'uat') !== target.uatHead) {
      throw new DeliveryError(`${target.repository}: the UAT branch no longer matches this promotion.`);
    }
    const stage = await this.checkStage(target, target.uatHead, 'uat', 'uat_deploying', 'uat_ready');
    if (stage !== 'uat_ready') return stage;
    target.deployment = await this.verifyDeployment(target);
    if (!target.deployment.verifiedAt || target.deployment.sha !== target.uatHead) return 'uat_deploying';
    return 'uat_ready';
  }
  private async observeRepository(target: DeliveryRepository): Promise<DeliveryRecord['stage']> {
    const original = await this.github.pull(target.repository, target.prNumber);
    this.assertPull(target, original, false);
    await this.github.assertScope(target.repository, target.prNumber);
    if (!original.merged) {
      target.devBase = original.base.sha;
      return this.checkStage(target, target.head, 'dev', 'pr_checks', 'dev_approval', original.merge_commit_sha);
    }
    if (!original.merge_commit_sha) throw new DeliveryError('GitHub has not supplied the merged commit yet.');
    target.devHead ??= original.merge_commit_sha;
    if (await this.github.branch(target.repository, 'dev') !== target.devHead) {
      throw new DeliveryError(`${target.repository}: dev advanced beyond this reviewed delivery. Start a fresh delivery review.`);
    }
    if (target.uatPrNumber) return this.observePromotion(target);
    target.uatBase = await this.github.branch(target.repository, 'uat');
    return this.checkStage(target, target.devHead, 'dev', 'dev_checks', 'uat_prepare');
  }
  private async observe(record: DeliveryRecord): Promise<DeliveryRecord> {
    const next = structuredClone(record);
    this.assertIndependentReviews(this.snapshot(record), record);
    if (record.repairRunId) {
      const child = this.store.getOrchestrationSnapshot(record.repairRunId);
      if (child?.run.publication) {
        this.ensure(child); next.stage = 'superseded'; next.reason = 'A reviewed repair build superseded this delivery. Follow its delivery status.'; return next;
      }
      next.stage = 'repair_required'; next.reason = 'A bounded CI repair plan is available. Review and approve it before specialists edit files.'; return next;
    }
    const priority: DeliveryRecord['stage'][] = ['repair_required', 'pr_checks', 'dev_approval', 'dev_checks', 'uat_prepare', 'uat_checks', 'uat_approval', 'uat_deploying', 'uat_ready'];
    const stages = await Promise.all(next.repositories.map(target => this.observeRepository(target)));
    const stage = stages.reduce<DeliveryRecord['stage']>((current, value) => priority.indexOf(value) < priority.indexOf(current) ? value : current, 'uat_ready');
    next.stage = stage;
    const reasons: Partial<Record<DeliveryRecord['stage'], string>> = {
      pr_checks: 'Waiting for required CI checks on the published PR commits.', dev_approval: 'Required checks passed. The reviewed changes are ready for delivery through dev to UAT.',
      dev_checks: 'Waiting for CI on the merged dev commits.', uat_prepare: 'Dev CI passed. Delivery can prepare the dev → uat promotion PRs.',
      uat_checks: 'Waiting for checks on the UAT promotion PRs.', uat_approval: 'UAT promotion checks passed. Authorized delivery can merge these commits automatically.',
      uat_deploying: 'Waiting for UAT CI, the matching hosted deployment and HTTP smoke checks.',
      uat_ready: 'UAT deployment and HTTP smoke checks passed for every codebase. Ready for PM review; client handoff remains separate.',
      repair_required: 'CI failed. The Orchestrator can prepare a scoped repair plan with independent Security review and Validation. No failing check will be bypassed.'
    };
    next.reason = reasons[stage]!;
    return next;
  }
  async refresh(workspaceId: string, runId: string) {
    return this.serialize(workspaceId, runId, async () => {
      const record = this.store.getOrchestrationDelivery(runId);
      if (!record) throw new DeliveryError('Delivery not found.', 404);
      try {
        const observed = await this.observe(record);
        const comparable = (value: DeliveryRecord) => JSON.stringify([value.stage, value.reason, value.repositories.map(repo => ({
          ...repo, deployment: repo.deployment ? { ...repo.deployment, verifiedAt: Boolean(repo.deployment.verifiedAt) } : undefined
        }))]);
        if (comparable(observed) === comparable(record)) return record;
        return this.save(observed, 'system', 'observed');
      }
      catch (error) {
        const reason = error instanceof DeliveryError ? error.message : 'Delivery evidence is unavailable. Reconnect GitHub/hosting and refresh; no release action was taken.';
        if (record.stage === 'blocked' && record.reason === reason) return record;
        return this.save({ ...record, stage: 'blocked', reason }, 'system', 'blocked');
      }
    });
  }
  /** Background execution uses a human-granted scope, never a model-supplied permission. */
  async advanceAuthorized(context: WorkspaceContext, runId: string) {
    const record = runWithWorkspace(context.workspaceId, () => this.store.getOrchestrationDelivery(runId));
    if (!['dev', 'pm', 'admin'].includes(context.role)) return record;
    if (!record?.authorization || record.authorization.paused || record.authorization.actorId !== context.userId) return record;
    const action: DeliveryAction | undefined = record.stage === 'dev_approval' ? 'merge_dev' : record.stage === 'uat_prepare' ? 'prepare_uat' :
      record.stage === 'uat_approval' ? 'merge_uat' : undefined;
    if (!action) return record;
    try {
      return await this.act({ context, runId, projectId: record.projectId, expectedRevision: record.revision, action,
        key: `automatic:${action}:${record.revision}`, automatic: true });
    } catch {
      return this.serialize(context.workspaceId, runId, async () => {
        const latest = this.store.getOrchestrationDelivery(runId)!;
        if (!latest.authorization) return latest;
        const failures = (latest.authorization.failures ?? 0) + 1;
        return this.save({ ...latest, authorization: { ...latest.authorization, failures, paused: failures >= 3 || latest.authorization.paused },
          reason: failures >= 3 ? 'Automatic delivery paused after three unsuccessful actions. Review the evidence and resume when the cause is resolved.' :
            'The automatic action could not finish. Alpha will reconcile GitHub before retrying; no gate was bypassed.' }, context.userId, 'automatic_action_failed');
      });
    }
  }
  async act(input: { context: WorkspaceContext; runId: string; projectId: string; expectedRevision: number; action: DeliveryAction; key: string; automatic?: boolean }) {
    return this.serialize(input.context.workspaceId, input.runId, async () => {
      let record = this.store.getOrchestrationDelivery(input.runId);
      if (!record || record.projectId !== input.projectId) throw new DeliveryError('Delivery not found in this project.', 404);
      if (!['dev', 'pm', 'admin'].includes(input.context.role)) throw new DeliveryError('Your workspace role cannot control delivery.', 403);
      if (this.store.hasOrchestrationDeliveryAction(input.runId, `${input.key}:done`)) return record;
      if (record.revision !== input.expectedRevision) throw new DeliveryError('Delivery changed. Refresh and review the current evidence.');
      const snapshot = this.snapshot(record);
      if (input.action === 'pause_delivery') {
        if (!record.authorization) throw new DeliveryError('Automatic delivery has not been enabled.');
        return this.save({ ...record, authorization: { ...record.authorization, paused: true }, reason: 'Automatic delivery paused by a person. No further merge or promotion will be scheduled.' }, input.context.userId, `${input.key}:done`);
      }
      const grant = record.authorization;
      if (input.automatic && (!grant || grant.paused || grant.actorId !== input.context.userId ||
        grant.sources.length !== record.repositories.length || record.repositories.some(repo =>
          !grant.sources.some(source => source.repository === repo.repository && source.head === repo.head)))) {
        throw new DeliveryError('Automatic delivery has no current authorization for these source commits.', 403);
      }
      if (input.action === 'enable_uat' || input.action === 'resume_delivery') {
        this.assertIndependentReviews(snapshot, record);
        for (const target of record.repositories) this.assertPull(target, await this.github.pull(target.repository, target.prNumber), false);
        return this.save({ ...record, authorization: { actorId: input.context.userId, grantedAt: new Date().toISOString(), paused: false,
          sources: record.repositories.map(repo => ({ repository: repo.repository, head: repo.head })) },
          reason: 'Automatic delivery to UAT is enabled for these reviewed source commits. CI and independent review remain mandatory; production and client handoff are separate.' }, input.context.userId, `${input.key}:done`);
      }
      let observed = await this.observe(record);
      const commits = (item: DeliveryRecord) => JSON.stringify(item.repositories.map(repo =>
        [repo.repository, repo.head, repo.devBase, repo.devHead, repo.uatBase, repo.uatHead, repo.uatPrNumber]));
      if (commits(record) !== commits(observed)) {
        this.save(observed, 'system', 'approval_invalidated');
        throw new DeliveryError('Delivery commits changed. Refresh and review the new evidence before authorizing an action.');
      }
      const expected = { merge_dev: 'dev_approval', prepare_uat: 'uat_prepare', merge_uat: 'uat_approval', prepare_repair: 'repair_required' };
      if (observed.stage !== expected[input.action]) throw new DeliveryError(observed.reason);
      record = this.save(observed, input.context.userId, `${input.key}:requested:${input.action}`);
      if (input.action === 'prepare_repair') {
        if (record.repairRunId) return record;
        if (record.repairAttempts >= 2) throw new DeliveryError('Two repair plans have been used. Human direction is required before another build.');
        if (!this.prepareRepair) throw new DeliveryError('Repair planning is unavailable.');
        record = this.save({ ...record, repairAttempts: record.repairAttempts + 1 }, input.context.userId, 'repair_reserved');
        const repairRunId = await this.prepareRepair(record, snapshot, input.context);
        return this.save({ ...record, repairRunId, reason: 'Review the CI repair plan before allowing specialists to edit files.' }, input.context.userId, `${input.key}:done`);
      }
      // Preflight every repository before any remote mutation. Partial network
      // failures are reconciled from GitHub; retries never assume a merge failed.
      const pulls: DeliveryPull[] = [];
      for (const target of record.repositories) {
        const number = input.action === 'merge_uat' ? target.uatPrNumber! : target.prNumber;
        const pull = await this.github.pull(target.repository, number);
        this.assertPull(target, pull, input.action === 'merge_uat');
        if (input.action === 'prepare_uat') {
          await this.github.required(target.repository, 'uat');
          if (await this.github.branch(target.repository, 'uat') !== target.uatBase) throw new DeliveryError('The UAT target changed. Refresh before preparing promotion.');
        } else if (pull.merged) {
          // A prior request may have succeeded before the connection failed.
          // Its exact source is already checked above; reconcile it, never merge twice.
        } else {
          await this.github.assertScope(target.repository, number);
          const checks = await this.github.checks(target.repository, input.action === 'merge_uat' ? target.devHead! : target.head,
            input.action === 'merge_uat' ? 'uat' : 'dev', pull.merge_commit_sha);
          if (checks.state !== 'passed' || pull.mergeable !== true) throw new DeliveryError('Current PR checks or mergeability do not permit this merge.');
        }
        pulls.push(pull);
      }
      for (let i = 0; i < record.repositories.length; i++) {
        const target = record.repositories[i];
        if (input.action === 'prepare_uat') {
          if (await this.github.branch(target.repository, 'dev') !== target.devHead) throw new DeliveryError('Dev changed. Refresh before preparing UAT.');
          const promotion = await this.github.prepareUat(target.repository);
          this.assertPull(target, promotion, true);
          target.uatPrNumber = promotion.number; target.uatPrUrl = promotion.html_url; target.uatBase = promotion.base.sha;
        } else {
          const sha = await this.github.merge(target.repository, pulls[i], input.action === 'merge_uat' ? target.devHead! : target.head, pulls[i].base.sha);
          if (input.action === 'merge_uat') target.uatHead = sha; else target.devHead = sha;
        }
        record = this.save(record, input.context.userId, `${input.action}:${target.repository}`);
      }
      record = this.save({ ...record, reason: 'Authorized delivery action recorded. Waiting for fresh CI and deployment evidence.' }, input.context.userId, `${input.key}:done`);
      // Observation is deliberately separate: an unavailable API after a
      // successful merge must never encourage a duplicate remote write.
      return record;
    });
  }
}
