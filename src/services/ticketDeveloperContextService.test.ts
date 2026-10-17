import { describe, expect, it, vi } from 'vitest';

import type {
  TicketDeveloperContextSnapshot, TicketDeveloperContextStore, TicketDeveloperContextTransaction,
} from '../store/ticketDeveloperContextStore.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { decideTicketCommand, newTicketWorkflow } from '../ticketing/workflow.js';
import { createTicketDeveloperContextService } from './ticketDeveloperContextService.js';

const subject: TicketSubject = {
  kind: 'internal', userId: 'dev-1',
  authentication: { kind: 'session', sessionId: 'session-1' },
};

function snapshot(overrides: Partial<TicketDeveloperContextSnapshot> = {}): TicketDeveloperContextSnapshot {
  const state = newTicketWorkflow('ticket-1', 'ws-1', 'client-1');
  Object.assign(state, {
    version: 4, status: 'in_progress', scopeVersionId: 'scope-1', agreedScopeVersionId: 'scope-1',
    authorizedScopeVersionId: 'scope-1', projectId: 'project-1', requiredIssueIds: ['issue-1'],
    actionOwner: 'developer', nextAction: 'execute_work',
  });
  return {
    workspaceId: 'ws-1',
    developerProjectAccessActive: true,
    issue: {
      id: 'issue-1', workspaceId: 'ws-1', projectId: 'project-1', ticketId: 'ticket-1',
      revisionId: 'revision-1', initialRevisionId: 'revision-1', status: 'todo',
    },
    project: { id: 'project-1', workspaceId: 'ws-1', nonProductionSafe: true },
    ticket: { id: 'ticket-1', workspaceId: 'ws-1', reference: 'TCK-101', state },
    scope: {
      id: 'scope-1', ticketId: 'ticket-1', workspaceId: 'ws-1',
      developerBrief: 'Implement the approved change.', immutable: true, clientAgreed: true,
    },
    correction: null,
    ...overrides,
  };
}

function fixture(read: TicketDeveloperContextSnapshot | null) {
  const transaction = vi.fn();
  const store: TicketDeveloperContextStore = {
    transaction: <T>(work: (tx: TicketDeveloperContextTransaction) => Promise<T>) => {
      transaction();
      return work({ loadAuthorizedWorkContext: async () => read });
    },
  };
  return { store, transaction, service: createTicketDeveloperContextService(store) };
}

function correctedSnapshot(): TicketDeveloperContextSnapshot {
  const value = snapshot(); value.issue.revisionId = 'revision-2';
  value.correction = {
    workspaceId: 'ws-1', ticketId: 'ticket-1', projectId: 'project-1', issueId: 'issue-1', scopeVersionId: 'scope-1',
    issueRevisionId: 'revision-2', previousRevisionId: 'revision-1', developerInstructions: 'Fix the agreed validation behavior.',
    source: 'request_fixes', immutable: true, authorizedByPmId: 'pm-1', authorizedAt: '2026-10-08T03:00:00.000Z',
  };
  return value;
}

