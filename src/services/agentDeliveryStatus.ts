import type { DeliveryRecord } from './orchestrationDelivery.js';

/**
 * Where a build's delivery stands, for an agent.
 *
 * Agents do not merge or promote: Alpha's delivery engine does, deterministically,
 * once a person has enabled delivery for the reviewed commits, and only on
 * passing checks. What an agent needs is to see it -- which stage, why it is
 * waiting, which check failed -- so it can fix the cause on its branch.
 */
export function deliveryStatusFor(record: DeliveryRecord, projectRepos: readonly string[]) {
  const allowed = new Set(projectRepos.map(repo => repo.toLowerCase()));
  if (allowed.size && record.repositories.some(repo => !allowed.has(repo.repository.toLowerCase()))) {
    throw new Error('That build delivers to repositories outside this project.');
  }
  return {
    runId: record.runId,
    stage: record.stage,
    reason: record.reason,
    delivery: !record.authorization
      ? 'not enabled: a person has not enabled automatic delivery for these commits'
      : record.authorization.paused ? 'paused by a person' : 'enabled for the reviewed commits',
    repairAttempts: record.repairAttempts,
    repositories: record.repositories.map(repo => ({
      repository: repo.repository,
      pullRequest: repo.prUrl,
      uatPullRequest: repo.uatPrUrl ?? null,
      failedChecks: repo.checks.filter(check => check.state === 'failed').map(check => ({ name: check.name, url: check.url ?? null })),
      pendingChecks: repo.checks.filter(check => check.state === 'pending').map(check => check.name),
      uatDeployment: repo.deployment ? { status: repo.deployment.status, url: repo.deployment.url, verified: Boolean(repo.deployment.verifiedAt) } : null
    })),
    recent: record.history.slice(-10).map(entry => ({ at: entry.at, action: entry.action, detail: entry.detail }))
  };
}
