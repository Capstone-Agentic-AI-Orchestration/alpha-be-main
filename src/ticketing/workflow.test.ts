import { describe, expect, it } from 'vitest';

import {
  decideTechnicalReadiness, decideTicketCommand, newTicketWorkflow, parseTicketCommand, TicketWorkflowError,
  type TicketActor, type TicketCommand, type TicketFacts, type TicketIssueEvidence, type TicketWorkflow,
} from './workflow.js';

const pm: TicketActor = { kind: 'pm', userId: 'pm-a', workspaceId: 'workspace-a', membershipActive: true, canManageTickets: true };
const client: TicketActor = { kind: 'client', userId: 'client-a', workspaceId: 'workspace-a', ticketId: 'ticket-a', grantActive: true };
const developer: TicketActor = { kind: 'developer', userId: 'dev-a', workspaceId: 'workspace-a' };
const execution = {
  kind: 'execution' as const, userId: 'dev-a', workspaceId: 'workspace-a', ticketId: 'ticket-a',
  issueId: 'issue-a', issueRevisionId: 'revision-a', authorized: true,
};
function issue(id: string, revisionId: string, status: TicketIssueEvidence['status'] = 'done'): TicketIssueEvidence {
  return {
    id, revisionId, ticketId: 'ticket-a', workspaceId: 'workspace-a', projectId: 'project-a', scopeVersionId: 'scope-a',
    status, hasActiveRun: false, requiredReviewsPassed: status === 'done',
  };
}
function evidence(): TicketFacts {
  return {
    clientAccessActive: true,
    project: { id: 'project-a', workspaceId: 'workspace-a', creatorActive: true, nonProductionSafe: true },
    issues: [issue('issue-a', 'revision-a'), issue('issue-b', 'revision-b')],
    scope: { id: 'scope-a', ticketId: 'ticket-a', workspaceId: 'workspace-a' },
    delivery: { id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'build-a', immutable: true, issueRevisionIds: ['revision-a', 'revision-b'] },
  };
}
function startableEvidence(): TicketFacts {
  const facts = evidence();
  facts.issues = facts.issues!.map(item => ({ ...item, status: 'todo', requiredReviewsPassed: false }));
  return facts;
}
function completedEvidence(): TicketFacts {
  return evidence();
}
function message(author: TicketActor, overrides: Partial<NonNullable<TicketFacts['message']>> = {}): NonNullable<TicketFacts['message']> {
  return { id: 'message-a', ticketId: 'ticket-a', authorId: author.userId, audience: 'client', ...overrides };
}
function envelope(state: TicketWorkflow, command: TicketCommand, overrides = {}) {
  return { schemaVersion: 1, operationId: `operation-${state.version}-${command.type}`, expectedVersion: state.version, command, ...overrides };
}
function decide(state: TicketWorkflow, command: TicketCommand, actor: TicketActor = pm, facts: TicketFacts = evidence()) {
  return decideTicketCommand(state, actor, envelope(state, command), facts, 'enabled');
}
function agreedWork(): TicketWorkflow {
  let state = newTicketWorkflow('ticket-a', 'workspace-a', 'client-a');
  state = decide(state, { type: 'review' }).state;
  state = decide(state, { type: 'propose_scope', scopeVersionId: 'scope-a' }).state;
  return decide(state, { type: 'agree_scope', scopeVersionId: 'scope-a' }, client).state;
}
function startWork(): TicketWorkflow {
  const state = agreedWork();
  return decide(state, { type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'] }, pm, startableEvidence()).state;
}
function ready(): TicketWorkflow {
  let state = startWork();
  const facts = completedEvidence();
  state = decide(state, { type: 'assess_delivery', deliveryId: 'delivery-a' }, pm, facts).state;
  return decide(state, { type: 'share_delivery', deliveryId: 'delivery-a' }, pm, facts).state;
}
function expectRefusal(fn: () => unknown, status: number, code: string) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(TicketWorkflowError);
    expect(error).toMatchObject({ status, code });
    return;
  }
  throw new Error('Expected the ticket decision to be refused.');
}

