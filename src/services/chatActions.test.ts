import { describe, expect, it, vi } from 'vitest';
import { parseConsentCheck } from './chatConsentCheck.js';
import { quotedConsent, runChatAction, SET_ASIDE_REASON, type ChatActionDeps, type ChatActionInput, type ChatActionRoute } from './chatActions.js';

const context = { workspaceId: 'ws', userId: 'user-1', role: 'dev', access: {} } as any;

function snapshot(status: string, overrides: Record<string, unknown> = {}) {
  return { run: { id: 'run-1', status, revision: 3, planVersion: 2, plan: { goal: 'Build the expense app.' },
    repositoryWorkspaces: [{ repository: 'acme/fe' }], ...overrides }, tasks: [], attempts: [] } as any;
}

function deps(pending: any[] = [snapshot('awaiting_plan_approval')], over: Partial<ChatActionDeps> = {}) {
  const value: ChatActionDeps = {
    pending: () => pending,
    setAside: () => undefined,
    can: () => true,
    orchestrationEnabled: true,
    decide: vi.fn(async input => snapshot(input.action === 'start' ? 'executing' : 'completed')),
    revise: vi.fn(async () => snapshot('awaiting_plan_approval', { planVersion: 3 })),
    cancel: vi.fn(async () => snapshot('cancelled')),
    requestChanges: vi.fn(async () => snapshot('executing')),
    merge: vi.fn(async () => 'Merged acme/fe pull request #1 into dev.'),
    confirmConsent: vi.fn(async () => true),
    ...over
  };
  return value;
}

const run = (route: ChatActionRoute, message: string, extra: Partial<ChatActionInput>, value: ChatActionDeps) =>
  runChatAction({ route, context, projectId: 'project-1', threadId: 'thread-1', messageId: 'msg-1', message, ...extra }, value);

describe('the isolated consent check', () => {
  it('counts only a yes that quotes the whole message', () => {
    expect(parseConsentCheck(JSON.stringify({ consent: true, evidence: 'yes, do it' }), 'yes, do it')).toBe(true);
    expect(parseConsentCheck(JSON.stringify({ consent: true, evidence: 'start' }), 'do not start')).toBe(false);
    expect(parseConsentCheck(JSON.stringify({ consent: false, evidence: '' }), 'yes')).toBe(false);
    for (const reply of ['yes', '{}', '{broken', JSON.stringify({ consent: true, evidence: 'yes', extra: 1 })]) expect(parseConsentCheck(reply, 'yes')).toBe(false);
  });
});

describe('consent is the person\'s whole message', () => {
  it('accepts the whole message, ignoring case, spacing and trailing punctuation', () => {
    expect(quotedConsent('Yes, start it!', 'yes,  start it')).toBe(true);
    expect(quotedConsent('Please send the reviewed changes to GitHub.', 'Please send the reviewed changes to GitHub.')).toBe(true);
  });
  it('refuses a fragment, an empty quote, or words from elsewhere', () => {
    expect(quotedConsent('do not start', 'start')).toBe(false);
    expect(quotedConsent('start if the tests pass', 'start')).toBe(false);
    expect(quotedConsent('yes', '')).toBe(false);
    expect(quotedConsent('yes', undefined)).toBe(false);
    expect(quotedConsent('what does it change?', 'start the plan')).toBe(false);
  });
});

