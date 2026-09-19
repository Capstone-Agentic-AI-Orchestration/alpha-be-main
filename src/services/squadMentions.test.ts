import { describe, it, expect } from 'vitest';
import { resolveChatTarget, resolveMentions } from './chatService.js';
import { orderedMembers, SUPPORTED_TOPOLOGIES, isSupportedTopology } from './squadRunner.js';
import { Squad } from '../models/index.js';

/**
 * Addressing a squad.
 *
 * A squad used to be CRUD and a button: `triggerSquadRun` incremented a
 * counter, posted a notification and set a 4.5s timer. Nothing could be said
 * to a squad and nothing could be run by one. These pin the two rules that
 * make addressing one predictable.
 */

const agents = [
  { id: 'agent-architect', name: 'Ada Lovelace', role: 'Architect' },
  { id: 'agent-developer', name: 'Kaelen Vance', role: 'Coder' },
  { id: 'agent-reviewer', name: 'Vesper Lin', role: 'Reviewer' },
  { id: 'agent-tester', name: 'Orion Cross', role: 'QA Tester' }
];

const squad = (over: Partial<Squad> = {}): Squad => ({
  id: 'squad-core',
  name: 'Alpha Core Execution Squad',
  topology: 'Sequential',
  leaderAgentId: 'agent-developer',
  memberAgentIds: ['agent-architect', 'agent-developer', 'agent-reviewer'],
  mission: 'Triage and implement.',
  activeRunsCount: 0,
  completedRunsCount: 0,
  ...over
});

const ids = (result: any[]) => result.map(a => a.id);

describe('resolveMentions — agents', () => {
  it('still resolves a single agent by first name', () => {
    expect(ids(resolveMentions('@Ada can you look', agents, []))).toEqual(['agent-architect']);
  });

  it('resolves nobody when no one is named', () => {
    expect(resolveMentions('hello', agents, [squad()])).toEqual([]);
  });
});

describe('resolveChatTarget — Chats picker', () => {
  it('routes an unmentioned message to the selected agent', () => {
    expect(ids(resolveChatTarget('agent-reviewer', undefined, agents, [])))
      .toEqual(['agent-reviewer']);
  });

  it('expands a selected squad in leader-first order', () => {
    expect(ids(resolveChatTarget(undefined, 'squad-core', agents, [squad()])))
      .toEqual(['agent-developer', 'agent-architect', 'agent-reviewer']);
  });

  it('returns no target for Automatic Alpha mode', () => {
    expect(resolveChatTarget(undefined, undefined, agents, [squad()])).toEqual([]);
  });
});

describe('resolveMentions — squads', () => {
  it('expands a squad to its members, leader first', () => {
    // Leader is Kaelen, listed second. Order of address is order of execution.
    expect(ids(resolveMentions('@AlphaCoreExecutionSquad ship it', agents, [squad()])))
      .toEqual(['agent-developer', 'agent-architect', 'agent-reviewer']);
  });

  it('resolves a squad by id', () => {
    expect(ids(resolveMentions('@squad-core ship it', agents, [squad()])))
      .toEqual(['agent-developer', 'agent-architect', 'agent-reviewer']);
  });

  it('does NOT match a squad on its first word', () => {
    /**
     * The seeded squad is "Alpha Core Execution Squad" and the default
     * assistant is called Alpha. Matching first words would make "@Alpha"
     * summon four agents instead of Alpha answering, which is both surprising
     * and four CLI invocations the user did not ask for.
     */
    expect(resolveMentions('@Alpha what is this repo', agents, [squad()])).toEqual([]);
  });

  it('lets an agent name win a tie with a squad name', () => {
    const collides = squad({ id: 'sq-ada', name: 'Ada' });
    expect(ids(resolveMentions('@Ada thoughts?', agents, [collides]))).toEqual(['agent-architect']);
  });

  it('does not make a member answer twice when named alongside their squad', () => {
    const result = resolveMentions('@squad-core and especially @Vesper', agents, [squad()]);
    expect(ids(result)).toEqual(['agent-developer', 'agent-architect', 'agent-reviewer']);
  });

  it('skips members that no longer exist rather than yielding undefined', () => {
    const stale = squad({ memberAgentIds: ['agent-architect', 'agent-deleted'], leaderAgentId: undefined });
    expect(ids(resolveMentions('@squad-core go', agents, [stale]))).toEqual(['agent-architect']);
  });

  it('keeps two squads in the order they were named', () => {
    const other = squad({ id: 'sq-qa', name: 'QA Squad', memberAgentIds: ['agent-tester'], leaderAgentId: undefined });
    expect(ids(resolveMentions('@sq-qa then @squad-core', agents, [squad(), other])))
      .toEqual(['agent-tester', 'agent-developer', 'agent-architect', 'agent-reviewer']);
  });
});

describe('orderedMembers', () => {
  it('puts the leader first', () => {
    expect(orderedMembers(squad())).toEqual(['agent-developer', 'agent-architect', 'agent-reviewer']);
  });

  it('keeps the configured order when there is no leader', () => {
    expect(orderedMembers(squad({ leaderAgentId: undefined })))
      .toEqual(['agent-architect', 'agent-developer', 'agent-reviewer']);
  });

  it('ignores a leader who is not a member', () => {
    expect(orderedMembers(squad({ leaderAgentId: 'agent-tester' })))
      .toEqual(['agent-architect', 'agent-developer', 'agent-reviewer']);
  });

  it('de-duplicates, so nobody runs twice in one squad', () => {
    expect(orderedMembers(squad({ memberAgentIds: ['agent-architect', 'agent-architect', 'agent-developer'] })))
      .toEqual(['agent-developer', 'agent-architect']);
  });
});

describe('topology', () => {
  it('supports Sequential only', () => {
    /**
     * Hierarchical and Consensus have always been selectable, and nothing ever
     * branched on them — topology was display text and a list filter. Running
     * them as Sequential while the UI calls them something else is the same
     * defect as a run reporting tests it never executed, so they are refused
     * until they mean something.
     */
    expect([...SUPPORTED_TOPOLOGIES]).toEqual(['Sequential']);
    expect(isSupportedTopology('Sequential')).toBe(true);
    expect(isSupportedTopology('Hierarchical')).toBe(false);
    expect(isSupportedTopology('Consensus')).toBe(false);
  });

  it('accepts the lowercase spelling the frontend uses', () => {
    /**
     * The daemon's model says 'Sequential'; the frontend's SquadTopology says
     * 'sequential', and its create form defaults to 'hierarchical'. An exact
     * match would refuse every squad built in the UI on a spelling difference.
     */
    expect(isSupportedTopology('sequential')).toBe(true);
    expect(isSupportedTopology(' Sequential ')).toBe(true);
  });

  it('refuses swarm, which only ever existed as a frontend label', () => {
    expect(isSupportedTopology('swarm')).toBe(false);
  });

  it('refuses a missing topology rather than assuming one', () => {
    expect(isSupportedTopology(undefined)).toBe(false);
    expect(isSupportedTopology('')).toBe(false);
  });
});
