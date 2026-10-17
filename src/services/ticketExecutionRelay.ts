import { randomUUID } from 'node:crypto';
import { cloudRequest, usesCloudDirectory } from './cloudWorkspaces.js';
import type { TicketExecutor } from '../store/ticketExecutionAdmissionStore.js';
import type { DeveloperTicketWorkContext } from '../ticketing/developerContext.js';

type RelayAnswer = { status: number; body: unknown };
type RelayRequest = (path: string, init: {
  method?: string; body?: unknown; workspaceId?: string; timeoutMs?: number;
}) => Promise<RelayAnswer>;

export interface TicketExecutionHandle {
  workspaceId: string;
  issueId: string;
  claimId: string;
  runId: string;
  executor: TicketExecutor;
  memberOrder: number;
}

export type TicketRunReviewDecision = 'passed' | 'changes_requested';
export type TicketRunReviewResult =
  | { kind: 'unlinked' }
  | { kind: 'unavailable' }
  | { kind: 'ticket'; ready?: boolean; stopped?: boolean };

export class TicketExecutionRelayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TicketExecutionRelayError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function validWorkContext(value: unknown, workspaceId: string, issueId: string): value is DeveloperTicketWorkContext {
  const context = record(value);
  const correction = context && (context.correction === null ? null : record(context.correction));
  return Boolean(context
    && typeof context.ticketReference === 'string' && context.ticketReference.length > 0 && context.ticketReference.length <= 200
    && Number.isSafeInteger(context.ticketVersion) && (context.ticketVersion as number) >= 0
    && context.issueId === issueId && typeof context.projectId === 'string' && context.projectId.length > 0
    && typeof context.issueRevisionId === 'string' && context.issueRevisionId.length > 0
    && typeof context.scopeVersionId === 'string' && context.scopeVersionId.length > 0
    && typeof context.brief === 'string' && context.brief.trim().length > 0 && context.brief.length <= 12000
    && (context.correction === null || Boolean(correction
      && typeof correction.instructions === 'string' && correction.instructions.trim().length > 0
      && correction.instructions.length <= 4000
      && typeof correction.authorizedAt === 'string' && Number.isFinite(Date.parse(correction.authorizedAt))))
    && Boolean(workspaceId));
}

/**
 * Ask the cloud to classify and reserve work before the local runner mutates an
 * Issue or spawns a process. A positively unlinked Issue keeps using the
 * existing runner. Once the cloud says the feature is on, every malformed or
 * denied response fails closed.
 */
export async function reserveTicketExecution(input: {
  workspaceId: string;
  issueId: string;
  runId: string;
  executor: TicketExecutor;
  memberOrder?: number;
}, request: RelayRequest = cloudRequest, cloudAvailable = usesCloudDirectory()): Promise<TicketExecutionHandle | null> {
  if (!cloudAvailable) return null;
  const capability = await request('/ticket-work/workflow-capabilities', {
    workspaceId: input.workspaceId,
    timeoutMs: 10_000,
  });
  // Older cloud versions and environments without ticket triage are not Phase
  // 7--9 deployments. Preserve their existing, unlinked Issue behavior.
  if (capability.status === 404 || capability.status === 503) return null;
  const capabilities = record(capability.body);
  if (capability.status !== 200 || typeof capabilities?.phaseWorkflowEnabled !== 'boolean') {
    throw new TicketExecutionRelayError('Could not verify ticket execution access. Refresh and try again.', capability.status);
  }
  if (!capabilities.phaseWorkflowEnabled) return null;

  const answer = await request(`/ticket-work/issues/${encodeURIComponent(input.issueId)}/reservations`, {
    method: 'POST',
    workspaceId: input.workspaceId,
    body: {
      operationId: `ticket-reserve-${randomUUID()}`,
      executor: input.executor,
      runId: input.runId,
    },
  });
  const result = record(answer.body);
  if (answer.status !== 200 || !result) {
    throw new TicketExecutionRelayError('This ticket-linked Issue could not be safely reserved. Refresh and try again.', answer.status);
  }
  if (result.kind === 'unlinked') return null;
  if (result.kind !== 'ticket' || typeof result.claimId !== 'string' || !result.claimId.trim()
    || result.runId !== input.runId || !validWorkContext(result.workContext, input.workspaceId, input.issueId)) {
    throw new TicketExecutionRelayError('The cloud returned an invalid ticket execution reservation. Do not retry until it is reconciled.', 502);
  }
  return {
    workspaceId: input.workspaceId,
    issueId: input.issueId,
    claimId: result.claimId,
    runId: input.runId,
    executor: input.executor,
    memberOrder: input.memberOrder ?? 0,
  };
}

