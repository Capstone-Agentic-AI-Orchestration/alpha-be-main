/** Delivery is distinct from a completed build and from PM/client acceptance. */
export type DeliveryStage = 'pr_checks' | 'dev_approval' | 'dev_checks' | 'uat_prepare' |
  'uat_checks' | 'uat_approval' | 'uat_deploying' | 'uat_ready' | 'repair_required' | 'blocked' | 'superseded';

export interface DeliveryCheck {
  name: string; state: 'passed' | 'pending' | 'failed'; url?: string;
}
export interface DeliveryRepository {
  repository: string; branch: string; head: string; prNumber: number; prUrl: string;
  devBase?: string; devHead?: string; uatBase?: string; uatHead?: string;
  uatPrNumber?: number; uatPrUrl?: string;
  checks: DeliveryCheck[]; requiredChecks: string[];
  deployment?: { sha: string; url: string; status: string; verifiedAt?: string };
}
export interface DeliveryRecord {
  runId: string; workspaceId: string; projectId: string; ownerId: string;
  revision: number; stage: DeliveryStage; reason: string; repositories: DeliveryRepository[];
  createdAt: string; updatedAt: string; repairAttempts: number; repairRunId?: string;
  authorization?: { actorId: string; grantedAt: string; paused: boolean; failures?: number; sources: Array<{ repository: string; head: string }> };
  history: Array<{ revision?: number; at: string; actorId: string; action: string; detail: string;
    commits?: Array<{ repository: string; source: string; devBase?: string; devHead?: string; uatBase?: string; uatHead?: string }> }>;
}
export type DeliveryAction = 'enable_uat' | 'pause_delivery' | 'resume_delivery' | 'merge_dev' | 'prepare_uat' | 'merge_uat' | 'prepare_repair';

export class DeliveryError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function deliveryPrNumber(url: string, repository: string): number {
  const prefix = `https://github.com/${repository}/pull/`;
  if (!url.startsWith(prefix) || !/^[1-9]\d*$/.test(url.slice(prefix.length))) {
    throw new DeliveryError('The publication does not contain a valid repository pull request.');
  }
  return Number(url.slice(prefix.length));
}

export function checksState(checks: DeliveryCheck[], required: string[]): 'passed' | 'pending' | 'failed' {
  if (!required.length) throw new DeliveryError('No required CI checks are configured. Configure branch protection before delivery can continue.');
  if (checks.some(check => check.state === 'failed')) return 'failed';
  if (required.some(name => !checks.some(check => check.name === name && check.state === 'passed')) ||
      checks.some(check => check.state === 'pending')) return 'pending';
  return 'passed';
}
