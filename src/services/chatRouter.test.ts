import { describe, expect, it } from 'vitest';
import {
  ALPHA_ROUTE_MARKER,
  buildScope,
  orchestratorRoutingPrompt,
  parseAlphaRoute,
  parseChatOverride,
  readCards,
  referencesAlphaRecords,
  alphaChatResponseSchema
} from './chatRouter.js';

describe('decisions about the build waiting in the chat', () => {
  it('lets the Orchestrator choose build actions, with the evidence and instruction it acts on', () => {
    const decision = (alphaChatResponseSchema.properties.decision as any).anyOf[1];
    expect(decision.required).toEqual(expect.arrayContaining(['evidence', 'instruction']));
    expect(decision.properties.route.enum).toEqual(expect.arrayContaining(['start_plan', 'revise_plan', 'replace_plan', 'cancel_plan', 'restore_plan', 'publish', 'retry_publication', 'request_changes', 'merge_dev']));
    const parsed = parseAlphaRoute(JSON.stringify({ contract: 'alpha_chat_v1', message: '', decision: { route: 'revise_plan', goal: '', repositories: [], cards: [], assignments: [], evidence: 'split it', instruction: 'Split the UI task.' } }));
    expect(parsed.decision).toMatchObject({ route: 'revise_plan', evidence: 'split it', instruction: 'Split the UI task.' });
  });

  it('shows the router what is waiting and the only actions allowed now', () => {
    const prompt = orchestratorRoutingPrompt({ canBuild: true, repositories: ['acme/fe'], projectName: 'A',
      pendingBuild: { status: 'awaiting_plan_approval', planVersion: 2, allowedRoutes: ['start_plan', 'replace_plan'] } });
    expect(prompt).toContain('Build waiting on you');
    expect(prompt).toContain('"allowedRoutes":["start_plan","replace_plan"]');
    expect(prompt).toContain('copy the WHOLE current message into evidence');
    expect(orchestratorRoutingPrompt({ canBuild: true, repositories: [] })).toContain('"status":"none"');
  });
});

describe('continuing a stopped build', () => {
  it('gives the router the stopped goal to continue, instead of matching words', () => {
    const prompt = orchestratorRoutingPrompt({ canBuild: true, repositories: ['acme/site'], projectName: 'Site', restartableGoal: 'Redesign the landing page.' });
    expect(prompt).toContain('The last build in this conversation stopped');
    expect(prompt).toContain('Redesign the landing page.');
  });

  it('flags goals that point at records a specialist cannot open', () => {
    expect(referencesAlphaRecords('Continue the Money Tracker UI redesign from the saved MON-104 plan and preserved work.')).toBe(true);
    expect(referencesAlphaRecords('Review the previous failure and finish the redesign.')).toBe(true);
    expect(referencesAlphaRecords('Create a redesigned UI for Money tracker with clear navigation and responsive layouts.')).toBe(false);
  });

  it('tells Alpha that build goals must stand on their own, naming board cards by key', () => {
    const prompt = orchestratorRoutingPrompt({ projectName: 'Money tracker', repositories: ['org/app-fe'], canBuild: true });
    expect(prompt).toContain('cannot read this conversation, earlier builds');
    expect(prompt).toContain('set decision.cards');
    expect(prompt).toContain('Use ["all"] when the user wants every open task built');
  });
});

describe('the board cards Alpha chose for a build', () => {
  it('reads all, or card keys, from the structured decision', () => {
    const reply = (cards: unknown) => JSON.stringify({ contract: 'alpha_chat_v1', message: '',
      decision: { route: 'build', goal: 'Build the expense tasks', repositories: [], cards, assignments: [] } });
    expect(parseAlphaRoute(reply(['all'])).decision?.cards).toEqual(['all']);
    expect(parseAlphaRoute(reply(['pro-103', 'PRO-104', 'PRO-104'])).decision?.cards).toEqual(['PRO-103', 'PRO-104']);
    expect(parseAlphaRoute(reply([])).decision?.cards).toBeUndefined();
  });

  it('keeps only all or well-formed keys', () => {
    expect(readCards(['PRO-1', 'All'])).toEqual(['all']);
    expect(readCards(['the landing page', 'PRO-7', 42])).toEqual(['PRO-7']);
    expect(readCards('PRO-7')).toEqual([]);
  });
});

