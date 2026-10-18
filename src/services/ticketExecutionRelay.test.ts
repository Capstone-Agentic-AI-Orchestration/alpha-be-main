import { describe, expect, it, vi } from 'vitest';
import { reviewTicketExecution } from './ticketExecutionRelay.js';

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
