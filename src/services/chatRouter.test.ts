import { describe, expect, it } from 'vitest';
import {
  ALPHA_ROUTE_MARKER,
  chooseBuildRepositories,
  isBareContinueRequest,
  orchestratorRoutingPrompt,
  parseAlphaRoute,
  parseChatOverride,
  referencesAlphaRecords
} from './chatRouter.js';

describe('continuing a stopped build', () => {
  it('recognises short requests to carry on that name no change of their own', () => {
    for (const message of ['continue', 'Continue.', 'can you continue with the plan', 'ok, go ahead', 'try again', 'retry the build', 'keep going please'])
      expect(isBareContinueRequest(message), message).toBe(true);
    for (const message of ['continue and add a dark mode toggle', 'why did it stop?', 'add a budget page', 'continue explaining the login flow'])
      expect(isBareContinueRequest(message), message).toBe(false);
  });

  it('flags goals that point at records a specialist cannot open', () => {
    expect(referencesAlphaRecords('Continue the Money Tracker UI redesign from the saved MON-104 plan and preserved work.')).toBe(true);
    expect(referencesAlphaRecords('Review the previous failure and finish the redesign.')).toBe(true);
    expect(referencesAlphaRecords('Create a redesigned UI for Money tracker with clear navigation and responsive layouts.')).toBe(false);
  });

  it('tells Alpha that build goals must stand on their own', () => {
    const prompt = orchestratorRoutingPrompt({ projectName: 'Money tracker', repositories: ['org/app-fe'], canBuild: true });
    expect(prompt).toContain('cannot read this conversation, issue keys such as MON-104, earlier builds');
  });
});

describe('parseAlphaRoute', () => {
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

describe('chooseBuildRepositories', () => {
  it('lets Alpha narrow the composer selection', () => {
    expect(chooseBuildRepositories(['org/fe', 'org/be'], ['org/fe'])).toEqual(['org/fe']);
  });

  it('never widens the composer selection', () => {
    expect(chooseBuildRepositories(['org/fe'], ['org/be'])).toEqual(['org/fe']);
  });

  it('uses Alpha\'s choice when nothing was selected', () => {
    expect(chooseBuildRepositories(undefined, ['org/be'])).toEqual(['org/be']);
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

  it('forbids the decision line when the user cannot build', () => {
    const prompt = orchestratorRoutingPrompt({ repositories: [], canBuild: false });
    expect(prompt).toMatch(/cannot start them/);
    expect(prompt).toMatch(/Never write the/);
  });

  it('forbids the decision line for an answer-only message', () => {
    expect(orchestratorRoutingPrompt({ repositories: [], canBuild: true, answerOnly: true })).toMatch(/answer only/);
  });
});