describe('parseAlphaRoute', () => {
  it('dispatches a structured response without a text marker', () => {
    const result = parseAlphaRoute(JSON.stringify({ contract: 'alpha_chat_v1', message: '',
      decision: { route: 'build', goal: 'Add search', repositories: ['org/fe'], assignments: [] } }));
    expect(result.decision).toEqual({ route: 'build', goal: 'Add search', repositories: ['org/fe'] });
    expect(result.message).toBe('');
  });
  it('extracts an ordinary answer from the structured response', () => {
    expect(parseAlphaRoute(JSON.stringify({ contract: 'alpha_chat_v1', message: 'The tests passed.', decision: null })))
      .toEqual({ message: 'The tests passed.', malformed: false });
  });
  it('validates bounded specialist assignments before dispatch', () => {
    const assignment = { agentId: 'backend-1', kind: 'backend', instruction: 'Inspect the API', reason: 'API expertise' };
    const parse = (assignments: unknown[]) => parseAlphaRoute('ALPHA_ROUTE ' + JSON.stringify({ route: 'delegate', assignments }));
    expect(parse([assignment]).decision?.assignments).toEqual([assignment]);
    for (const assignments of [[], [assignment, assignment], [{ ...assignment, kind: 'administrator' }], [{ ...assignment, instruction: '' }], Array(5).fill(assignment)]) {
      expect(parse(assignments).malformed).toBe(true);
    }
  });
  it('reads a build decision and removes the line from the visible reply', () => {
    const parsed = parseAlphaRoute(`${ALPHA_ROUTE_MARKER} {"route":"build","goal":"Add a dark mode toggle","repositories":["org/app-fe"]}`);
    expect(parsed.malformed).toBe(false);
    expect(parsed.decision).toEqual({ route: 'build', goal: 'Add a dark mode toggle', repositories: ['org/app-fe'] });
    expect(parsed.message).toBe('');
  });

  it('keeps the clarifying question that follows a confirm decision', () => {
    const parsed = parseAlphaRoute(`${ALPHA_ROUTE_MARKER} {"route":"confirm_build","goal":"Improve the dashboard"}\nWhich part of the dashboard should change?`);
    expect(parsed.decision?.route).toBe('confirm_build');
    expect(parsed.message).toBe('Which part of the dashboard should change?');
  });

  it('accepts a decision after a leading sentence', () => {
    const parsed = parseAlphaRoute(`Sure.\n${ALPHA_ROUTE_MARKER} {"route":"build","goal":"Fix login refresh"}`);
    expect(parsed.decision?.goal).toBe('Fix login refresh');
    expect(parsed.message).toBe('Sure.');
  });

  it('accepts a decision wrapped in inline code', () => {
    expect(parseAlphaRoute(`\`${ALPHA_ROUTE_MARKER} {"route":"build","goal":"x"}\``).decision?.route).toBe('build');
  });

  it('ignores a marker inside a fenced code block', () => {
    const reply = ['Here is the format:', '```', `${ALPHA_ROUTE_MARKER} {"route":"build","goal":"x"}`, '```'].join('\n');
    const parsed = parseAlphaRoute(reply);
    expect(parsed.decision).toBeUndefined();
    expect(parsed.malformed).toBe(false);
    expect(parsed.message).toBe(reply);
  });

  it('leaves an ordinary answer untouched', () => {
    expect(parseAlphaRoute('Login uses the session cookie.')).toEqual({ message: 'Login uses the session cookie.', malformed: false });
  });

  it.each([
    `${ALPHA_ROUTE_MARKER} not json`,
    `${ALPHA_ROUTE_MARKER} {"route":"deploy","goal":"x"}`,
    `${ALPHA_ROUTE_MARKER} ["build"]`
  ])('flags an unreadable decision without guessing: %s', reply => {
    const parsed = parseAlphaRoute(reply);
    expect(parsed.decision).toBeUndefined();
    expect(parsed.malformed).toBe(true);
    expect(parsed.message).not.toContain(ALPHA_ROUTE_MARKER);
  });

  it('drops non-string codebases', () => {
    const parsed = parseAlphaRoute(`${ALPHA_ROUTE_MARKER} {"route":"build","goal":"x","repositories":["a/b",3," ","a/b"]}`);
    expect(parsed.decision?.repositories).toEqual(['a/b']);
  });
});