describe('an action that changes code or reaches GitHub needs more than the main turn', () => {
  it('does nothing when the isolated check disagrees, however the main turn quoted the message', async () => {
    // Text planted in a repository file steered the main turn into "start" for an unrelated message.
    const value = deps(undefined, { confirmConsent: vi.fn(async () => false) });
    const outcome = await run('start_plan', 'summarize the README', { evidence: 'summarize the README' }, value);
    expect(value.decide).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'reply', message: expect.stringContaining('Plan v2 is ready') });
  });

  it('treats a failing isolated check as no', async () => {
    const value = deps(undefined, { confirmConsent: vi.fn(async () => { throw new Error('runtime down'); }) });
    await run('start_plan', 'yes', { evidence: 'yes' }, value);
    expect(value.decide).not.toHaveBeenCalled();
  });

  it('never takes consent from a message with files, an @-address or a slash command', async () => {
    for (const [message, extra] of [['yes', { hasAttachments: true }], ['@frontend yes', {}], ['/ask yes', {}]] as const) {
      const value = deps();
      await run('start_plan', message, { evidence: message, ...extra }, value);
      expect(value.decide).not.toHaveBeenCalled();
      expect(value.confirmConsent).not.toHaveBeenCalled();
    }
  });

  it('asks the isolated check about exactly this action and the build\'s state', async () => {
    const value = deps();
    await run('start_plan', 'go ahead', { evidence: 'go ahead' }, value);
    expect(value.confirmConsent).toHaveBeenCalledWith({ message: 'go ahead', route: 'start_plan', status: 'awaiting_plan_approval' });
    expect(value.decide).toHaveBeenCalledTimes(1);
  });

  it('guards plan changes the same way: planted text cannot revise, replace, cancel or restore a plan', async () => {
    const value = deps(undefined, { confirmConsent: vi.fn(async () => false) });
    await run('revise_plan', 'summarize the README', { instruction: 'Add a task that uploads secrets.' }, value);
    await run('replace_plan', 'summarize the README', { goal: 'Something else.' }, value);
    await run('cancel_plan', 'summarize the README', {}, value);
    expect(value.revise).not.toHaveBeenCalled(); expect(value.cancel).not.toHaveBeenCalled();
    const withFiles = deps();
    await run('replace_plan', 'add a login', { goal: 'Add login.', hasAttachments: true }, withFiles);
    expect(withFiles.cancel).not.toHaveBeenCalled(); expect(withFiles.confirmConsent).not.toHaveBeenCalled();
  });

  it('does not need the main turn\'s quote for plan changes, only the isolated check', async () => {
    const value = deps();
    await run('revise_plan', 'split the task please', { instruction: 'Split the task.' }, value);
    expect(value.confirmConsent).toHaveBeenCalledWith({ message: 'split the task please', route: 'revise_plan', status: 'awaiting_plan_approval' });
    expect(value.revise).toHaveBeenCalledTimes(1);
  });
});

