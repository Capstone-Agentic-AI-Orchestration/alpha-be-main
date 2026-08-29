import { describe, it, expect, vi } from 'vitest';

import { buildTurnInvocation, CliTurnOptions } from './cliRunner.js';

vi.mock('./runtimeService.js', () => ({
  RuntimeService: { agyPath: () => '/opt/antigravity/agy' }
}));

const noMcp = { configPath: null as string | null, serverNames: [] as string[] };

const options = (over: Partial<CliTurnOptions> = {}): CliTurnOptions => ({
  runId: 'chat-1',
  cwd: '/workspaces',
  provider: 'Anthropic',
  modelName: 'claude-sonnet-5',
  systemPrompt: 'You are Ada.',
  personaName: 'Ada Lovelace',
  prompt: 'What does this service do?',
  priorSession: null,
  ...over
});

/** Value that follows a flag, or undefined when the flag is absent. */
const valueOf = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('buildTurnInvocation — Claude', () => {
  it('appends the persona instead of replacing the default system prompt', () => {
    const { args } = buildTurnInvocation(options(), noMcp);

    // The regression this guards: --system-prompt REPLACES the CLI's default
    // system prompt, leaving the model with only the persona line.
    expect(args).not.toContain('--system-prompt');
    expect(valueOf(args, '--append-system-prompt')).toBe('You are Ada.');
  });

  it('omits the flag entirely when there is no persona', () => {
    const { args } = buildTurnInvocation(options({ systemPrompt: '' }), noMcp);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('omits the flag when the persona is only whitespace', () => {
    const { args } = buildTurnInvocation(options({ systemPrompt: '   \n  ' }), noMcp);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('passes the configured model', () => {
    const { args } = buildTurnInvocation(options({ modelName: 'claude-opus-5' }), noMcp);
    expect(valueOf(args, '--model')).toBe('claude-opus-5');
  });

  it('omits --model when the agent has none', () => {
    const { args } = buildTurnInvocation(options({ modelName: undefined }), noMcp);
    expect(args).not.toContain('--model');
  });

  it('keeps the flags that make stream-json work at all', () => {
    const { args, bin, family } = buildTurnInvocation(options(), noMcp);

    expect(family).toBe('claude');
    expect(bin).toMatch(/^claude(\.cmd)?$/);
    expect(valueOf(args, '-p')).toBe('What does this service do?');
    expect(valueOf(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
  });

  it('keeps the read-only tool policy', () => {
    const { args } = buildTurnInvocation(options(), noMcp);

    expect(args).toContain('--allowedTools');
    expect(args).toContain('--disallowedTools');
    for (const denied of ['Write', 'Edit', 'Bash']) expect(args).toContain(denied);
  });

  it('isolates the run from the operator\'s own Claude Code settings', () => {
    const { args } = buildTurnInvocation(options(), noMcp);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('attaches MCP config strictly when servers were granted', () => {
    const { args } = buildTurnInvocation(options(), {
      configPath: '/runs/chat-1/mcp.json',
      serverNames: ['alpha-github']
    });

    expect(valueOf(args, '--mcp-config')).toBe('/runs/chat-1/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('mcp__alpha-github');
  });

  it('adds no MCP flags when nothing was granted', () => {
    const { args } = buildTurnInvocation(options(), noMcp);
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('resumes a prior session', () => {
    const { args } = buildTurnInvocation(options({ priorSession: 'sess-42' }), noMcp);
    expect(valueOf(args, '--resume')).toBe('sess-42');
  });

  it('does not prepend the persona to the prompt — the flag carries it', () => {
    const { args } = buildTurnInvocation(options(), noMcp);
    expect(valueOf(args, '-p')).not.toContain('You are Ada.');
  });
});

describe('buildTurnInvocation — Codex', () => {
  const codex = (over: Partial<CliTurnOptions> = {}) =>
    buildTurnInvocation(options({ provider: 'OpenAI', modelName: 'gpt-5-codex', ...over }), noMcp);

  it('prepends the persona to the prompt, since codex takes no persona flag', () => {
    const { args, family } = codex();

    expect(family).toBe('codex');
    expect(args.at(-1)).toContain('You are Ada.');
    expect(args.at(-1)).toContain('Stay in character as Ada Lovelace');
    expect(args.at(-1)).toContain('What does this service do?');
  });

  it('does not repeat the persona once a session exists', () => {
    const { args } = codex({ priorSession: 'sess-9' });
    expect(args.at(-1)).toBe('What does this service do?');
  });

  it('places --model before the -- terminator, or it would be read as prompt text', () => {
    const { args } = codex();

    const modelAt = args.indexOf('--model');
    const terminatorAt = args.indexOf('--');
    expect(modelAt).toBeGreaterThan(-1);
    expect(modelAt).toBeLessThan(terminatorAt);
    expect(valueOf(args, '--model')).toBe('gpt-5-codex');
  });

  it('keeps the prompt as the final positional argument', () => {
    const { args } = codex();
    expect(args.indexOf('--')).toBe(args.length - 2);
  });

  it('keeps the sandbox and git-check flags', () => {
    const { args } = codex();
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(valueOf(args, '--sandbox')).toBe('read-only');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('adds no MCP flags — codex takes them from its own settings file', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI' }), {
      configPath: '/runs/chat-1/mcp.json',
      serverNames: ['alpha-github']
    });

    expect(args).not.toContain('--mcp-config');
  });
});

describe('persona re-injection mid-session', () => {
  const codex = (over: Partial<CliTurnOptions> = {}) =>
    buildTurnInvocation(options({ provider: 'OpenAI', ...over }), noMcp);

  it('omits the persona on a continuing session when nothing changed', () => {
    expect(codex({ priorSession: 'sess-1' }).args.at(-1)).toBe('What does this service do?');
  });

  it('re-injects the persona when it changed under a live session', () => {
    const prompt = codex({ priorSession: 'sess-1', personaChanged: true }).args.at(-1)!;

    expect(prompt).toContain('You are Ada.');
    expect(prompt).toContain('What does this service do?');
  });

  it('words the re-injection as a replacement, not an introduction', () => {
    // Dropped in unannounced, a second persona reads as a duplicate rather than
    // a correction, and the model cannot tell which one now governs.
    const prompt = codex({ priorSession: 'sess-1', personaChanged: true }).args.at(-1)!;

    expect(prompt).toContain('Your instructions have been updated');
    expect(prompt).toContain('replaces any earlier instructions');
  });

  it('does not add that preamble on a brand new session', () => {
    const prompt = codex({ priorSession: null }).args.at(-1)!;

    expect(prompt).toContain('You are Ada.');
    expect(prompt).not.toContain('Your instructions have been updated');
  });

  it('changes nothing when the agent has no persona at all', () => {
    const prompt = codex({
      priorSession: 'sess-1',
      personaChanged: true,
      systemPrompt: ''
    }).args.at(-1);

    expect(prompt).toBe('What does this service do?');
  });

  it('applies to Antigravity too', () => {
    const { args } = buildTurnInvocation(
      options({ provider: 'Antigravity', priorSession: 'conv-1', personaChanged: true }),
      noMcp
    );

    expect(valueOf(args, '-p')).toContain('Your instructions have been updated');
  });

  it('is irrelevant to Claude, which resends the persona by flag every turn', () => {
    const { args } = buildTurnInvocation(
      options({ priorSession: 'sess-1', personaChanged: true }),
      noMcp
    );

    expect(valueOf(args, '--append-system-prompt')).toBe('You are Ada.');
    expect(valueOf(args, '-p')).toBe('What does this service do?');
  });
});

describe('custom CLI arguments', () => {
  it('appends a permitted flag to the Claude argv', () => {
    const { args } = buildTurnInvocation(options({ customCliArgs: '--debug' }), noMcp);
    expect(args).toContain('--debug');
  });

  it('cannot override the tool policy the runner set', () => {
    const { args } = buildTurnInvocation(
      options({ customCliArgs: '--dangerously-skip-permissions --allowedTools Bash' }),
      noMcp
    );

    expect(args).not.toContain('--dangerously-skip-permissions');

    // `Bash` is legitimately present as a DENIED tool, so the check has to be
    // that it did not get into the allowed list — not that it is absent.
    const allowed = args.slice(
      args.indexOf('--allowedTools') + 1,
      args.indexOf('--disallowedTools')
    );
    expect(allowed).toEqual(['Read', 'Glob', 'Grep']);
    expect(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--setting-sources')))
      .toEqual(['Write', 'Edit', 'Bash']);
  });

  it('cannot replace the composed persona', () => {
    const { args } = buildTurnInvocation(
      options({ customCliArgs: '--system-prompt hijacked' }),
      noMcp
    );

    expect(args).not.toContain('--system-prompt');
    expect(valueOf(args, '--append-system-prompt')).toBe('You are Ada.');
  });

  it('places codex custom flags before the -- terminator', () => {
    const { args } = buildTurnInvocation(
      options({ provider: 'OpenAI', customCliArgs: '--debug' }),
      noMcp
    );

    expect(args.indexOf('--debug')).toBeLessThan(args.indexOf('--'));
  });

  it('adds nothing when the field is empty', () => {
    const withArgs = buildTurnInvocation(options({ customCliArgs: '' }), noMcp).args;
    const without = buildTurnInvocation(options(), noMcp).args;

    expect(withArgs).toEqual(without);
  });
});

describe('buildTurnInvocation — Antigravity', () => {
  const agy = (over: Partial<CliTurnOptions> = {}) =>
    buildTurnInvocation(options({ provider: 'Antigravity', modelName: 'gemini-3-pro', ...over }), noMcp);

  it('resolves the install path rather than trusting PATH', () => {
    const { bin, family } = agy();
    expect(family).toBe('antigravity');
    expect(bin).toBe('/opt/antigravity/agy');
  });

  it('prepends the persona to the prompt', () => {
    const { args } = agy();
    expect(valueOf(args, '-p')).toContain('You are Ada.');
  });

  it('passes the model and resumes with --conversation', () => {
    const { args } = agy({ priorSession: 'conv-3' });
    expect(valueOf(args, '--model')).toBe('gemini-3-pro');
    expect(valueOf(args, '--conversation')).toBe('conv-3');
  });

  it('treats Google Gemini as the same family', () => {
    expect(buildTurnInvocation(options({ provider: 'Google Gemini' }), noMcp).family).toBe(
      'antigravity'
    );
  });
});

describe('isolation from the operator\'s own CLI configuration', () => {
  it('gives Antigravity a managed home so ~/.gemini does not leak in', () => {
    // The bug: asked what agents existed, an agent recited the machine
    // owner's personal roster out of ~/.gemini/GEMINI.md and ~/.gemini/agents.
    const { env } = buildTurnInvocation(options({ provider: 'Antigravity' }), noMcp);

    expect(env.HOME).toBeTruthy();
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.HOME).not.toContain('.gemini');
  });

  it('sets both HOME and USERPROFILE, since the CLIs are a mix of Go and Node', () => {
    const { env } = buildTurnInvocation(options({ provider: 'Antigravity' }), noMcp);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'USERPROFILE']);
  });

  it('disables slash commands so a message starting with / stays a message', () => {
    const { args } = buildTurnInvocation(options({ provider: 'Antigravity' }), noMcp);
    expect(args).toContain('--disable-slash-commands');
  });

  it('leaves Claude on the real home — its credentials live there', () => {
    expect(buildTurnInvocation(options(), noMcp).env).toEqual({});
  });

  it('leaves Codex on the real home — auth.json lives under ~/.codex', () => {
    expect(buildTurnInvocation(options({ provider: 'OpenAI' }), noMcp).env).toEqual({});
  });

  it('still isolates Claude through --setting-sources', () => {
    const { args } = buildTurnInvocation(options(), noMcp);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('treats Google Gemini as Antigravity for isolation too', () => {
    const { env } = buildTurnInvocation(options({ provider: 'Google Gemini' }), noMcp);
    expect(env.HOME).toBeTruthy();
  });

  it('does not let an agent env var override the isolation', () => {
    // buildTurnInvocation owns env; runCliTurn spreads it AFTER options.env
    // precisely so a HOME in an agent's envVars cannot defeat this.
    const { env } = buildTurnInvocation(options({ provider: 'Antigravity' }), noMcp);
    const merged = { ...{ HOME: '/c/Users/Lloyd' }, ...env };
    expect(merged.HOME).toBe(env.HOME);
  });
});

describe('Codex isolation from the operator config', () => {
  it('ignores ~/.codex/config.toml', () => {
    // Without this the agent inherited the operator's MCP servers — a node
    // REPL and a live supabase project — plus eighteen trusted paths.
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI' }), noMcp);
    expect(args).toContain('--ignore-user-config');
  });

  it('places it before the -- terminator', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI' }), noMcp);
    expect(args.indexOf('--ignore-user-config')).toBeLessThan(args.indexOf('--'));
  });

  it('keeps the read-only sandbox alongside it', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI' }), noMcp);
    expect(valueOf(args, '--sandbox')).toBe('read-only');
  });

  it('cannot be undone through customCliArgs', () => {
    const { args } = buildTurnInvocation(
      options({ provider: 'OpenAI', customCliArgs: '--sandbox danger-full-access' }),
      noMcp
    );
    expect(valueOf(args, '--sandbox')).toBe('read-only');
    expect(args).not.toContain('danger-full-access');
  });

  it('does not apply the flag to other families', () => {
    expect(buildTurnInvocation(options(), noMcp).args).not.toContain('--ignore-user-config');
    expect(
      buildTurnInvocation(options({ provider: 'Antigravity' }), noMcp).args
    ).not.toContain('--ignore-user-config');
  });
});
