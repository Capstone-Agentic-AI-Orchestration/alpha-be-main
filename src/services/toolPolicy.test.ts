import { describe, it, expect } from 'vitest';
import {
  CHAT_ALLOWED_TOOLS,
  CHAT_DISALLOWED_TOOLS,
  describeChatToolPolicy
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

  it('says an attempt fails rather than prompts, which is what actually happens', () => {
    expect(describeChatToolPolicy()).toMatch(/fails rather than asking permission/i);
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
