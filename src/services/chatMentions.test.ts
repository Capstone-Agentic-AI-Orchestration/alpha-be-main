import { describe, it, expect } from 'vitest';
import { resolveChatTarget, resolveMentions } from './chatService.js';

const agents = [
  { id: 'agent-architect', name: 'Ada Lovelace', role: 'Architect' },
  { id: 'agent-developer', name: 'Kaelen Vance', role: 'Coder' },
  { id: 'agent-reviewer', name: 'Vesper Lin', role: 'Reviewer' }
];

const ids = (result: any[]) => result.map(a => a.id);

describe('resolveMentions', () => {
  it('resolves an agent by first name, id, or role', () => {
    expect(ids(resolveMentions('@Ada can you look', agents))).toEqual(['agent-architect']);
    expect(ids(resolveMentions('@agent-developer please', agents))).toEqual(['agent-developer']);
    expect(ids(resolveMentions('@Reviewer thoughts?', agents))).toEqual(['agent-reviewer']);
  });

  it('keeps mention order and does not answer twice for the same agent', () => {
    expect(ids(resolveMentions('@Vesper then @Ada and @Vesper again', agents)))
      .toEqual(['agent-reviewer', 'agent-architect']);
  });

  it('no longer expands a squad name or id into its members', () => {
    expect(resolveMentions('@squad-core ship it', agents)).toEqual([]);
    expect(resolveMentions('@AlphaCoreExecutionSquad ship it', agents)).toEqual([]);
  });
});

describe('resolveChatTarget', () => {
  it('routes an unmentioned message to the selected agent', () => {
    expect(ids(resolveChatTarget('agent-reviewer', agents))).toEqual(['agent-reviewer']);
  });

  it('returns no target for Automatic Alpha mode or a missing agent', () => {
    expect(resolveChatTarget(undefined, agents)).toEqual([]);
    expect(resolveChatTarget('agent-deleted', agents)).toEqual([]);
  });
});