describe('one ticket from inquiry to completion', () => {
  it('begins with a PM review, without creating or authorizing work', () => {
    const state = newTicketWorkflow('ticket-a', 'workspace-a');
    expect(state).toMatchObject({ status: 'received', actionOwner: 'pm', version: 0, projectId: null, requiredIssueIds: [], authorizedScopeVersionId: null });
    expect(decide(state, { type: 'review' }).state).toMatchObject({ id: 'ticket-a', status: 'under_review', clientId: null });
    // Questions still need a client who can answer them.
    expectRefusal(() => decide(state, { type: 'request_details', messageId: 'message-a' }), 409, 'client_access_inactive');
  });

  it("treats a PM's first real action on a new request as the review", () => {
    const state = newTicketWorkflow('ticket-a', 'workspace-a', 'client-a');
    const facts = { ...evidence(), message: message(pm) };
    expect(decide(state, { type: 'request_details', messageId: 'message-a' }, pm, facts).state)
      .toMatchObject({ status: 'awaiting_client', actionOwner: 'client', nextAction: 'reply' });
    expect(decide(state, { type: 'reply', messageId: 'message-a' }, pm, facts).state)
      .toMatchObject({ status: 'under_review', actionOwner: 'pm', nextAction: 'review_ticket' });
    expect(decide(state, { type: 'propose_scope', scopeVersionId: 'scope-a' }).state)
      .toMatchObject({ status: 'awaiting_client', actionOwner: 'client', nextAction: 'agree_scope', scopeApprovedBy: null });
    expect(decide(state, { type: 'answer_close', messageId: 'message-a' }, pm, facts).state)
      .toMatchObject({ status: 'closed', closureReason: 'answered' });
  });

  it('lets the PM skip client approval when sending the plan', () => {
    const state = newTicketWorkflow('ticket-a', 'workspace-a', 'client-a');
    const planned = decide(state, { type: 'propose_scope', scopeVersionId: 'scope-a', clientApproval: 'skipped' });
    expect(planned.state).toMatchObject({
      status: 'under_review', scopeVersionId: 'scope-a', agreedScopeVersionId: 'scope-a', scopeApprovedBy: 'pm',
      authorizedScopeVersionId: null, actionOwner: 'pm', nextAction: 'authorize_work',
    });
    expect(planned.event).toMatchObject({ type: 'propose_scope', actorKind: 'pm' });
    expect(decide(planned.state, {
      type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'],
    }, pm, startableEvidence()).state).toMatchObject({ status: 'in_progress', nextAction: 'execute_work' });
    expectRefusal(() => decide(planned.state, { type: 'agree_scope', scopeVersionId: 'scope-a' }, client), 409, 'scope_already_agreed');
  });

  it('lets the PM stop waiting for approval of a plan already sent', () => {
    const proposed = decide(newTicketWorkflow('ticket-a', 'workspace-a', 'client-a'), { type: 'propose_scope', scopeVersionId: 'scope-a' }).state;
    expectRefusal(() => decide(proposed, { type: 'skip_scope_approval', scopeVersionId: 'scope-a' }, client), 403, 'ticket_action_forbidden');
    expectRefusal(() => decide(proposed, { type: 'skip_scope_approval', scopeVersionId: 'scope-b' }), 409, 'scope_not_current');
    const skipped = decide(proposed, { type: 'skip_scope_approval', scopeVersionId: 'scope-a' }).state;
    expect(skipped).toMatchObject({ status: 'under_review', agreedScopeVersionId: 'scope-a', scopeApprovedBy: 'pm', nextAction: 'authorize_work' });
    expectRefusal(() => decide(skipped, { type: 'skip_scope_approval', scopeVersionId: 'scope-a' }), 409, 'scope_already_agreed');
    expect(agreedWork()).toMatchObject({ scopeApprovedBy: 'client' });
  });

  it('records agreement without launching work, then separately authorizes it', () => {
    const state = newTicketWorkflow('ticket-a', 'workspace-a', 'client-a');
    const reviewed = decide(state, { type: 'review' }).state;
    const proposed = decide(reviewed, { type: 'propose_scope', scopeVersionId: 'scope-a' }).state;
    const agreed = decide(proposed, { type: 'agree_scope', scopeVersionId: 'scope-a' }, client).state;
    expect(agreed).toMatchObject({ status: 'under_review', agreedScopeVersionId: 'scope-a', authorizedScopeVersionId: null, projectId: null, requiredIssueIds: [], nextAction: 'authorize_work' });
    expect(startWork()).toMatchObject({ status: 'in_progress', authorizedScopeVersionId: 'scope-a', projectId: 'project-a', requiredIssueIds: ['issue-a', 'issue-b'] });
  });

  it('allows PM project organization before scope agreement and requires work to stay in that project', () => {
    const state = newTicketWorkflow('ticket-a', 'workspace-a', 'client-a');
    state.projectId = 'project-a';
    const reviewed = decide(state, { type: 'review' }).state;
    const proposed = decide(reviewed, { type: 'propose_scope', scopeVersionId: 'scope-a' }).state;
    const agreed = decide(proposed, { type: 'agree_scope', scopeVersionId: 'scope-a' }, client).state;
    const facts = startableEvidence();
    expect(decide(agreed, {
      type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'],
    }, pm, facts).state).toMatchObject({ projectId: 'project-a', status: 'in_progress' });
    expectRefusal(() => decide(agreed, {
      type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-b', issueIds: ['issue-a', 'issue-b'],
    }, pm, facts), 409, 'ticket_project_conflict');
  });

  it.each(['in_progress', 'agent_running', 'review', 'done'] as const)(
    'refuses initial authorization when a linked Issue is already %s', status => {
      const facts = startableEvidence();
      facts.issues = [facts.issues![0], { ...facts.issues![1], status }];
      expectRefusal(() => decide(agreedWork(), {
        type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'],
      }, pm, facts), 409, 'ticket_issue_not_startable');
    },
  );

  it('allows a fresh backlog Issue to be authorized', () => {
    const facts = startableEvidence();
    facts.issues = facts.issues!.map(item => ({ ...item, status: 'backlog' }));
    expect(decide(agreedWork(), {
      type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'],
    }, pm, facts).state.status).toBe('in_progress');
  });

  it('refuses an otherwise-new Issue while a run is active', () => {
    const facts = startableEvidence();
    facts.issues = [facts.issues![0], { ...facts.issues![1], hasActiveRun: true }];
    expectRefusal(() => decide(agreedWork(), {
      type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'],
    }, pm, facts), 409, 'ticket_issue_not_startable');
  });

  it.each([true, undefined])('fails closed when active-run evidence is %s', hasActiveRun => {
    const facts = startableEvidence();
    facts.issues = [facts.issues![0], { ...facts.issues![1], hasActiveRun: hasActiveRun as boolean }];
    expectRefusal(() => decide(agreedWork(), {
      type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'],
    }, pm, facts), 409, 'ticket_issue_not_startable');
  });

  it('routes technical completion to PM assessment, not sharing or closure', () => {
    const state = startWork();
    const facts = completedEvidence();
    const decision = decideTechnicalReadiness(state, execution, 'operation-completed', state.version, facts, 'enabled');
    expect(decision.state).toMatchObject({ status: 'in_progress', actionOwner: 'pm', nextAction: 'assess_result', delivery: null, closureReason: null });
    expect(decision.event).toMatchObject({ type: 'technical_work_ready', actorKind: 'execution' });
    expect(decision.reopenIssueIds).toEqual([]);
    expect(state.actionOwner).toBe('developer');
    expectRefusal(() => decide(decision.state, { type: 'share_delivery', deliveryId: 'delivery-a' }, pm, facts), 409, 'delivery_not_current');
  });

  it('keeps PM assessment and sharing distinct, and closes on client acceptance', () => {
    const started = startWork();
    const facts = completedEvidence();
    const assessed = decide(started, { type: 'assess_delivery', deliveryId: 'delivery-a' }, pm, facts).state;
    expect(assessed).toMatchObject({ status: 'in_progress', actionOwner: 'pm', nextAction: 'share_result', delivery: { shared: false, acceptedByClientId: null } });
    const shared = decide(assessed, { type: 'share_delivery', deliveryId: 'delivery-a' }, pm, facts).state;
    expectRefusal(() => decide(shared, { type: 'close_accepted', deliveryId: 'delivery-a' }), 409, 'client_acceptance_required');
    const accepted = decide(shared, { type: 'accept_delivery', deliveryId: 'delivery-a' }, client);
    expect(accepted.state).toMatchObject({ status: 'closed', closureReason: 'accepted', actionOwner: null, nextAction: null, delivery: { acceptedByClientId: 'client-a' } });
    expect(Object.keys(accepted).sort()).toEqual(['event', 'reopenIssueIds', 'state']);
    expect(accepted.state).not.toHaveProperty('projectCompleted');
    expect(accepted.state).not.toHaveProperty('releaseAuthorized');
    expectRefusal(() => decide(accepted.state, { type: 'close_accepted', deliveryId: 'delivery-a' }), 409, 'ticket_is_read_only');
  });

  it('still lets a PM close a request accepted before automatic closure', () => {
    const facts = completedEvidence();
    const legacy = { ...ready(), delivery: { ...ready().delivery!, acceptedByClientId: 'client-a' }, actionOwner: 'pm' as const, nextAction: 'close_ticket' as const };
    expect(decide(legacy, { type: 'close_accepted', deliveryId: 'delivery-a' }, pm, facts).state)
      .toMatchObject({ status: 'closed', closureReason: 'accepted' });
  });

  it('records public clarification and leaves ordinary implementation replies in progress', () => {
    const reviewed = decide(newTicketWorkflow('ticket-a', 'workspace-a', 'client-a'), { type: 'review' }).state;
    const waiting = decide(reviewed, { type: 'request_details', messageId: 'message-a' }, pm, { ...evidence(), message: message(pm) }).state;
    expect(waiting).toMatchObject({ status: 'awaiting_client', actionOwner: 'client', nextAction: 'reply' });
    expect(decide(waiting, { type: 'reply', messageId: 'message-a' }, client, { ...evidence(), message: message(client) }).state)
      .toMatchObject({ status: 'under_review', actionOwner: 'pm' });
    const active = startWork();
    const replied = decide(active, { type: 'reply', messageId: 'message-a' }, client, { ...evidence(), message: message(client) }).state;
    expect(replied).toMatchObject({ status: 'in_progress', authorizedScopeVersionId: 'scope-a', requiredIssueIds: active.requiredIssueIds });
    const update = decide(active, { type: 'reply', messageId: 'message-a' }, pm, { ...evidence(), message: message(pm) }).state;
    expect(update).toMatchObject({ status: 'in_progress', actionOwner: 'developer', nextAction: 'execute_work' });
  });
});