/** Re-check membership, project access, scope and revision at the queue front. */
export async function admitTicketExecution(
  handle: TicketExecutionHandle,
  request: RelayRequest = cloudRequest,
): Promise<{ launch: boolean; workContext: DeveloperTicketWorkContext }> {
  const answer = await request(`/ticket-work/issues/${encodeURIComponent(handle.issueId)}/admissions`, {
    method: 'POST',
    workspaceId: handle.workspaceId,
    body: {
      claimId: handle.claimId,
      runId: handle.runId,
      executor: handle.executor,
      memberOrder: handle.memberOrder,
    },
  });
  const result = record(answer.body);
  if (answer.status !== 200 || !result || typeof result.launch !== 'boolean'
    || !validWorkContext(result.workContext, handle.workspaceId, handle.issueId)) {
    throw new TicketExecutionRelayError('Ticket work authorization changed or could not be verified. The agent was not started.', answer.status);
  }
  return { launch: result.launch, workContext: result.workContext };
}

/** Release a reservation only after local state says its run is terminal. */
export async function stopTicketExecution(handle: TicketExecutionHandle, request: RelayRequest = cloudRequest): Promise<void> {
  const answer = await request(`/ticket-work/issues/${encodeURIComponent(handle.issueId)}/claims/${encodeURIComponent(handle.claimId)}/stop`, {
    method: 'POST',
    workspaceId: handle.workspaceId,
    body: { runId: handle.runId },
  });
  if (answer.status !== 200 || record(answer.body)?.stopped !== true) {
    throw new TicketExecutionRelayError('The ticket execution claim remains active and needs reconciliation.', answer.status);
  }
}

/** Persist a human run decision with the cloud ticket authority. A missing or
 * older workflow endpoint preserves ordinary, unlinked Issue behavior; once
 * the cloud advertises this workflow, malformed/denied responses fail closed. */
export async function reviewTicketExecution(input: {
  workspaceId: string;
  issueId: string;
  runId: string;
  decision: TicketRunReviewDecision;
}, request: RelayRequest = cloudRequest, cloudAvailable = usesCloudDirectory()): Promise<TicketRunReviewResult> {
  if (!cloudAvailable) return { kind: 'unavailable' };
  const capability = await request('/ticket-work/workflow-capabilities', {
    workspaceId: input.workspaceId,
    timeoutMs: 10_000,
  });
  if (capability.status === 404 || capability.status === 503) return { kind: 'unavailable' };
  const capabilities = record(capability.body);
  if (capability.status !== 200 || typeof capabilities?.phaseWorkflowEnabled !== 'boolean') {
    throw new TicketExecutionRelayError('Could not verify ticket review access. Refresh and try again.', capability.status);
  }
  if (!capabilities.phaseWorkflowEnabled) return { kind: 'unavailable' };

  const answer = await request(`/ticket-work/issues/${encodeURIComponent(input.issueId)}/review`, {
    method: 'POST',
    workspaceId: input.workspaceId,
    body: { runId: input.runId, decision: input.decision },
  });
  const result = record(answer.body);
  if (answer.status !== 200 || !result) {
    throw new TicketExecutionRelayError('The cloud could not record the ticket-linked run review. Retry after checking the run state.', answer.status);
  }
  if (result.kind === 'unlinked') return { kind: 'unlinked' };
  if (result.kind !== 'ticket'
    || input.decision === 'passed' && typeof result.ready !== 'boolean'
    || input.decision === 'changes_requested' && result.stopped !== true) {
    throw new TicketExecutionRelayError('The cloud returned an invalid ticket review receipt. Reconcile this run before retrying.', 502);
  }
  return input.decision === 'passed'
    ? { kind: 'ticket', ready: result.ready as boolean }
    : { kind: 'ticket', stopped: true };
}
