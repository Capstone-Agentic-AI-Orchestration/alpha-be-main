import { describe, expect, it, vi } from 'vitest';
import { admitTicketExecution, reserveTicketExecution, reviewTicketExecution, TicketExecutionRelayError, type TicketExecutionHandle } from './ticketExecutionRelay.js';

const input = { workspaceId: 'workspace-a', issueId: 'issue-a', runId: 'run-a' };
function reply(status: number, body: unknown) { return { status, body }; }
function requestFor(result: unknown) {
  return vi.fn(async (path: string) => path.endsWith('workflow-capabilities')
    ? reply(200, { phaseWorkflowEnabled: true })
    : reply(200, result));
}

describe('ticket run review relay', () => {
  it('keeps unlinked work on the ordinary review path', async () => {
    const request = requestFor({ kind: 'unlinked' });
    await expect(reviewTicketExecution({ ...input, decision: 'passed' }, request, true)).resolves.toEqual({ kind: 'unlinked' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('records passed review only when the cloud returns a readiness decision', async () => {
    const request = requestFor({ kind: 'ticket', ready: false });
    await expect(reviewTicketExecution({ ...input, decision: 'passed' }, request, true)).resolves.toEqual({ kind: 'ticket', ready: false });
    expect(request).toHaveBeenLastCalledWith('/ticket-work/issues/issue-a/review', expect.objectContaining({
      method: 'POST', workspaceId: 'workspace-a', body: { runId: 'run-a', decision: 'passed' },
    }));
  });

  it('records request-changes only after the durable claim is stopped', async () => {
    const request = requestFor({ kind: 'ticket', stopped: true });
    await expect(reviewTicketExecution({ ...input, decision: 'changes_requested' }, request, true)).resolves.toEqual({ kind: 'ticket', stopped: true });
  });

  it('treats an old backend as a compatibility fallback but fails closed on malformed enabled responses', async () => {
    const oldBackend = vi.fn(async () => reply(404, { error: 'not found' }));
    await expect(reviewTicketExecution({ ...input, decision: 'passed' }, oldBackend, true)).resolves.toEqual({ kind: 'unavailable' });
    const malformed = requestFor({ kind: 'ticket' });
    await expect(reviewTicketExecution({ ...input, decision: 'passed' }, malformed, true)).rejects.toMatchObject({ status: 502 });
  });
});

const reservationInput = {
  workspaceId: 'workspace-a', issueId: 'issue-a', projectId: 'project-a', runId: 'prototype-run-a',
  executor: { kind: 'agent' as const, id: 'agent-a' },
};
const workContext = {
  ticketReference: 'TKT-1', ticketVersion: 7, issueId: 'issue-a', projectId: 'project-a',
  issueRevisionId: 'revision-a', scopeVersionId: 'scope-a', brief: 'Approved work only.', correction: null,
};
function reservationRequest(capability: unknown, reservation: unknown) {
  return vi.fn(async (path: string) => path.endsWith('workflow-capabilities')
    ? reply(200, capability) : reply(200, reservation));
}
function ticketReservation(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ticket', workspaceId: 'workspace-a', claimId: 'claim-a', issueRevisionId: 'revision-a',
    runId: 'prototype-run-a', workContext, ...overrides,
  };
}
const handle: TicketExecutionHandle = {
  workspaceId: 'workspace-a', issueId: 'issue-a', projectId: 'project-a', issueRevisionId: 'revision-a',
  scopeVersionId: 'scope-a', claimId: 'claim-a', runId: 'prototype-run-a',
  executor: { kind: 'agent', id: 'agent-a' }, memberOrder: 0,
};

describe('ticket run reservation and admission relay', () => {
  it('keeps ordinary standalone desktop tasks on their existing runner path', async () => {
    const request = vi.fn();
    await expect(reserveTicketExecution(reservationInput, request, false)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('positively classifies unbound tasks even when the ticket workflow flag is off', async () => {
    const request = reservationRequest({ phaseWorkflowEnabled: false }, { kind: 'unlinked' });
    await expect(reserveTicketExecution(reservationInput, request, true)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('/ticket-work/issues/issue-a/reservations', expect.objectContaining({
      method: 'POST', workspaceId: 'workspace-a', body: expect.objectContaining({ runId: 'prototype-run-a', executor: reservationInput.executor }),
    }));
  });

  it('fails closed for bound work when the ticket workflow is disabled', async () => {
    const request = vi.fn(async (path: string) => path.endsWith('workflow-capabilities')
      ? reply(200, { phaseWorkflowEnabled: false }) : reply(503, { error: 'Project-linked ticket execution is not enabled.' }));
    await expect(reserveTicketExecution(reservationInput, request, true)).rejects.toBeInstanceOf(TicketExecutionRelayError);
  });

  it('fails closed when the cloud is too old to classify whether a task is ticket-bound', async () => {
    const request = vi.fn(async () => reply(404, { error: 'not found' }));
    await expect(reserveTicketExecution(reservationInput, request, true)).rejects.toMatchObject({
      name: 'TicketExecutionRelayError', status: undefined,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('binds the reservation to the requested workspace, project, run and immutable revision', async () => {
    const request = reservationRequest({ phaseWorkflowEnabled: true }, ticketReservation());
    await expect(reserveTicketExecution(reservationInput, request, true)).resolves.toEqual({ ...handle });
  });

  it.each([
    ['workspace', { workspaceId: 'workspace-b' }],
    ['project', { workContext: { ...workContext, projectId: 'project-b' } }],
    ['run', { runId: 'different-run' }],
    ['revision', { issueRevisionId: 'different-revision' }],
  ])('rejects a reservation with a mismatched %s identity', async (_field, mismatch) => {
    const request = reservationRequest({ phaseWorkflowEnabled: true }, ticketReservation(mismatch));
    await expect(reserveTicketExecution(reservationInput, request, true)).rejects.toMatchObject({ status: 502 });
  });

  it('rechecks run, project, scope and revision at queue admission', async () => {
    const request = vi.fn(async () => reply(200, { launch: true, workspaceId: 'workspace-a', runId: 'prototype-run-a', workContext }));
    await expect(admitTicketExecution(handle, request)).resolves.toMatchObject({ launch: true, workContext });
    expect(request).toHaveBeenCalledWith('/ticket-work/issues/issue-a/admissions', expect.objectContaining({
      method: 'POST', workspaceId: 'workspace-a', body: expect.objectContaining({ runId: 'prototype-run-a', claimId: 'claim-a' }),
    }));

    const drifted = vi.fn(async () => reply(200, { launch: true, workspaceId: 'workspace-a', runId: 'prototype-run-a',
      workContext: { ...workContext, scopeVersionId: 'new-scope' } }));
    await expect(admitTicketExecution(handle, drifted)).rejects.toMatchObject({ name: 'TicketExecutionRelayError' });
  });
});