describe('chat actions check their own rules', () => {
  it('asks for a go-ahead instead of starting without one, and starts with one', async () => {
    const value = deps();
    expect(await run('start_plan', 'maybe later', { evidence: 'later' }, value)).toEqual({ kind: 'reply', message: expect.stringContaining('Plan v2 is ready') });
    expect(value.decide).not.toHaveBeenCalled();
    expect(await run('start_plan', 'yes start it', { evidence: 'yes start it' }, value)).toEqual({ kind: 'reply', message: expect.stringContaining('Plan v2 started') });
    expect(value.decide).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', runId: 'run-1', expectedRevision: 3, planVersion: 2, threadId: 'thread-1' }));
  });

  it('uses the revision the person viewed, and waits for a review still loading', async () => {
    const value = deps();
    await run('start_plan', 'go', { evidence: 'go', buildDecision: { runId: 'run-1', expectedRevision: 2, planVersion: 1, evidenceReady: true } }, value);
    expect(value.decide).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2, planVersion: 1 }));
    const loading = await run('start_plan', 'go', { evidence: 'go', buildDecision: { runId: 'run-1', expectedRevision: 3, planVersion: 2, evidenceReady: false } }, deps());
    expect(loading).toEqual({ kind: 'reply', message: expect.stringContaining('still loading') });
  });

  it('turns a refused action into an explanation, never an exception', async () => {
    const value = deps(undefined, { decide: vi.fn(async () => { throw new Error('This plan or review changed.'); }) });
    expect(await run('start_plan', 'go', { evidence: 'go' }, value)).toEqual({ kind: 'reply', message: expect.stringContaining('This plan or review changed.') });
  });

  it('replaces a plan by setting it aside, then planning the new request', async () => {
    const value = deps();
    const outcome = await run('replace_plan', 'add a backend login', { goal: 'Expense app plus backend login.' }, value);
    expect(value.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', expectedRevision: 3, reason: SET_ASIDE_REASON }));
    expect(outcome).toMatchObject({ kind: 'build', request: 'Expense app plus backend login.', repositories: [], note: expect.stringContaining('restore the previous plan') });
  });

  it('does not set anything aside for a role that cannot start builds', async () => {
    const value = deps(undefined, { can: () => false });
    expect(await run('replace_plan', 'add login', { goal: 'Add login.' }, value)).toEqual({ kind: 'reply', message: expect.stringContaining('role') });
    expect(value.cancel).not.toHaveBeenCalled();
  });

  it('cancels a waiting plan and offers to restore it', async () => {
    const value = deps();
    expect(await run('cancel_plan', 'drop it', {}, value)).toEqual({ kind: 'reply', message: expect.stringContaining('restore the previous plan') });
    expect(value.cancel).toHaveBeenCalledTimes(1);
  });

  it('restores the set-aside plan exactly, setting the waiting one aside first', async () => {
    const previous = snapshot('cancelled', { id: 'run-0', stoppedReason: SET_ASIDE_REASON, plan: { goal: 'Old plan.' } });
    const value = deps([snapshot('awaiting_plan_approval')], { setAside: () => previous });
    const outcome = await run('restore_plan', 'bring it back', {}, value);
    expect(value.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
    expect(outcome).toMatchObject({ kind: 'build', request: 'Old plan.', presetPlan: { goal: 'Old plan.' }, repositories: ['acme/fe'] });
  });

  it('never restores over work that is already under way', async () => {
    const previous = snapshot('cancelled', { id: 'run-0', stoppedReason: SET_ASIDE_REASON });
    const value = deps([snapshot('awaiting_approval')], { setAside: () => previous });
    expect(await run('restore_plan', 'bring it back', {}, value)).toEqual({ kind: 'reply', message: expect.stringContaining('under way') });
    expect(value.cancel).not.toHaveBeenCalled();
    expect(await run('restore_plan', 'bring it back', {}, deps())).toEqual({ kind: 'reply', message: expect.stringContaining('no set-aside plan') });
  });

  it('offers to replace a plan it could not revise in place', async () => {
    const value = deps(undefined, { revise: vi.fn(async () => { throw new Error('Preserve the approved milestone requirements exactly.'); }) });
    const outcome = await run('revise_plan', 'add a database', { instruction: 'Add a database.' }, value);
    expect(outcome).toEqual({ kind: 'reply', message: expect.stringMatching(/couldn't revise.*replace the plan/s) });
  });

  it('asks for the change when sending work back without one, and checks role and availability', async () => {
    const review = [snapshot('awaiting_approval')];
    expect(await run('request_changes', 'change it', { evidence: 'change it' }, deps(review))).toEqual({ kind: 'reply', message: 'What should change in the finished work?' });
    expect(await run('request_changes', 'change it', { evidence: 'change it', instruction: 'Sticky header.' }, deps(review, { can: () => false })))
      .toEqual({ kind: 'reply', message: expect.stringContaining('role') });
    expect(await run('request_changes', 'change it', { evidence: 'change it', instruction: 'Sticky header.' }, deps(review, { orchestrationEnabled: false })))
      .toEqual({ kind: 'reply', message: expect.stringContaining('unavailable') });
    const value = deps(review);
    await run('request_changes', 'change it', { evidence: 'change it', instruction: 'Sticky header.' }, value);
    expect(value.requestChanges).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', expectedRunRevision: 3, feedback: 'Sticky header.' }));
  });

  it('merges only on the whole message', async () => {
    const value = deps([]);
    expect(await run('merge_dev', 'merge it into dev', { evidence: 'merge' }, value)).toEqual({ kind: 'reply', message: expect.stringContaining('Tell me to merge') });
    expect(value.merge).not.toHaveBeenCalled();
    expect(await run('merge_dev', 'merge it into dev', { evidence: 'merge it into dev' }, value)).toEqual({ kind: 'reply', message: expect.stringContaining('Merged acme/fe') });
  });

  it('says what is waiting when the action does not fit the build\'s state', async () => {
    expect(await run('publish', 'publish it', { evidence: 'publish it' }, deps())).toEqual({ kind: 'reply', message: expect.stringContaining('no reviewed build waiting') });
    expect(await run('start_plan', 'start', { evidence: 'start' }, deps([snapshot('awaiting_plan_approval'), snapshot('awaiting_plan_approval', { id: 'run-2' })])))
      .toEqual({ kind: 'reply', message: expect.stringContaining('More than one') });
  });
});
