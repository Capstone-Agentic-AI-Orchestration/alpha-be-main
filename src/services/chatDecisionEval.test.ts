import { describe, expect, it, vi } from 'vitest';
import { runChatAction, type ChatActionDeps, type ChatActionRoute } from './chatActions.js';

/**
 * How the chat should behave for the ways people actually write.
 *
 * Each case is a message, the state of the build in the conversation, the decision a
 * correct Orchestrator returns for it (`null` = answer or ask, take no action), and
 * whether the server must act. Some cases record a wrong decision on purpose: a model
 * that lifts "start" out of "do not start" must still not start anything.
 *
 * When the routing prompt or model changes, these are the phrasings to re-check: the
 * recorded decision is the contract the live Orchestrator is expected to meet.
 */
type State = 'awaiting_plan_approval' | 'awaiting_approval' | 'publishing' | 'completed';
interface Case {
  message: string;
  state: State;
  decision: null | { route: ChatActionRoute; evidence?: string; instruction?: string; goal?: string };
  acts: boolean;
}

const quote = (message: string) => ({ evidence: message });
const CASES: Case[] = [
  // Starting a waiting plan: plain, paraphrased, misspelt, other languages.
  { message: 'yes', state: 'awaiting_plan_approval', decision: { route: 'start_plan', ...quote('yes') }, acts: true },
  { message: 'yes, do it', state: 'awaiting_plan_approval', decision: { route: 'start_plan', ...quote('yes, do it') }, acts: true },
  { message: 'go ahed with the plan', state: 'awaiting_plan_approval', decision: { route: 'start_plan', ...quote('go ahed with the plan') }, acts: true },
  { message: 'please start the plan now', state: 'awaiting_plan_approval', decision: { route: 'start_plan', ...quote('please start the plan now') }, acts: true },
  { message: 'looks good, start building', state: 'awaiting_plan_approval', decision: { route: 'start_plan', ...quote('looks good, start building') }, acts: true },
  { message: 'sige, simulan mo na', state: 'awaiting_plan_approval', decision: { route: 'start_plan', ...quote('sige, simulan mo na') }, acts: true },
  { message: 'vas-y, lance le plan', state: 'awaiting_plan_approval', decision: { route: 'start_plan', ...quote('vas-y, lance le plan') }, acts: true },
  // Not a go-ahead: negations, conditions, questions, waiting.
  { message: "don't start yet", state: 'awaiting_plan_approval', decision: null, acts: false },
  { message: 'do not start', state: 'awaiting_plan_approval', decision: null, acts: false },
  { message: 'start once the tests pass', state: 'awaiting_plan_approval', decision: null, acts: false },
  { message: 'should I approve this?', state: 'awaiting_plan_approval', decision: null, acts: false },
  { message: 'what will this plan change?', state: 'awaiting_plan_approval', decision: null, acts: false },
  { message: 'why is project-a-be listed if it has no task?', state: 'awaiting_plan_approval', decision: null, acts: false },
  { message: 'hold on, let me check with the client', state: 'awaiting_plan_approval', decision: null, acts: false },
  // A wrong decision is still caught: the quote must be the whole message.
  { message: 'do not start', state: 'awaiting_plan_approval', decision: { route: 'start_plan', evidence: 'start' }, acts: false },
  { message: 'start if the tests pass', state: 'awaiting_plan_approval', decision: { route: 'start_plan', evidence: 'start' }, acts: false },
  { message: 'yes', state: 'awaiting_plan_approval', decision: { route: 'start_plan', evidence: 'I approve the plan' }, acts: false },
  // Changing a waiting plan: same scope revises, new scope replaces, dropping cancels.
  { message: 'split the UI task into the form and the list', state: 'awaiting_plan_approval', decision: { route: 'revise_plan', instruction: 'Split the UI task into form and list tasks.' }, acts: true },
  { message: 'give the review to the security agent instead', state: 'awaiting_plan_approval', decision: { route: 'revise_plan', instruction: 'Assign the review to the Security & Code Quality agent.' }, acts: true },
  { message: 'I want you to create a backend task for this, a local database and a login credential', state: 'awaiting_plan_approval',
    decision: { route: 'replace_plan', goal: 'Expense app with localStorage, plus a backend local database and login credentials.' }, acts: true },
  { message: 'so can you create a task for that', state: 'awaiting_plan_approval', decision: { route: 'replace_plan', goal: 'Expense app plus the backend work discussed: a local database and login.' }, acts: true },
  { message: 'also add dark mode', state: 'awaiting_plan_approval', decision: { route: 'replace_plan', goal: 'Expense app with localStorage and a dark mode toggle.' }, acts: true },
  { message: 'forget this plan', state: 'awaiting_plan_approval', decision: { route: 'cancel_plan' }, acts: true },
  { message: 'actually, bring back the previous plan', state: 'awaiting_plan_approval', decision: { route: 'restore_plan' }, acts: true },
  // Final review: publication needs its own explicit request.
  { message: 'Please send the reviewed changes to GitHub and create the PR.', state: 'awaiting_approval', decision: { route: 'publish', ...quote('Please send the reviewed changes to GitHub and create the PR.') }, acts: true },
  { message: 'push it', state: 'awaiting_approval', decision: { route: 'publish', ...quote('push it') }, acts: true },
  { message: 'continue', state: 'awaiting_approval', decision: null, acts: false },
  { message: 'approve', state: 'awaiting_approval', decision: null, acts: false },
  { message: 'make the header sticky before you publish', state: 'awaiting_approval',
    decision: { route: 'request_changes', ...quote('make the header sticky before you publish'), instruction: 'Make the header sticky.' }, acts: true },
  { message: 'the totals are wrong, fix that first', state: 'awaiting_approval',
    decision: { route: 'request_changes', ...quote('the totals are wrong, fix that first'), instruction: 'Fix the spending totals.' }, acts: true },
  { message: "don't publish yet", state: 'awaiting_approval', decision: null, acts: false },
  // Publication that stopped.
  { message: 'retry publishing', state: 'publishing', decision: { route: 'retry_publication', ...quote('retry publishing') }, acts: true },
  { message: 'why did publishing stop?', state: 'publishing', decision: null, acts: false },
  // Merging the open pull request into dev.
  { message: 'merge it', state: 'completed', decision: { route: 'merge_dev', ...quote('merge it') }, acts: true },
  { message: 'can you accept the pull request for me', state: 'completed', decision: { route: 'merge_dev', ...quote('can you accept the pull request for me') }, acts: true },
  { message: 'should I merge it?', state: 'completed', decision: null, acts: false },
  { message: "don't merge it", state: 'completed', decision: null, acts: false },
  { message: 'merge it', state: 'completed', decision: { route: 'merge_dev', evidence: 'merge' }, acts: false },
  // An action the state does not allow is explained, not taken.
  { message: 'start it', state: 'awaiting_approval', decision: { route: 'start_plan', ...quote('start it') }, acts: false },
  { message: 'publish it', state: 'awaiting_plan_approval', decision: { route: 'publish', ...quote('publish it') }, acts: false }
];