describe('review failures and changed work', () => {
  it('cannot replace the authorized Issue manifest by repeating initial authorization during correction triage', () => {
    const feedback = decide(ready(), { type: 'request_correction', deliveryId: 'delivery-a', messageId: 'message-a' }, client, { ...evidence(), message: message(client) }).state;
    const facts = evidence(); facts.issues = [issue('issue-a', 'revision-a')];
    expectRefusal(() => decide(feedback, { type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a'] }, pm, facts), 409, 'work_already_authorized');
    expect(feedback.requiredIssueIds).toEqual(['issue-a', 'issue-b']);
    expect(feedback.correctionRequestedFor).toBe('delivery-a');
  });

  it('cannot overwrite correction triage by agreeing an already-agreed scope again', () => {
    const feedback = decide(ready(), { type: 'request_correction', deliveryId: 'delivery-a', messageId: 'message-a' }, client, { ...evidence(), message: message(client) }).state;
    expectRefusal(() => decide(feedback, { type: 'agree_scope', scopeVersionId: 'scope-a' }, client), 409, 'scope_already_agreed');
  });

  it.each(['request_fixes', 'authorize_correction'] as const)('allows %s for selected project Issues without named Issue assignees', type => {
    const state = type === 'request_fixes' ? startWork()
      : decide(ready(), { type: 'request_correction', deliveryId: 'delivery-a', messageId: 'message-a' }, client, { ...evidence(), message: message(client) }).state;
    const facts = evidence(); facts.issues = [issue('issue-a', 'revision-a'), issue('issue-b', 'revision-b')];
    const command = type === 'request_fixes' ? { type, issueIds: ['issue-b'], reason: 'Correct this result' }
      : { type, deliveryId: 'delivery-a', issueIds: ['issue-b'], reason: 'Correct the agreed behavior described by the client.' };
    const decision = decide(state, command, pm, facts);
    expect(decision.reopenIssueIds).toEqual(['issue-b']);
    expect(decision.state.requiredIssueIds).toEqual(['issue-a', 'issue-b']);
    expect(facts.issues[0].status).toBe('done');
  });

  it('triages client feedback before reopening only the affected Issue', () => {
    const shared = ready();
    const feedback = decide(shared, { type: 'request_correction', deliveryId: 'delivery-a', messageId: 'message-a' }, client, { ...evidence(), message: message(client) });
    expect(feedback.state).toMatchObject({ status: 'under_review', nextAction: 'triage_correction', correctionRequestedFor: 'delivery-a' });
    expect(feedback.reopenIssueIds).toEqual([]);
    const corrected = decide(feedback.state, { type: 'authorize_correction', deliveryId: 'delivery-a', issueIds: ['issue-b'], reason: 'Correct the agreed behavior.' });
    expect(corrected.reopenIssueIds).toEqual(['issue-b']);
    expect(corrected.state).toMatchObject({ status: 'in_progress', delivery: null, scopeVersionId: 'scope-a', authorizedScopeVersionId: 'scope-a' });
    expect(corrected.state.requiredIssueIds).toEqual(['issue-a', 'issue-b']);
    const revisedFacts = evidence();
    revisedFacts.issues = [issue('issue-a', 'revision-a'), issue('issue-b', 'revision-b2')];
    revisedFacts.delivery = { ...revisedFacts.delivery!, id: 'delivery-b', pinnedAssetId: 'build-b', issueRevisionIds: ['revision-a', 'revision-b2'] };
    const assessed = decide(corrected.state, { type: 'assess_delivery', deliveryId: 'delivery-b' }, pm, revisedFacts).state;
    const reshared = decide(assessed, { type: 'share_delivery', deliveryId: 'delivery-b' }, pm, revisedFacts).state;
    expectRefusal(() => decide(reshared, { type: 'accept_delivery', deliveryId: 'delivery-a' }, client, revisedFacts), 409, 'delivery_not_current');
    expect(decide(reshared, { type: 'accept_delivery', deliveryId: 'delivery-b' }, client, revisedFacts).state.delivery?.acceptedByClientId).toBe('client-a');
    expect(shared.delivery?.id).toBe('delivery-a'); // Prior record was not mutated or deleted.
  });

  it('allows a client to report a defect even if technical status has since failed', () => {
    const facts = evidence();
    facts.issues = facts.issues!.map(item => ({ ...item, status: 'todo', requiredReviewsPassed: false }));
    const decision = decide(ready(), { type: 'request_correction', deliveryId: 'delivery-a', messageId: 'message-a' }, client, { ...facts, message: message(client) });
    expect(decision.state.nextAction).toBe('triage_correction');
  });

  it('returns a PM failed review to affected work, without touching unrelated Issues', () => {
    const decision = decide(startWork(), { type: 'request_fixes', issueIds: ['issue-a'], reason: 'Acceptance criterion failed' });
    expect(decision.reopenIssueIds).toEqual(['issue-a']);
    expectRefusal(() => decide(startWork(), { type: 'request_fixes', issueIds: ['unrelated-issue'], reason: 'Fix this' }), 409, 'correction_outside_manifest');
  });

  it.each(['request_fixes', 'authorize_correction'] as const)('requires a developer brief for %s', type => {
    const command = type === 'request_fixes' ? { type, issueIds: ['issue-a'] } : { type, deliveryId: 'delivery-a', issueIds: ['issue-a'] };
    const state = startWork();
    expectRefusal(() => decideTicketCommand(state, pm, { schemaVersion: 1, operationId: 'missing-reason', expectedVersion: state.version, command }, evidence(), 'enabled'), 400, 'invalid_ticket_command');
  });

  it.each(['backlog', 'todo', 'in_progress', 'agent_running'] as const)('does not reset %s work as a correction', status => {
    const facts = evidence(); facts.issues = facts.issues!.map(item => item.id === 'issue-a' ? { ...item, status } : item);
    expectRefusal(() => decide(startWork(), { type: 'request_fixes', issueIds: ['issue-a'], reason: 'Fix this result' }, pm, facts), 409, 'ticket_correction_not_ready');
  });

  it.each([true, undefined])('refuses correction with active/missing run evidence %s', hasActiveRun => {
    const facts = evidence(); facts.issues![0].hasActiveRun = hasActiveRun as boolean;
    expectRefusal(() => decide(startWork(), { type: 'request_fixes', issueIds: ['issue-a'], reason: 'Fix this result' }, pm, facts), 409, 'ticket_correction_not_ready');
  });

  it('allows failed review work to be corrected without demanding that the failed reviews pass first', () => {
    const facts = evidence(); facts.issues![0].status = 'review'; facts.issues![0].requiredReviewsPassed = false;
    expect(decide(startWork(), { type: 'request_fixes', issueIds: ['issue-a'], reason: 'Fix failed validation' }, pm, facts).reopenIssueIds).toEqual(['issue-a']);
  });

  it('does not reset or block unrelated work that is still running', () => {
    const facts = evidence(); facts.issues![1].status = 'agent_running'; facts.issues![1].hasActiveRun = true;
    const decision = decide(startWork(), { type: 'request_fixes', issueIds: ['issue-a'], reason: 'Fix reviewed part' }, pm, facts);
    expect(decision.reopenIssueIds).toEqual(['issue-a']);
    expect(decision.state.requiredIssueIds).toEqual(['issue-a', 'issue-b']);
  });

  it('cannot assess or accept a supposedly done result with an active run', () => {
    const facts = evidence(); facts.issues![0].hasActiveRun = true;
    const state = startWork();
    expectRefusal(() => decideTechnicalReadiness(state, execution, 'still-running', state.version, facts, 'enabled'), 409, 'technical_review_incomplete');
    expectRefusal(() => decide(startWork(), { type: 'assess_delivery', deliveryId: 'delivery-a' }, pm, facts), 409, 'technical_review_incomplete');
    expectRefusal(() => decide(ready(), { type: 'accept_delivery', deliveryId: 'delivery-a' }, client, facts), 409, 'technical_review_incomplete');
  });

  it('requires fresh client agreement and PM authorization for a new scope', () => {
    let current = newTicketWorkflow('ticket-a', 'workspace-a', 'client-a');
    current = decide(current, { type: 'review' }).state;
    current = decide(current, { type: 'propose_scope', scopeVersionId: 'scope-a' }, pm, {
      ...evidence(), scope: { id: 'scope-a', ticketId: 'ticket-a', workspaceId: 'workspace-a' },
    }).state;
    const facts = { ...startableEvidence(), scope: { id: 'scope-b', ticketId: 'ticket-a', workspaceId: 'workspace-a' } };
    const proposed = decide(current, { type: 'propose_scope', scopeVersionId: 'scope-b' }, pm, facts).state;
    expect(proposed).toMatchObject({ status: 'awaiting_client', scopeVersionId: 'scope-b', agreedScopeVersionId: null, authorizedScopeVersionId: null, delivery: null });
    expectRefusal(() => decide(proposed, { type: 'agree_scope', scopeVersionId: 'scope-a' }, client), 409, 'scope_not_current');
    const agreed = decide(proposed, { type: 'agree_scope', scopeVersionId: 'scope-b' }, client, facts).state;
    facts.issues = facts.issues!.map(item => ({ ...item, scopeVersionId: 'scope-b' }));
    expect(decide(agreed, { type: 'authorize_work', scopeVersionId: 'scope-b', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'] }, pm, facts).state)
      .toMatchObject({ status: 'in_progress', authorizedScopeVersionId: 'scope-b' });
  });

  it('requires a linked ticket for new scope after work has been authorized', () => {
    const current = startWork();
    expectRefusal(() => decide(current, { type: 'propose_scope', scopeVersionId: 'scope-b' }, pm, {
      ...evidence(), scope: { id: 'scope-b', ticketId: current.id, workspaceId: current.workspaceId },
    }), 409, 'scope_change_requires_linked_ticket');
    expect(current).toMatchObject({ status: 'in_progress', projectId: 'project-a', authorizedScopeVersionId: 'scope-a' });
  });

  it.each(['closed', 'declined', 'cancelled'] as const)('keeps %s history immutable; further work needs a linked ticket', status => {
    const state = { ...ready(), status };
    expectRefusal(() => decide(state, { type: 'reply', messageId: 'message-a' }, client, { ...evidence(), message: message(client) }), 409, 'ticket_is_read_only');
    expectRefusal(() => decide(state, { type: 'propose_scope', scopeVersionId: 'scope-b' }), 409, 'ticket_is_read_only');
  });
});

describe('hold, withdrawal and answer-only resolution', () => {
  it('does not turn client silence into acceptance, even after hold/resume', () => {
    const shared = ready();
    const held = decide(shared, { type: 'hold', reason: 'Awaiting client availability' }).state;
    expectRefusal(() => decide(held, { type: 'accept_delivery', deliveryId: 'delivery-a' }, client), 409, 'invalid_ticket_transition');
    const resumed = decide(held, { type: 'resume' }).state;
    expect(resumed).toMatchObject({ status: 'ready_for_review', actionOwner: 'client', delivery: { acceptedByClientId: null } });
    expectRefusal(() => decide(resumed, { type: 'close_accepted', deliveryId: 'delivery-a' }), 409, 'client_acceptance_required');
  });

  it('preserves a reply during hold without automatically resuming work', () => {
    let state = decide(newTicketWorkflow('ticket-a', 'workspace-a', 'client-a'), { type: 'review' }).state;
    state = decide(state, { type: 'request_details', messageId: 'message-a' }, pm, { ...evidence(), message: message(pm) }).state;
    state = decide(state, { type: 'hold', reason: 'PM unavailable' }).state;
    state = decide(state, { type: 'reply', messageId: 'message-a' }, client, { ...evidence(), message: message(client) }).state;
    expect(state.status).toBe('on_hold');
    expect(decide(state, { type: 'resume' }).state).toMatchObject({ status: 'under_review', actionOwner: 'pm' });
  });

  it('revalidates execution eligibility before resuming authorized work', () => {
    const held = decide(startWork(), { type: 'hold', reason: 'Project owner unavailable' }).state;
    expectRefusal(() => decide(held, { type: 'resume' }, pm, { ...evidence(), project: { ...evidence().project!, creatorActive: false } }), 409, 'ticket_project_ineligible');
  });

  it('requests withdrawal without deleting work or instantly cancelling running tasks', () => {
    const requested = decide(startWork(), { type: 'request_withdrawal', reason: 'Please stop' }, client);
    expect(requested.state).toMatchObject({ status: 'in_progress', withdrawalRequested: true, nextAction: 'handle_withdrawal' });
    expect(requested.reopenIssueIds).toEqual([]);
    expectRefusal(() => decide(requested.state, { type: 'assess_delivery', deliveryId: 'delivery-a' }), 409, 'withdrawal_pending');
    expectRefusal(() => decide(requested.state, { type: 'cancel', reason: 'Client withdrew' }), 409, 'ticket_work_not_stopped');
    expect(decide(requested.state, { type: 'cancel', reason: 'Client withdrew' }, pm, { workStopped: true }).state)
      .toMatchObject({ status: 'cancelled', closureReason: 'cancelled', authorizedScopeVersionId: null });
  });

  it('closes a public answer without pretending software was accepted', () => {
    const reviewed = decide(newTicketWorkflow('ticket-a', 'workspace-a', 'client-a'), { type: 'review' }).state;
    const closed = decide(reviewed, { type: 'answer_close', messageId: 'message-a' }, pm, { message: message(pm) }).state;
    expect(closed).toMatchObject({ status: 'closed', closureReason: 'answered', delivery: null });
    const active = { ...startWork(), status: 'under_review' as const };
    expectRefusal(() => decide(active, { type: 'answer_close', messageId: 'message-a' }, pm, { message: message(pm) }), 409, 'implementation_outstanding');
  });
});

describe('identity, tenant, feature and input boundaries', () => {
  it.each([
    { ...client, workspaceId: 'workspace-b' }, { ...client, userId: 'other-client' },
    { ...client, ticketId: 'other-ticket' }, { ...client, grantActive: false },
  ])('refuses another workspace/client/ticket or a revoked grant before input validation', actor => {
    expectRefusal(() => decideTicketCommand(ready(), actor, { malformed: true }, {}, 'enabled'), 404, 'ticket_not_found');
  });

  it.each([developer, { ...pm, membershipActive: false }, { ...pm, canManageTickets: false }])('requires an active authorized PM for internal decisions', actor => {
    expectRefusal(() => decide(newTicketWorkflow('ticket-a', 'workspace-a', 'client-a'), { type: 'review' }, actor), 403, 'ticket_action_forbidden');
  });

  it.each(['authorize_work', 'close_accepted', 'cancel'] as const)('does not let clients perform %s', type => {
    const command = type === 'authorize_work' ? { type, scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a'] }
      : type === 'close_accepted' ? { type, deliveryId: 'delivery-a' } : { type, reason: 'Stop' };
    expectRefusal(() => decide(ready(), command, client), 403, 'ticket_action_forbidden');
  });

  it.each(['agree_scope', 'accept_delivery'] as const)('does not let a PM impersonate the client’s %s decision', type => {
    const command = type === 'agree_scope' ? { type, scopeVersionId: 'scope-a' } : { type, deliveryId: 'delivery-a' };
    expectRefusal(() => decide(ready(), command, pm), 403, 'ticket_action_forbidden');
  });

  it('defaults writes off and permits only safe PM cancellation in maintenance', () => {
    const state = startWork();
    const input = envelope(state, { type: 'cancel', reason: 'Emergency stop resolved' });
    expectRefusal(() => decideTicketCommand(state, pm, input, { workStopped: true }), 503, 'ticket_writes_disabled');
    expect(decideTicketCommand(state, pm, input, { workStopped: true }, 'maintenance').state.status).toBe('cancelled');
    expectRefusal(() => decideTicketCommand(state, pm, envelope(state, { type: 'hold', reason: 'Wait' }), {}, 'maintenance'), 503, 'ticket_writes_disabled');
    expectRefusal(() => decideTechnicalReadiness(state, execution, 'op', state.version, evidence()), 503, 'ticket_writes_disabled');
  });

  it('requires the current optimistic version before every decision', () => {
    const state = ready();
    expectRefusal(() => decideTicketCommand(state, client, envelope(state, { type: 'accept_delivery', deliveryId: 'delivery-a' }, { expectedVersion: state.version - 1 }), evidence(), 'enabled'), 409, 'ticket_version_conflict');
    expectRefusal(() => decideTechnicalReadiness(startWork(), execution, 'op', 0, evidence(), 'enabled'), 409, 'ticket_version_conflict');
  });

  it.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Infinity, NaN])('rejects unsafe versions at both command boundaries (%s)', expectedVersion => {
    const state = { ...startWork(), version: expectedVersion };
    expectRefusal(() => parseTicketCommand(envelope(state, { type: 'review' })), 400, 'invalid_ticket_command');
    expectRefusal(() => decideTechnicalReadiness(state, execution, 'op', expectedVersion, evidence(), 'enabled'), 400, 'invalid_ticket_command');
  });

  it.each([
    { type: 'patch_status', status: 'closed' }, { type: 'release' }, { type: 'reopen' },
    { type: 'technical_work_ready' }, { type: 'review', role: 'pm' },
    { type: 'accept_delivery', deliveryId: 'delivery-a', acceptedByClientId: 'client-a' },
    { type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-a'] },
  ])('does not accept arbitrary statuses, trusted facts, duplicate Issues or server-only events (%j)', command => {
    expectRefusal(() => parseTicketCommand({ schemaVersion: 1, operationId: 'op', expectedVersion: 0, command }), 400, 'invalid_ticket_command');
  });

  it('rejects trusted evidence or actor injection at the envelope boundary', () => {
    const input = envelope(ready(), { type: 'accept_delivery', deliveryId: 'delivery-a' });
    expectRefusal(() => parseTicketCommand({ ...input, facts: evidence() }), 400, 'invalid_ticket_command');
    expectRefusal(() => parseTicketCommand({ ...input, actor: pm }), 400, 'invalid_ticket_command');
  });

  it.each([undefined, null, {}, { schemaVersion: 2 }, { schemaVersion: 1, operationId: 'op', expectedVersion: -1, command: { type: 'review' } }])('returns a safe invalid-command error (%j)', input => {
    expectRefusal(() => parseTicketCommand(input), 400, 'invalid_ticket_command');
  });

  it.each([{ audience: 'internal' as const }, { ticketId: 'other-ticket' }, { authorId: 'other-client' }])('cannot use a private, foreign or impersonated message', overrides => {
    expectRefusal(() => decide(ready(), { type: 'reply', messageId: 'message-a' }, client, { message: message(client, overrides) }), 409, 'public_message_required');
  });
});

describe('evidence and snapshot integrity', () => {
  it.each([
    { creatorActive: false }, { nonProductionSafe: false }, { workspaceId: 'workspace-b' },
  ])('refuses unsafe/inactive/cross-workspace projects', overrides => {
    const state = agreedWork();
    const facts = evidence(); facts.project = { ...facts.project!, ...overrides };
    expectRefusal(() => decide(state, { type: 'authorize_work', scopeVersionId: 'scope-a', projectId: 'project-a', issueIds: ['issue-a', 'issue-b'] }, pm, facts), 409, 'ticket_project_ineligible');
  });

  it.each([
    { ticketId: 'other-ticket' }, { workspaceId: 'workspace-b' }, { projectId: 'project-b' },
    { scopeVersionId: 'scope-b' }, { revisionId: '' },
  ])('refuses incorrect primary ownership, tenant, project or baseline evidence', overrides => {
    const facts = evidence(); facts.issues = [facts.issues![0], { ...facts.issues![1], ...overrides }];
    expectRefusal(() => decide(startWork(), { type: 'assess_delivery', deliveryId: 'delivery-a' }, pm, facts), 409, 'ticket_manifest_conflict');
  });

  it.each([{ status: 'todo' as const }, { requiredReviewsPassed: false }])('requires every Issue and review, not just one completed Issue', overrides => {
    const facts = completedEvidence(); facts.issues = [facts.issues![0], { ...facts.issues![1], ...overrides }];
    expectRefusal(() => decide(startWork(), { type: 'assess_delivery', deliveryId: 'delivery-a' }, pm, facts), 409, 'technical_review_incomplete');
    expectRefusal(() => decideTechnicalReadiness(startWork(), execution, 'op', 4, facts, 'enabled'), 409, 'technical_review_incomplete');
  });

  it('requires an exact manifest, including no missing/extra/duplicate Issue', () => {
    for (const issues of [[issue('issue-a', 'revision-a')], [...evidence().issues!, issue('unrelated', 'revision-c')], [issue('issue-a', 'revision-a'), issue('issue-a', 'revision-b')]]) {
      expectRefusal(() => decide(startWork(), { type: 'assess_delivery', deliveryId: 'delivery-a' }, pm, { ...evidence(), issues }), 409, 'ticket_manifest_incomplete');
    }
  });

  it.each([{ immutable: false }, { pinnedAssetId: '' }, { scopeVersionId: 'scope-b' }, { issueRevisionIds: ['revision-a'] }])('will not assess a moving, missing or incomplete delivery', overrides => {
    const facts = completedEvidence(); facts.delivery = { ...facts.delivery!, ...overrides };
    expectRefusal(() => decide(startWork(), { type: 'assess_delivery', deliveryId: 'delivery-a' }, pm, facts), 409, 'delivery_not_current');
  });

  it('will not accept a delivery whose artifact or Issue revision changed', () => {
    const shared = ready();
    expectRefusal(() => decide(shared, { type: 'accept_delivery', deliveryId: 'delivery-a' }, client, { ...completedEvidence(), delivery: { ...evidence().delivery!, pinnedAssetId: 'different-build' } }), 409, 'delivery_not_current');
    const facts = completedEvidence(); facts.issues = [issue('issue-a', 'revision-a2', 'done'), issue('issue-b', 'revision-b', 'done')];
    expectRefusal(() => decide(shared, { type: 'accept_delivery', deliveryId: 'delivery-a' }, client, facts), 409, 'delivery_not_current');
  });

  it('allows client review of finished work without retaining named developer assignment evidence', () => {
    const facts = completedEvidence();
    facts.project = { ...facts.project!, creatorActive: false };
    expect(decide(ready(), { type: 'accept_delivery', deliveryId: 'delivery-a' }, client, facts).state.delivery?.acceptedByClientId).toBe(client.userId);
    expectRefusal(() => decide(startWork(), { type: 'share_delivery', deliveryId: 'delivery-a' }, pm, facts), 409, 'ticket_project_ineligible');
  });

  it('requires the current execution identity/revision and never accepts a duplicate ready event', () => {
    const state = startWork();
    expectRefusal(() => decideTechnicalReadiness(state, { ...execution, ticketId: 'other-ticket' }, 'op', state.version, evidence(), 'enabled'), 404, 'ticket_not_found');
    expectRefusal(() => decideTechnicalReadiness(state, { ...execution, authorized: false }, 'op', state.version, evidence(), 'enabled'), 404, 'ticket_not_found');
    expectRefusal(() => decideTechnicalReadiness(state, { ...execution, issueRevisionId: 'old-revision' }, 'op', state.version, evidence(), 'enabled'), 409, 'execution_revision_conflict');
    const next = decideTechnicalReadiness(state, execution, 'op', state.version, evidence(), 'enabled').state;
    expectRefusal(() => decideTechnicalReadiness(next, execution, 'other-op', next.version, evidence(), 'enabled'), 409, 'technical_readiness_already_recorded');
  });

  it('produces a separate next snapshot and a safe event without mutating inputs', () => {
    const original = ready();
    Object.freeze(original.requiredIssueIds); Object.freeze(original.delivery!.issueRevisionIds); Object.freeze(original.delivery); Object.freeze(original);
    const result = decide(original, { type: 'accept_delivery', deliveryId: 'delivery-a' }, client);
    expect(original.delivery!.acceptedByClientId).toBeNull();
    expect(result.state.delivery).not.toBe(original.delivery);
    expect(result.state.requiredIssueIds).not.toBe(original.requiredIssueIds);
    expect(result.event).toEqual({ type: 'accept_delivery', operationId: `operation-${original.version}-accept_delivery`, actorKind: 'client', actorId: 'client-a', fromVersion: original.version, toVersion: original.version + 1 });
    expect(result.event).not.toHaveProperty('message');
    expect(result.event).not.toHaveProperty('credentials');
  });
});
