import { describe, it, expect } from 'vitest';
import {
  CHAT_BASE_TOOLS,
  GRANTABLE_TOOLS,
  SKILL_TOOLS,
  chatToolsFor,
  describeChatToolPolicy,
  describeReplyFormat,
  describeRoster
} from './toolPolicy.js';

/** The seeded Developer: files and shell, plus GitHub. */
const DEV_SKILLS = ['sk-fs', 'sk-bash', 'sk-git'];

describe('chatToolsFor', () => {
  it('grants inspection only to an agent with no skills at all', () => {
    const { allowed, denied } = chatToolsFor([]);

    expect(allowed).toEqual([...CHAT_BASE_TOOLS]);
    // The old behaviour, kept as the floor: every mutating tool still denied.
    for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
      expect(denied).toContain(tool);
    }
  });

  it('treats a missing skills list the same as an empty one', () => {
    expect(chatToolsFor()).toEqual(chatToolsFor([]));
  });

  it('grants the file tools to sk-fs, and still no shell', () => {
    const { allowed, denied } = chatToolsFor(['sk-fs']);

    expect(allowed).toContain('Write');
    expect(allowed).toContain('Edit');
    expect(denied).toContain('Bash');
  });

  it('grants the shell to sk-bash, and still no file tools', () => {
    const { allowed, denied } = chatToolsFor(['sk-bash']);

    expect(allowed).toContain('Bash');
    expect(denied).toContain('Write');
    expect(denied).toContain('Edit');
  });

  it('grants no CLI tool for sk-git — GitHub is not one', () => {
    // What sk-git grants is MCP write access, resolved by mcpAccessFor.
    expect(chatToolsFor(['sk-git'])).toEqual(chatToolsFor([]));
  });

  it('unions the tools when several skills grant overlapping ones', () => {
    const { allowed } = chatToolsFor(['sk-bash', 'sk-code-exec']);

    // Both map to Bash; it must appear once, not twice.
    expect(allowed.filter(t => t === 'Bash')).toHaveLength(1);
  });

  it('ignores an unknown skill id rather than throwing', () => {
    // The catalog is seeded data a user can add to, so an id this map has not
    // been taught must grant nothing — not fail in the middle of a turn.
    expect(() => chatToolsFor(['sk-not-a-real-skill'])).not.toThrow();
    expect(chatToolsFor(['sk-not-a-real-skill'])).toEqual(chatToolsFor([]));
  });

  it('never lists a tool as both allowed and denied', () => {
    for (const skills of [[], ['sk-fs'], DEV_SKILLS, Object.keys(SKILL_TOOLS)]) {
      const { allowed, denied } = chatToolsFor(skills);
      expect(allowed.filter(t => denied.includes(t))).toEqual([]);
    }
  });

  it('never denies a base tool, whatever was granted', () => {
    for (const skills of [[], ['sk-fs'], DEV_SKILLS]) {
      const { denied } = chatToolsFor(skills);
      for (const base of CHAT_BASE_TOOLS) expect(denied).not.toContain(base);
    }
  });

  it('accounts for every grantable tool in one list or the other', () => {
    // The denied list is the computed complement, so a tool falling out of both
    // would be one the runner never names — and therefore one the CLI prompts
    // about, on a headless process with no TTY to answer.
    const { allowed, denied } = chatToolsFor(DEV_SKILLS);
    for (const tool of GRANTABLE_TOOLS) {
      expect(allowed.includes(tool) || denied.includes(tool)).toBe(true);
    }
  });
});

describe('describeChatToolPolicy', () => {
  it('names every tool that is actually allowed', () => {
    const text = describeChatToolPolicy([], DEV_SKILLS);
    for (const tool of chatToolsFor(DEV_SKILLS).allowed) expect(text).toContain(tool);
  });

  it('names every tool that is actually denied', () => {
    const text = describeChatToolPolicy([], ['sk-fs']);
    for (const tool of chatToolsFor(['sk-fs']).denied) expect(text).toContain(tool);
  });

  it('tells an ungranted agent what to do instead, not only what it cannot do', () => {
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
    expect(text).toMatch(/nothing you write here reaches/i);
  });

  it('keeps the read-only wording for an agent granted nothing', () => {
    const text = describeChatToolPolicy();

    expect(text).toMatch(/inspection and advice only/i);
    expect(text).toMatch(/do not Write, Edit/i);
    expect(text).not.toMatch(/your file edits are real/i);
  });

  it('tells a granted agent its edits are real and unreviewed', () => {
    // A model that believes its edits are hypothetical is careless with them.
    const text = describeChatToolPolicy([], ['sk-fs']);

    expect(text).toMatch(/your file edits are real/i);
    expect(text).toMatch(/no branch, no diff and no approval/i);
    expect(text).not.toMatch(/inspection and advice only/i);
    expect(text).not.toMatch(/do not claim to have created or edited/i);
  });

  it('stops promising the shell is blocked once sk-bash is granted', () => {
    expect(describeChatToolPolicy()).toMatch(/shell commands are blocked/i);
    expect(describeChatToolPolicy([], ['sk-bash'])).not.toMatch(/shell commands are blocked/i);
  });

  it('lists the granted MCP servers', () => {
    const text = describeChatToolPolicy(['alpha-github', 'filesystem']);
    expect(text).toContain('alpha-github, filesystem');
  });

  it('says nothing about MCP when none were granted', () => {
    expect(describeChatToolPolicy([]).toLowerCase()).not.toContain('mcp server');
    expect(describeChatToolPolicy().toLowerCase()).not.toContain('mcp server');
  });

  it('states the GitHub ceiling when alpha-github is granted with write', () => {
    const text = describeChatToolPolicy(['alpha-github'], DEV_SKILLS, 'write');

    expect(text).toMatch(/push a branch/i);
    // No level reaches these — they belong to the person at the review gate.
    expect(text).toMatch(/may not merge, force-push/i);
  });

  it('says GitHub is read-only when write was not granted', () => {
    const text = describeChatToolPolicy(['alpha-github'], ['sk-fs'], 'read');

    expect(text).toMatch(/read access only/i);
    expect(text).not.toMatch(/you may push a branch/i);
  });

  it('says nothing about GitHub when that server was not granted', () => {
    expect(describeChatToolPolicy(['filesystem'], DEV_SKILLS, 'write')).not.toMatch(/github/i);
  });

  it('is a self-contained markdown section', () => {
    expect(describeChatToolPolicy().trimStart().startsWith('##')).toBe(true);
  });

  it('does not promise write access to an agent that has none', () => {
    const text = describeChatToolPolicy();
    expect(text).not.toMatch(/you can (write|edit|run)/i);
  });
});