describe('parseChatOverride', () => {
  it.each([
    ['/build add search', 'build', 'add search'],
    ['/ASK how does it work?', 'ask', 'how does it work?'],
    ['/build', 'build', '']
  ])('reads %s', (input, override, content) => {
    expect(parseChatOverride(input)).toEqual({ override, content });
  });

  it('does not treat other slashes as overrides', () => {
    expect(parseChatOverride('/builder is a word').override).toBeUndefined();
    expect(parseChatOverride('use /build later').override).toBeUndefined();
  });
});

/** Every codebase in a project is in scope; only the person narrows it, never the model. */
describe('buildScope', () => {
  const project = ['org/fe', 'org/be'];
  it('means every codebase when all or none are ticked', () => {
    expect(buildScope(['org/fe', 'org/be'], project)).toEqual([]);
    expect(buildScope(undefined, project)).toEqual([]);
    expect(buildScope([], project)).toEqual([]);
  });
  it('keeps a deliberate limit the person set', () => {
    expect(buildScope(['ORG/FE'], project)).toEqual(['org/fe']);
  });
  it('drops codebases outside the project, and never takes the model\'s list', () => {
    expect(buildScope(['org/other'], project)).toEqual([]);
    expect(buildScope(['org/fe', 'org/other'], project)).toEqual(['org/fe']);
  });
});

describe('orchestratorRoutingPrompt', () => {
  it('describes the decision line and the project scope for a builder', () => {
    const prompt = orchestratorRoutingPrompt({
      projectName: 'Money tracker', repositories: ['org/fe', 'org/be'], canBuild: true,
      workspaceProjects: ['Money tracker (MON)', 'Calculator (CAL)']
    });
    expect(prompt).toContain(ALPHA_ROUTE_MARKER);
    expect(prompt).toContain('Money tracker');
    expect(prompt).toContain('org/fe, org/be');
    expect(prompt).toContain('Projects this user can work in: Money tracker (MON), Calculator (CAL)');
    expect(prompt).toMatch(/is a question/);
  });

  it('permits read-only handoffs but forbids builds when the user cannot build', () => {
    const prompt = orchestratorRoutingPrompt({ repositories: [], canBuild: false });
    expect(prompt).toContain('cannot start builds');
    expect(prompt).toContain('Never write a build or confirm_build decision');
    expect(prompt).toContain('Read-only delegation');
  });

  it('forbids the decision line for an answer-only message', () => {
    expect(orchestratorRoutingPrompt({ repositories: [], canBuild: true, answerOnly: true })).toMatch(/answer only/);
  });

  it('answers product questions itself and keeps specialists for technical detail or a review', () => {
    const prompt = orchestratorRoutingPrompt({ projectName: 'Project A', repositories: ['org/site'], canBuild: true });
    const rule = prompt.split('\n').find(line => line.startsWith('1. '))!;
    expect(rule).toContain('A question about the product itself');
    expect(rule).toContain('answer it yourself from the product picture');
    expect(rule).toContain('only when the person asks for technical detail, a code walkthrough or a review');
    expect(rule).toContain('"Explain this project in simple terms" is this kind of question');
    // Route 5 is still there for technical analysis, and the handoff asks only for what the answer needs.
    expect(prompt).toContain('hand it to the relevant specialists using route 5');
    expect(prompt).toContain('you write the person one combined answer to their question');
    expect(prompt).toContain('the question it helps answer, and the evidence expected');
  });
});

