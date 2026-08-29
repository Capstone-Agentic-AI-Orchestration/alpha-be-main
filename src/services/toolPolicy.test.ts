import { describe, it, expect } from 'vitest';
import {
  CHAT_ALLOWED_TOOLS,
  CHAT_DISALLOWED_TOOLS,
  describeChatToolPolicy,
  describeRoster
} from './toolPolicy.js';

describe('describeChatToolPolicy', () => {
  it('names every tool that is actually allowed', () => {
    const text = describeChatToolPolicy();
    for (const tool of CHAT_ALLOWED_TOOLS) expect(text).toContain(tool);
  });

  it('names every tool that is actually denied', () => {
    const text = describeChatToolPolicy();
    for (const tool of CHAT_DISALLOWED_TOOLS) expect(text).toContain(tool);
  });

  it('tells the agent what to do instead, not only what it cannot do', () => {
    // A model told only what it cannot do still narrates doing it; the reply
    // needs somewhere to go.
    const text = describeChatToolPolicy();

    expect(text).toMatch(/propose changes/i);
    expect(text).toMatch(/file path/i);
    expect(text).toMatch(/do not claim/i);
  });

  it('does not claim a write would fail, because on agy it would not', () => {
    // agy has no tool-permission flags: --sandbox does not stop write_to_file
    // and --mode plan is ignored. Asserting a mechanism that does not hold on
    // every family teaches the model to disbelieve the constraint.
    const text = describeChatToolPolicy();

    expect(text).not.toMatch(/fails rather than asking permission/i);
    expect(text).toMatch(/do not Write, Edit, Bash/i);
    expect(text).toMatch(/nothing you write here reaches/i);
  });

  it('lists the granted MCP servers', () => {
    const text = describeChatToolPolicy(['alpha-github', 'filesystem']);
    expect(text).toContain('alpha-github, filesystem');
  });

  it('says nothing about MCP when none were granted', () => {
    expect(describeChatToolPolicy([]).toLowerCase()).not.toContain('mcp server');
    expect(describeChatToolPolicy().toLowerCase()).not.toContain('mcp server');
  });

  it('is a self-contained markdown section', () => {
    expect(describeChatToolPolicy().trimStart().startsWith('##')).toBe(true);
  });

  it('does not promise write access anywhere in the text', () => {
    const text = describeChatToolPolicy();
    expect(text).not.toMatch(/you can (write|edit|run)/i);
  });
});

describe('the policy arrays themselves', () => {
  it('never lists a tool as both allowed and denied', () => {
    const overlap = CHAT_ALLOWED_TOOLS.filter(t =>
      (CHAT_DISALLOWED_TOOLS as readonly string[]).includes(t)
    );
    expect(overlap).toEqual([]);
  });

  it('keeps chat read-only — no mutating tool is allowed', () => {
    for (const mutating of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
      expect(CHAT_ALLOWED_TOOLS as readonly string[]).not.toContain(mutating);
    }
  });
});

describe('describeRoster', () => {
  const roster = [
    { id: 'agent-ada', name: 'Ada Lovelace', role: 'Architect' },
    { id: 'agent-kaelen', name: 'Kaelen Vance', role: 'Coder' },
    { id: 'agent-orion', name: 'Orion Cross', role: 'QA Tester' }
  ];

  it('lists every agent with its role', () => {
    const text = describeRoster(roster, 'agent-ada');

    expect(text).toContain('Ada Lovelace — Architect');
    expect(text).toContain('Kaelen Vance — Coder');
    expect(text).toContain('Orion Cross — QA Tester');
  });

  it('marks which one the agent itself is', () => {
    expect(describeRoster(roster, 'agent-kaelen')).toContain('Kaelen Vance — Coder (you)');
  });

  it('marks only one agent as self', () => {
    const matches = describeRoster(roster, 'agent-ada').match(/\(you\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('forbids reporting the underlying CLI\'s own agents', () => {
    // The reported bug: an agent recited the machine owner's personal roster,
    // then, once isolated, recited its CLI's internal subagent types instead.
    const text = describeRoster(roster, 'agent-ada');

    expect(text).toMatch(/never report the underlying cli/i);
    expect(text).toMatch(/not part of Alpha/i);
  });

  it('tells the agent to answer with this list when asked', () => {
    expect(describeRoster(roster, 'agent-ada')).toMatch(/answer with this list/i);
  });

  it('is empty when there is no roster, rather than an empty heading', () => {
    expect(describeRoster([], 'agent-ada')).toBe('');
  });

  it('handles an agent that is not itself in the roster', () => {
    const text = describeRoster(roster, 'agent-unknown');
    expect(text).toContain('Ada Lovelace');
    expect(text).not.toContain('(you)');
  });
});