describe('the policy map itself', () => {
  it('never grants a base tool through a skill', () => {
    // A skill grants something in addition to inspection, never inspection
    // itself — otherwise the same tool arrives from two places.
    for (const tools of Object.values(SKILL_TOOLS)) {
      for (const base of CHAT_BASE_TOOLS) expect(tools).not.toContain(base);
    }
  });

  it('lists every skill-granted tool as grantable', () => {
    // GRANTABLE_TOOLS is what the denied list is computed from, so a tool a
    // skill grants but this list omits could never be denied to anyone else.
    for (const tools of Object.values(SKILL_TOOLS)) {
      for (const tool of tools) expect(GRANTABLE_TOOLS).toContain(tool);
    }
  });

  it('accounts for every mutating tool, whether a skill grants it or not', () => {
    for (const mutating of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
      expect(GRANTABLE_TOOLS).toContain(mutating);
    }
  });
});

describe('describeRoster', () => {
  const roster = [
    { id: 'agent-architect', name: 'Ada Lovelace', role: 'Architect' },
    { id: 'agent-developer', name: 'Kaelen Vance', role: 'Coder' },
    { id: 'agent-tester', name: 'Orion Cross', role: 'QA Tester' }
  ];

  it('lists every agent with its role', () => {
    const text = describeRoster(roster, 'agent-architect');

    expect(text).toContain('Ada Lovelace — Architect');
    expect(text).toContain('Kaelen Vance — Coder');
    expect(text).toContain('Orion Cross — QA Tester');
  });

  it('marks which one the agent itself is', () => {
    expect(describeRoster(roster, 'agent-developer')).toContain('Kaelen Vance — Coder (you)');
  });

  it('marks only one agent as self', () => {
    const matches = describeRoster(roster, 'agent-architect').match(/\(you\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('forbids reporting the underlying CLI\'s own agents', () => {
    // The reported bug: an agent recited the machine owner's personal roster,
    // then, once isolated, recited its CLI's internal subagent types instead.
    const text = describeRoster(roster, 'agent-architect');

    expect(text).toMatch(/never report the underlying cli/i);
    expect(text).toMatch(/not part of Alpha/i);
  });

  it('tells the agent to answer with this list when asked', () => {
    expect(describeRoster(roster, 'agent-architect')).toMatch(/answer with this list/i);
  });

  it('is empty when there is no roster, rather than an empty heading', () => {
    expect(describeRoster([], 'agent-architect')).toBe('');
  });

  it('handles an agent that is not itself in the roster', () => {
    const text = describeRoster(roster, 'agent-unknown');
    expect(text).toContain('Ada Lovelace');
    expect(text).not.toContain('(you)');
  });
});

describe('describeReplyFormat', () => {
  const text = describeReplyFormat();

  it('asks for repository-relative paths, and says why', () => {
    // The reply that prompted this carried six absolute file:/// URLs, one of
    // them through a UUID directory under the operator's home.
    expect(text).toMatch(/relative to the project root/i);
    expect(text).toMatch(/file:\/\//);
  });

  it('rules out LaTeX, because nothing renders it', () => {
    expect(text).toMatch(/never LaTeX/i);
    expect(text).toContain('→');
  });

  it('asks for scannable paragraphs and at most one heading level', () => {
    expect(text).toMatch(/short enough to scan/i);
    expect(text).toMatch(/one level of heading/i);
  });

  it('is a self-contained markdown section', () => {
    expect(text.trimStart().startsWith('##')).toBe(true);
  });

  it('says nothing about what the agent may do', () => {
    // Capability is the tool policy's subject. Two sections disagreeing about
    // it is how the agent card came to promise writes the runner denied.
    expect(text).not.toMatch(/\b(allowed|denied|granted|you may not)\b/i);
  });
});