describe('ticket developer work context', () => {
  it('returns the current correction instructions separately from the unchanged approved scope', async () => {
    const value = correctedSnapshot();
    Object.assign(value.correction!, { clientEmail: 'private@example.test', privateNote: 'Not a developer instruction.' });
    const result = await fixture(value).service.read('ws-1', 'issue-1', subject);
    expect(result.brief).toBe('Implement the approved change.');
    expect(result.issueRevisionId).toBe('revision-2');
    expect(result.correction).toEqual({ instructions: 'Fix the agreed validation behavior.', authorizedAt: '2026-10-08T03:00:00.000Z' });
    expect(result).not.toHaveProperty('authorizedByPmId');
  });

  it.each(['workspaceId', 'ticketId', 'projectId', 'issueId', 'scopeVersionId', 'issueRevisionId'] as const)('refuses a correction brief with mismatched %s', async field => {
    const value = correctedSnapshot(); value.correction![field] = 'other';
    await expect(fixture(value).service.read('ws-1', 'issue-1', subject)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it.each(['missing', 'mutable', 'blank', 'too-long', 'same-revision', 'invalid-time', 'unexpected-on-initial'])('fails closed on %s correction evidence', async condition => {
    const value = correctedSnapshot();
    if (condition === 'mutable') value.correction!.immutable = false as true;
    if (condition === 'blank') value.correction!.developerInstructions = ' ';
    if (condition === 'too-long') value.correction!.developerInstructions = 'x'.repeat(4001);
    if (condition === 'same-revision') value.correction!.previousRevisionId = 'revision-2';
    if (condition === 'invalid-time') value.correction!.authorizedAt = 'invalid';
    if (condition === 'missing') value.correction = null;
    if (condition === 'unexpected-on-initial') value.issue.initialRevisionId = 'revision-2';
    await expect(fixture(value).service.read('ws-1', 'issue-1', subject)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it('does not provide execution context while the client withdrawal is unresolved', async () => {
    const value = snapshot(); value.ticket.state.withdrawalRequested = true;
    await expect(fixture(value).service.read('ws-1', 'issue-1', subject)).rejects.toMatchObject({ code: 'ticket_work_not_authorized' });
  });
  it.each([['pm', 'reply'], ['client', 'reply']] as const)('retains approved work during ordinary %s conversation', async (owner, action) => {
    const value = snapshot();
    value.ticket.state.actionOwner = owner; value.ticket.state.nextAction = action;
    await expect(fixture(value).service.read('ws-1', 'issue-1', subject)).resolves.toMatchObject({ issueRevisionId: 'revision-1' });
  });
  it('preserves approved work context across the real client-reply workflow transition', async () => {
    const value = snapshot(); const state = value.ticket.state;
    const actor = { kind: 'client' as const, userId: 'client-1', workspaceId: 'ws-1', ticketId: state.id, grantActive: true };
    value.ticket.state = decideTicketCommand(state, actor,
      { schemaVersion: 1, operationId: 'client-reply', expectedVersion: state.version, command: { type: 'reply', messageId: 'message-1' } },
      { message: { id: 'message-1', ticketId: state.id, authorId: actor.userId, audience: 'client' } }, 'enabled').state;
    expect(value.ticket.state.actionOwner).toBe('pm');
    await expect(fixture(value).service.read('ws-1', 'issue-1', subject)).resolves.toMatchObject({ issueRevisionId: 'revision-1', ticketVersion: 5 });
  });
  it.each(['on_hold', 'under_review', 'ready_for_review', 'closed', 'cancelled', 'declined'] as const)('still blocks work at %s', async status => {
    const value = snapshot(); value.ticket.state.status = status;
    await expect(fixture(value).service.read('ws-1', 'issue-1', subject)).rejects.toMatchObject({ code: 'ticket_work_not_authorized' });
  });
  it('returns only the authorized issue and its current approved brief', async () => {
    const { service, transaction } = fixture(snapshot());

    await expect(service.read('ws-1', 'issue-1', subject)).resolves.toEqual({
      ticketReference: 'TCK-101', ticketVersion: 4, issueId: 'issue-1', projectId: 'project-1',
      issueRevisionId: 'revision-1', scopeVersionId: 'scope-1', brief: 'Implement the approved change.', correction: null,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('does not reveal an inaccessible or absent issue', async () => {
    const { service } = fixture(null);
    await expect(service.read('ws-1', 'issue-1', subject)).rejects.toMatchObject({ status: 404, code: 'ticket_not_found' });
  });

  it('treats a store snapshot without current project access as corrupt evidence', async () => {
    const value = snapshot({ developerProjectAccessActive: false });
    const { service } = fixture(value);
    await expect(service.read('ws-1', 'issue-1', subject)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });

  it.each([
    ['unapproved scope', snapshot({ scope: { ...snapshot().scope, clientAgreed: false } })],
    ['unsafe project', snapshot({ project: { ...snapshot().project, nonProductionSafe: false } })],
  ])('refuses %s context', async (_label, value) => {
    const { service } = fixture(value);
    await expect(service.read('ws-1', 'issue-1', subject)).rejects.toMatchObject({ status: 409, code: 'ticket_work_not_authorized' });
  });

  it('refuses a client subject before reading the store', async () => {
    const { service, transaction } = fixture(snapshot());
    const client: TicketSubject = { kind: 'client', userId: 'client-1', sessionId: 'client-session-1' };

    await expect(service.read('ws-1', 'issue-1', client)).rejects.toMatchObject({ status: 404, code: 'ticket_not_found' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