function depsFor(state: State) {
  const snapshot = { run: { id: 'run-1', status: state, revision: 3, planVersion: 2, plan: { goal: 'Expense app.' }, repositoryWorkspaces: [] }, tasks: [], attempts: [] } as any;
  const previous = { run: { ...snapshot.run, id: 'run-0', status: 'cancelled', plan: { goal: 'Earlier plan.' } }, tasks: [], attempts: [] } as any;
  const actions = {
    decide: vi.fn(async () => ({ ...snapshot, run: { ...snapshot.run, status: 'executing' } })),
    revise: vi.fn(async () => ({ ...snapshot, run: { ...snapshot.run, planVersion: 3 } })),
    cancel: vi.fn(async () => ({ ...snapshot, run: { ...snapshot.run, status: 'cancelled' } })),
    requestChanges: vi.fn(async () => snapshot),
    merge: vi.fn(async () => 'Merged acme/fe pull request #1 into dev.')
  };
  // The isolated check agrees with a correct reading here; its refusals are covered in chatActions.test.ts.
  const confirmConsent = vi.fn(async () => true);
  const value: ChatActionDeps = {
    pending: () => state === 'completed' ? [] : [snapshot],
    setAside: () => previous,
    can: () => true,
    orchestrationEnabled: true,
    confirmConsent,
    ...actions
  };
  return { value, actions };
}

describe('the chat decides from the whole message, for the ways people write', () => {
  it.each(CASES.map(item => [item.message, item.state, item] as const))('%s (%s)', async (_message, _state, item) => {
    const { value, actions } = depsFor(item.state);
    const outcome = item.decision
      ? await runChatAction({ ...item.decision, context: { workspaceId: 'ws', userId: 'u', role: 'dev', access: {} } as any,
        projectId: 'p', threadId: 't', messageId: 'm', message: item.message }, value)
      : undefined;
    const acted = Object.values(actions).some(action => action.mock.calls.length > 0) || outcome?.kind === 'build';
    expect(acted).toBe(item.acts);
    // Every outcome says something: no silent result and no generic refusal.
    if (outcome?.kind === 'reply') expect(outcome.message.length).toBeGreaterThan(10);
  });

  it('covers the cases the chat used to get wrong', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    for (const route of ['start_plan', 'revise_plan', 'replace_plan', 'cancel_plan', 'restore_plan', 'publish', 'retry_publication', 'request_changes', 'merge_dev']) {
      expect(CASES.some(item => item.decision?.route === route && item.acts), route).toBe(true);
    }
  });
});
