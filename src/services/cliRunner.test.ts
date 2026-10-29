import { describe, it, expect, vi } from 'vitest';

import { buildTurnInvocation, CliTurnOptions } from './cliRunner.js';
import { skillsForChatApproval } from './toolPolicy.js';

vi.mock('./runtimeService.js', () => ({
  RuntimeService: {
    agyPath: () => '/opt/antigravity/agy',
    claudePath: () => (process.platform === 'win32' ? 'claude.cmd' : 'claude'),
    codexPath: () => (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    geminiPath: () => (process.platform === 'win32' ? 'gemini.cmd' : 'gemini'),
    opencodePath: () => (process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
  }
}));

const noMcp = { configPath: null as string | null, serverNames: [] as string[] };

describe('scoped task native permissions', () => {
  it.each(['OpenAI', 'Anthropic', 'Antigravity', 'Google Gemini', 'OpenCode'])('keeps %s native writes and commands disabled while exposing only task MCP', provider => {
    const invocation = buildTurnInvocation(options({ provider, mode: 'chat', approvalMode: 'ask', skills: [],
      projectRoots: [{ name: 'task', repo: 'test/repo', dir: '/task/repo' }] }),
      { configPath: '/task/mcp.json', serverNames: ['alpha-task-files'] });
    expect(invocation.args.join(' ')).not.toMatch(/dangerously|acceptEdits|accept-edits|workspace-write|approve-for-me/);
    if (provider === 'OpenAI') expect(invocation.args.join(' ')).toContain('features.shell_tool=false');
    if (provider === 'Anthropic') expect(invocation.args.slice(invocation.args.indexOf('--disallowedTools') + 1)).toContain('Write');
  });
});

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
  it('uses native structured output with no native tools for interpretation', () => {
    const schema = { type: 'object', properties: { intent: { type: 'string' } } };
    const { args } = buildTurnInvocation(options({ responseSchema: schema, toolFree: true, mode: 'chat', approvalMode: 'ask', projectRoots: [], skills: [] }), noMcp);
    expect(valueOf(args, '--json-schema')).toBe(JSON.stringify(schema));
    expect(valueOf(args, '--tools')).toBe('');
  });
  it('passes a runner-owned schema file to Codex before the prompt', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI', responseSchemaPath: '/runs/schema.json', mode: 'chat', approvalMode: 'ask', projectRoots: [] }), noMcp);
    expect(valueOf(args, '--output-schema')).toBe('/runs/schema.json');
    expect(args.join(' ')).toContain('features.shell_tool=false');
  });
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

  it('passes the selected effort through Claude Code', () => {
    const { args } = buildTurnInvocation(options({ reasoningEffort: 'high' }), noMcp);
    expect(valueOf(args, '--effort')).toBe('high');
  });

  it('keeps the flags that make stream-json work at all', () => {
    const { args, bin, family } = buildTurnInvocation(options(), noMcp);

    expect(family).toBe('claude');
    expect(bin).toMatch(/^claude(\.cmd)?$/);
    expect(args).toContain('-p');
    expect(valueOf(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--include-partial-messages');
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

  /**
   * The zero-server case is the one that most needs the fence, and it used to
   * be the only case without it. Without `--strict-mcp-config` the CLI still
   * surfaced the operator's account-level claude.ai connectors to the model —
   * measured: it named Apollo.io, Canva, Figma, Gmail, Google Calendar, Google
   * Drive and Miro to a chat user, unprompted.
   */
  it('fences MCP off entirely when nothing was granted', () => {
    const { args } = buildTurnInvocation(options(), noMcp);
    // No config to point at, but the flag still means "only what --mcp-config
    // gives you", and it gives nothing.
    expect(args).not.toContain('--mcp-config');
    expect(args).toContain('--strict-mcp-config');
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

describe('nothing multi-line may travel in argv', () => {
  /**
   * On Windows `claude` and `codex` are `.cmd` shims, so cross-spawn runs them
   * through cmd.exe — whose command line ends at the first newline. A
   * multi-line argv value was truncated there and every later flag silently
   * discarded, taking --output-format, --setting-sources and --model with it.
   */
  const multiline = 'You are Ada.\n\nAlways answer in one line.';

  // Only the families installed as `.cmd` shims. `agy` is a real executable
  // and takes a multi-line argument intact — verified against the binary — so
  // it keeps its prompt in argv.
  it.each(['Anthropic', 'OpenAI'] as const)(
    'keeps newlines out of %s argv even with a multi-line persona and prompt',
    provider => {
      for (const mode of ['chat', 'run'] as const) {
        const { args } = buildTurnInvocation(
          options({
            provider,
            mode,
            systemPrompt: multiline,
            prompt: 'Do the thing.\nThen stop.',
            personaFile: provider === 'Anthropic' ? '/runs/x/persona.md' : undefined
          }),
          noMcp
        );

        const offender = args.find(a => /[\r\n]/.test(a));
        expect(offender, `${provider}/${mode} put a newline in argv`).toBeUndefined();
      }
    }
  );

  it('still gives Antigravity its prompt in argv, since it is not a shim', () => {
    const { args, stdin } = buildTurnInvocation(
      options({ provider: 'Antigravity', systemPrompt: multiline }),
      noMcp
    );

    expect(stdin).toBeUndefined();
    expect(valueOf(args, '-p')).toContain('What does this service do?');
  });

  it('sends the Claude prompt on stdin, not after -p', () => {
    const { args, stdin } = buildTurnInvocation(options(), noMcp);

    expect(stdin).toBe('What does this service do?');
    expect(args).toContain('-p');
    expect(valueOf(args, '-p')).not.toBe('What does this service do?');
  });

  it('reads the persona from a file when one was written', () => {
    const { args } = buildTurnInvocation(
      options({ personaFile: '/runs/x/persona.md', systemPrompt: multiline }),
      noMcp
    );

    expect(valueOf(args, '--append-system-prompt-file')).toBe('/runs/x/persona.md');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('falls back to the inline flag when no file was written', () => {
    const { args } = buildTurnInvocation(options({ systemPrompt: 'One line.' }), noMcp);

    expect(valueOf(args, '--append-system-prompt')).toBe('One line.');
    expect(args).not.toContain('--append-system-prompt-file');
  });
});

describe('buildTurnInvocation — Codex', () => {
  const codex = (over: Partial<CliTurnOptions> = {}) =>
    buildTurnInvocation(options({ provider: 'OpenAI', modelName: 'gpt-5-codex', ...over }), noMcp);

  it('prepends the persona to the prompt, since codex takes no persona flag', () => {
    const { args, family } = codex();

    expect(family).toBe('codex');
    expect(codex().stdin).toContain('You are Ada.');
    expect(codex().stdin).toContain('Stay in character as Ada Lovelace');
    expect(codex().stdin).toContain('What does this service do?');
  });

  it('repeats the persona on every turn, because codex exec never resumes the saved session', () => {
    const stdin = codex({ priorSession: 'sess-9' }).stdin!;
    expect(stdin).toContain('You are Ada.');
    expect(stdin).toContain('What does this service do?');
    expect(stdin).not.toContain('Your instructions have been updated');
  });

  it('passes the model, with no positional prompt to protect it from', () => {
    // The prompt used to sit after a `--` terminator, which every flag had to
    // precede. On stdin there is no terminator and no ordering hazard.
    const { args } = codex();
    expect(valueOf(args, '--model')).toBe('gpt-5-codex');
    expect(args).not.toContain('--');
  });

  it('passes Codex reasoning as a config override', () => {
    const { args } = codex({ reasoningEffort: 'xhigh' });
    expect(valueOf(args, '--config')).toBe('model_reasoning_effort="xhigh"');
  });

  it('sends the prompt on stdin rather than as an argument', () => {
    const { args, stdin } = codex();
    expect(stdin).toContain('What does this service do?');
    expect(args.join(' ')).not.toContain('What does this service do?');
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

describe('chat access choices across provider CLIs', () => {
  const roots = [{ name: 'app-fe', repo: 'acme/app-fe', dir: 'C:/code/app-fe' }];

  it.each([
    ['OpenAI', 'workspace-write'],
    ['Ollama', 'workspace-write'],
    ['LM Studio', 'workspace-write']
  ] as const)('%s auto-approves project edits while keeping shell fenced', (provider, sandbox) => {
    const { args } = buildTurnInvocation(options({ provider, mode: 'chat', approvalMode: 'approve', projectRoots: roots }), noMcp);
    expect(valueOf(args, '--sandbox')).toBe(sandbox);
    expect(args).toContain('--add-dir');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    if (provider !== 'OpenAI') expect(args).toContain('--local-provider');
  });

  it('applies project-scoped edit permissions to Claude and Gemini CLIs', () => {
    const claude = buildTurnInvocation(options({ mode: 'chat', approvalMode: 'approve', projectRoots: roots }), noMcp).args;
    expect(valueOf(claude, '--permission-mode')).toBe('acceptEdits');
    expect(valueOf(claude, '--add-dir')).toBe(roots[0].dir);
    const gemini = buildTurnInvocation(options({ provider: 'Antigravity', mode: 'chat', approvalMode: 'approve', projectRoots: roots }), noMcp).args;
    expect(valueOf(gemini, '--mode')).toBe('accept-edits');
    expect(gemini).toContain(roots[0].dir);
    expect(gemini).not.toContain('--dangerously-skip-permissions');
    const googleGemini = buildTurnInvocation(options({ provider: 'Google Gemini', mode: 'chat', approvalMode: 'approve', projectRoots: roots }), noMcp).args;
    expect(valueOf(googleGemini, '--mode')).toBe('accept-edits');
  });

  it('configures OpenCode with only approved project roots and its safe shell/web policy', () => {
    const invocation = buildTurnInvocation(options({
      provider: 'OpenCode', mode: 'chat', approvalMode: 'approve', projectRoots: roots
    }), noMcp);
    const config = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission).toMatchObject({ edit: 'allow', bash: 'deny', webfetch: 'deny', websearch: 'deny' });
    expect(config.permission.external_directory).toEqual({ 'C:/code/app-fe/**': 'allow' });
    expect(invocation.args).toContain('--auto');
  });

  it.each(['OpenAI', 'Anthropic', 'Antigravity', 'Google Gemini', 'OpenCode', 'Ollama', 'LM Studio'] as const)(
    '%s maps full access to its native bypass control', provider => {
      const { args } = buildTurnInvocation(options({ provider, mode: 'chat', approvalMode: 'full', projectRoots: roots }), noMcp);
      const bypass = provider === 'OpenAI' || provider === 'Ollama' || provider === 'LM Studio'
        ? '--dangerously-bypass-approvals-and-sandbox'
        : '--dangerously-skip-permissions';
      expect(args).toContain(bypass);
    }
  );

  it('grants web tools only for full access', () => {
    expect(skillsForChatApproval('ask', true)).not.toContain('sk-browser');
    expect(skillsForChatApproval('approve', true)).not.toContain('sk-browser');
    expect(skillsForChatApproval('full', true)).toContain('sk-browser');
  });
});

describe('persona re-injection mid-session', () => {
  // Antigravity continues its saved conversation, so it is the family where
  // "the persona is already in the transcript" is actually true.
  const codex = (over: Partial<CliTurnOptions> = {}) => {
    const { args } = buildTurnInvocation(options({ provider: 'Antigravity', ...over }), noMcp);
    return { stdin: valueOf(args, '-p') };
  };

  it('omits the persona on a continuing session when nothing changed', () => {
    expect(codex({ priorSession: 'sess-1' }).stdin).toBe('What does this service do?');
  });

  it('re-injects the persona when it changed under a live session', () => {
    const prompt = codex({ priorSession: 'sess-1', personaChanged: true }).stdin!;

    expect(prompt).toContain('You are Ada.');
    expect(prompt).toContain('What does this service do?');
  });

  it('words the re-injection as a replacement, not an introduction', () => {
    // Dropped in unannounced, a second persona reads as a duplicate rather than
    // a correction, and the model cannot tell which one now governs.
    const prompt = codex({ priorSession: 'sess-1', personaChanged: true }).stdin!;

    expect(prompt).toContain('Your instructions have been updated');
    expect(prompt).toContain('replaces any earlier instructions');
  });

  it('does not add that preamble on a brand new session', () => {
    const prompt = codex({ priorSession: null }).stdin!;

    expect(prompt).toContain('You are Ada.');
    expect(prompt).not.toContain('Your instructions have been updated');
  });

  it('changes nothing when the agent has no persona at all', () => {
    const prompt = codex({
      priorSession: 'sess-1',
      personaChanged: true,
      systemPrompt: ''
    }).stdin;

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
    expect(
      buildTurnInvocation(options({ priorSession: 'sess-1', personaChanged: true }), noMcp).stdin
    ).toBe('What does this service do?');
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

    // The denied list is the complement of what the agent's skills granted, and
    // this agent was granted none — so every mutating tool is on it.
    const denied = args.slice(
      args.indexOf('--disallowedTools') + 1,
      args.indexOf('--setting-sources')
    );
    for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
      expect(denied).toContain(tool);
    }
  });

  it('cannot replace the composed persona', () => {
    const { args } = buildTurnInvocation(
      options({ customCliArgs: '--system-prompt hijacked' }),
      noMcp
    );

    expect(args).not.toContain('--system-prompt');
    expect(valueOf(args, '--append-system-prompt')).toBe('You are Ada.');
  });

  it('appends codex custom flags to the argv', () => {
    const { args } = buildTurnInvocation(
      options({ provider: 'OpenAI', customCliArgs: '--debug' }),
      noMcp
    );

    expect(args).toContain('--debug');
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

  it('leaves effort to the Antigravity model id, because agy refuses --effort for its models', () => {
    const { args } = agy({ reasoningEffort: 'high' });
    expect(args).not.toContain('--effort');
  });

  it('treats Google Gemini as the same family', () => {
    expect(buildTurnInvocation(options({ provider: 'Google Gemini' }), noMcp).family).toBe(
      'antigravity'
    );
  });

  it('does not invent an effort flag for runtimes without one', () => {
    const { args } = buildTurnInvocation(
      options({ provider: 'Ollama', modelName: 'llama3.2', reasoningEffort: 'high' }),
      noMcp
    );
    expect(args).not.toContain('--effort');
    expect(args).not.toContain('--config');
  });

  it('loads only this turn\'s MCP servers from its isolated system settings', () => {
    const { env } = buildTurnInvocation(options({ provider: 'Antigravity' }), {
      configPath: '/runs/chat-1/mcp.json',
      antigravitySettingsPath: '/runs/chat-1/agy-system-settings.json',
      serverNames: ['alpha-github', 'alpha-project-files']
    });
    expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe('/runs/chat-1/agy-system-settings.json');
  });

  it('limits the agent to the selected project repository folders', () => {
    const { args } = buildTurnInvocation(options({
      provider: 'Antigravity',
      projectRoots: [{ name: 'frontend', repo: 'acme/app-fe', dir: '/projects/app-fe' }]
    }), noMcp);
    expect(args).toContain('/projects/app-fe');
    expect(args.filter(arg => arg === '--add-dir')).toHaveLength(2);
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

  it('is a flag, not something the prompt could be mistaken for', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI' }), noMcp);
    expect(args).toContain('--ignore-user-config');
    expect(args).not.toContain('--');
  });

  it('keeps the read-only sandbox alongside it', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI' }), noMcp);
    expect(valueOf(args, '--sandbox')).toBe('read-only');
  });

  it('applies only the explicit local model catalog overrides before the model flag', () => {
    const { args } = buildTurnInvocation(options({
      provider: 'OpenAI',
      modelName: 'gpt-6-astra',
      codexConfigArgs: [
        '--config', 'openai_base_url="http://127.0.0.1:10100/v1"',
        '--config', 'model_catalog_json="C:\\\\Users\\\\Lloyd\\\\.codex\\\\opencodex-catalog.json"'
      ]
    }), noMcp);
    const ignoredConfig = args.indexOf('--ignore-user-config');
    const baseUrl = args.indexOf('openai_base_url="http://127.0.0.1:10100/v1"');
    const modelCatalog = args.indexOf('model_catalog_json="C:\\\\Users\\\\Lloyd\\\\.codex\\\\opencodex-catalog.json"');
    const model = args.indexOf('--model');

    expect(ignoredConfig).toBeGreaterThanOrEqual(0);
    expect(baseUrl).toBeGreaterThan(ignoredConfig);
    expect(modelCatalog).toBeGreaterThan(baseUrl);
    expect(model).toBeGreaterThan(modelCatalog);
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

describe('run mode — Alpha doing the work, not discussing it', () => {
  const run = (over: Partial<CliTurnOptions> = {}) =>
    buildTurnInvocation(options({ mode: 'run', ...over }), noMcp);

  it('lets Claude apply edits instead of denying the write tools', () => {
    const { args } = run();

    expect(valueOf(args, '--permission-mode')).toBe('acceptEdits');
    expect(args).not.toContain('--disallowedTools');
    expect(args).not.toContain('--allowedTools');
  });

  it('caps the turns so a run cannot loop forever', () => {
    expect(Number(valueOf(run().args, '--max-turns'))).toBeGreaterThan(0);
  });

  it('still isolates from the operator\'s own Claude settings', () => {
    // The whole reason for sharing this builder: the run path had none of this.
    const { args } = run();
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('still passes the agent\'s model', () => {
    expect(valueOf(run({ modelName: 'claude-opus-5' }).args, '--model')).toBe('claude-opus-5');
  });

  it('still carries the composed persona', () => {
    expect(valueOf(run().args, '--append-system-prompt')).toBe('You are Ada.');
  });

  it('uses Codex automatic review for a writable run when the CLI supports it', () => {
    const { args } = run({ provider: 'OpenAI', codexApproveForMe: true });
    expect(args).toContain('--approve-for-me');
    expect(args).not.toContain('--sandbox');
  });

  it('gives an older Codex the workspace-write sandbox with approvals off instead of a flag it rejects', () => {
    const { args } = run({ provider: 'OpenAI' });
    expect(args).not.toContain('--approve-for-me');
    expect(valueOf(args, '--sandbox')).toBe('workspace-write');
    expect(valueOf(args, '--config')).toBe('approval_policy="never"');
  });

  it('chooses a Windows sandbox when Codex is given workspace-write, or it stays read-only', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const configs = (args: string[]) => args.filter((_, index) => args[index - 1] === '--config');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(configs(run({ provider: 'OpenAI' }).args)).toContain('windows.sandbox="unelevated"');
      expect(configs(run({ provider: 'OpenAI', codexApproveForMe: true }).args)).not.toContain('windows.sandbox="unelevated"');
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(configs(run({ provider: 'OpenAI' }).args)).not.toContain('windows.sandbox="unelevated"');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('lets a Codex build run reach the network so dependency installs work, unless turned off', () => {
    const configs = (args: string[]) => args.filter((_, index) => args[index - 1] === '--config');
    expect(configs(run({ provider: 'OpenAI' }).args)).toContain('sandbox_workspace_write.network_access=true');
    expect(configs(run({ provider: 'OpenAI', codexApproveForMe: true }).args)).toContain('sandbox_workspace_write.network_access=true');
    // npm's default cache is outside the sandbox; runs get a writable Alpha-owned one.
    const invocation = run({ provider: 'OpenAI' });
    const cacheDir = valueOf(invocation.args, '--add-dir');
    expect(cacheDir).toMatch(/cache[\\/]packages$/);
    expect(invocation.env.npm_config_cache?.startsWith(cacheDir!)).toBe(true);
    // Install scripts cannot start child processes inside the Windows sandbox.
    expect(invocation.env.npm_config_ignore_scripts).toBe('true');
    // A chat keeps its own boundary: no network grant there.
    expect(configs(buildTurnInvocation(options({ mode: 'chat', provider: 'OpenAI' }), noMcp).args)).not.toContain('sandbox_workspace_write.network_access=true');
    process.env.ALPHA_RUN_NETWORK_ACCESS = 'off';
    try {
      expect(configs(run({ provider: 'OpenAI' }).args)).not.toContain('sandbox_workspace_write.network_access=true');
    } finally {
      delete process.env.ALPHA_RUN_NETWORK_ACCESS;
    }
  });

  it('still ignores the operator\'s codex config on a run', () => {
    expect(run({ provider: 'OpenAI' }).args).toContain('--ignore-user-config');
  });

  it('gives Antigravity the workspace, or its writes go to a scratch dir', () => {
    // Measured: without --add-dir, agy writes land in its own scratch
    // directory, so a run would report success having changed nothing.
    const { args } = run({ provider: 'Antigravity', cwd: '/workspaces/repo' });
    expect(valueOf(args, '--add-dir')).toBe('/workspaces/repo');
  });

  it('still isolates Antigravity from ~/.gemini on a run', () => {
    expect(run({ provider: 'Antigravity' }).env.HOME).toBeTruthy();
  });

  it('lets Antigravity actually run commands, or it cannot test anything', () => {
    // agy has no granular permission flag. Headless mode auto-denies the
    // "command" permission, so run_command fails and the turn dies with no
    // output — which ends every run whose plan includes running the tests.
    expect(run({ provider: 'Antigravity' }).args).toContain('--dangerously-skip-permissions');
  });

  it('routes Antigravity to the right binary and parser', () => {
    // Previously `isCodex ? 'codex' : 'claude'`, so an Antigravity agent ran as
    // Claude with no model and its stream parsed by the wrong dialect.
    const { family, bin } = run({ provider: 'Antigravity' });
    expect(family).toBe('antigravity');
    expect(bin).toBe('/opt/antigravity/agy');
  });
});

describe('chat mode is unchanged by run mode existing', () => {
  it('still denies the write tools when no mode is given', () => {
    const { args } = buildTurnInvocation(options(), noMcp);
    expect(args).toContain('--disallowedTools');
    expect(args).not.toContain('--permission-mode');
  });

  it('still denies them when chat is explicit', () => {
    const { args } = buildTurnInvocation(options({ mode: 'chat' }), noMcp);
    expect(args).toContain('--disallowedTools');
    expect(args).not.toContain('--add-dir');
  });

  it('keeps codex read-only in chat', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI', mode: 'chat' }), noMcp);
    expect(valueOf(args, '--sandbox')).toBe('read-only');
  });

  /**
   * The permission flag is scoped to runs, and these are the assertions that
   * keep it there. A run has a branch, a diff and a review gate; a chat has
   * none of the three, so it must never auto-approve a tool.
   */
  it.each(['Anthropic', 'OpenAI', 'Antigravity', 'Google Gemini'] as const)(
    'never auto-approves tool permissions in a %s chat',
    provider => {
      for (const mode of [undefined, 'chat'] as const) {
        const { args } = buildTurnInvocation(options({ provider, mode }), noMcp);
        expect(args).not.toContain('--dangerously-skip-permissions');
      }
    }
  );

  /**
   * Visibility is not capability, and the two flags are no longer bundled.
   *
   * `--add-dir` tells agy which directory is its workspace; without it a chat
   * turn cannot read the directory it is standing in, which is how asking an
   * agent to review a repository produced "status CANCELED" having read
   * nothing. `--dangerously-skip-permissions` is the one that auto-approves
   * tools, and it stays run-only.
   */
  it.each(['Antigravity', 'Google Gemini'] as const)(
    'gives a %s chat its workspace but not permission to act in it',
    provider => {
      const { args } = buildTurnInvocation(options({ provider, mode: 'chat' }), noMcp);
      expect(valueOf(args, '--add-dir')).toBe('/workspaces');
      expect(args).not.toContain('--dangerously-skip-permissions');
    }
  );

  /** Only the agy family is pointed at its work this way; the others locate it by cwd alone. */
  it.each(['Anthropic', 'OpenAI'] as const)('passes no workspace --add-dir to %s', provider => {
    for (const mode of [undefined, 'chat', 'run'] as const) {
      const { args } = buildTurnInvocation(options({ provider, mode }), noMcp);
      // A Codex build run's one extra writable folder is the shared package cache, never a workspace.
      const extra = args.filter((_, index) => args[index - 1] === '--add-dir');
      expect(extra.every(dir => /cache[\\/]packages$/.test(dir))).toBe(true);
      expect(extra.length).toBe(provider === 'OpenAI' && mode === 'run' ? 1 : 0);
    }
  });

  it('does not give the flag to families that take no such flag', () => {
    // Only agy needs it; Claude has --permission-mode and codex has --sandbox.
    for (const provider of ['Anthropic', 'OpenAI'] as const) {
      const { args } = buildTurnInvocation(options({ provider, mode: 'run' }), noMcp);
      expect(args).not.toContain('--dangerously-skip-permissions');
    }
  });
});

describe('orchestration review mode is read-only', () => {
  it('does not restore the agents write or shell skills for Claude', () => {
    const { args } = buildTurnInvocation(options({ mode: 'review', skills: ['sk-fs', 'sk-bash'] }), noMcp);
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Write');
    expect(args).toContain('Edit');
    expect(args).toContain('Bash');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('uses Codex read-only sandbox mode instead of run approval', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI', mode: 'review' }), noMcp);
    expect(valueOf(args, '--sandbox')).toBe('read-only');
    expect(args).not.toContain('--approve-for-me');
    expect(valueOf(args, '--config')).toBe('approval_policy="never"');
  });

  it('does not change Codex approval policy for ordinary chat turns', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI', mode: 'chat' }), noMcp);
    expect(args).not.toContain('--config');
  });

  it('does not auto-approve Antigravity tools during review', () => {
    const { args } = buildTurnInvocation(options({ provider: 'Antigravity', mode: 'review' }), noMcp);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

/**
 * The allowlist a run needs, which it never had.
 *
 * `--permission-mode acceptEdits` covers edits; MCP tools still ask, and a
 * headless run has no one to ask. So every MCP call an agent made during a run
 * stopped and waited — measured in the field as `alpha` 4, `agent` 0 in
 * remote_actions after the feature had shipped and appeared to work. It looked
 * like it worked because Alpha's own pipeline pushes and opens the pull request
 * immediately afterwards, under actor 'alpha'.
 */
describe('a run may actually call the MCP tools it was granted', () => {
  const run = (over: Partial<CliTurnOptions> = {}) =>
    options({ mode: 'run', ...over });

  it('allowlists the granted servers', () => {
    const { args } = buildTurnInvocation(run(), {
      configPath: '/runs/r1/mcp.json',
      serverNames: ['alpha-github']
    });

    expect(args).toContain('--allowedTools');
    expect(args).toContain('mcp__alpha-github');
  });

  it('still takes acceptEdits, so file edits do not prompt either', () => {
    const { args } = buildTurnInvocation(run(), {
      configPath: '/runs/r1/mcp.json',
      serverNames: ['alpha-github']
    });

    expect(valueOf(args, '--permission-mode')).toBe('acceptEdits');
  });

  /**
   * An empty `--allowedTools` is not the same as no `--allowedTools`: the first
   * is an exhaustive list of nothing, which would deny the file tools a run
   * exists to use.
   */
  it('omits the flag when no server was granted', () => {
    const { args } = buildTurnInvocation(run(), noMcp);
    expect(args).not.toContain('--allowedTools');
  });

  it('does not borrow the chat denylist', () => {
    const { args } = buildTurnInvocation(run(), noMcp);
    // A run edits files; denying Write and Edit would make it pointless.
    expect(args).not.toContain('--disallowedTools');
  });
});

/**
 * Skills decide what a chat turn may do.
 *
 * The behaviour these pin down is the one the operator asked for and the one
 * most easily lost: an agent holding `sk-fs` edits real files from the sidebar.
 * The argv is where that is granted, so the argv is where it is asserted —
 * `chatToolsFor` has its own unit tests, but nothing else proves the runner
 * actually passes what it computed.
 */
describe('chat capability from skills', () => {
  /** Tools between --allowedTools and the next flag. */
  const allowedIn = (args: string[]) =>
    args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));

  const deniedIn = (args: string[]) =>
    args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--setting-sources'));

  it('gives an agent granted nothing exactly what chat had before', () => {
    const { args } = buildTurnInvocation(options({ skills: [] }), noMcp);

    expect(allowedIn(args)).toEqual(['Read', 'Glob', 'Grep']);
    expect(deniedIn(args)).toContain('Write');
    expect(deniedIn(args)).toContain('Bash');
  });

  it('treats an agent with no skills field as granted nothing', () => {
    // Every caller not yet taught to pass them keeps the old behaviour rather
    // than silently gaining write.
    const { args } = buildTurnInvocation(options(), noMcp);
    expect(allowedIn(args)).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('lets an agent granted sk-fs edit files', () => {
    const { args } = buildTurnInvocation(options({ skills: ['sk-fs'] }), noMcp);

    expect(allowedIn(args)).toContain('Write');
    expect(allowedIn(args)).toContain('Edit');
    expect(deniedIn(args)).not.toContain('Write');
    // The shell is a separate grant and was not made.
    expect(deniedIn(args)).toContain('Bash');
  });

  it('lets an agent granted sk-bash run commands', () => {
    const { args } = buildTurnInvocation(options({ skills: ['sk-bash'] }), noMcp);

    expect(allowedIn(args)).toContain('Bash');
    expect(deniedIn(args)).toContain('Write');
  });

  it('still denies what was not granted, so the CLI refuses instead of prompting', () => {
    // An ungranted tool absent from BOTH lists is refused by prompting, and a
    // headless process has no TTY to answer — the turn hangs rather than fails.
    const { args } = buildTurnInvocation(options({ skills: ['sk-fs'] }), noMcp);
    expect(deniedIn(args)).toContain('NotebookEdit');
  });

  it('keeps custom CLI args from granting a tool the skills did not', () => {
    const { args } = buildTurnInvocation(
      options({ skills: ['sk-fs'], customCliArgs: '--allowedTools Bash' }),
      noMcp
    );

    expect(allowedIn(args)).not.toContain('Bash');
    expect(deniedIn(args)).toContain('Bash');
  });
});

describe('chat capability reaching the other CLI families', () => {
  it('keeps the codex sandbox read-only for an agent granted nothing', () => {
    const { args } = buildTurnInvocation(
      options({ provider: 'OpenAI', skills: [] }),
      noMcp
    );
    expect(valueOf(args, '--sandbox')).toBe('read-only');
  });

  it('opens the codex sandbox for an agent granted sk-fs', () => {
    // codex enforces this itself, rather than a prompt asking nicely.
    const { args } = buildTurnInvocation(
      options({ provider: 'OpenAI', skills: ['sk-fs'] }),
      noMcp
    );
    expect(valueOf(args, '--sandbox')).toBe('workspace-write');
  });

  it('withholds the agy permission flag from an agent granted nothing', () => {
    const { args } = buildTurnInvocation(
      options({ provider: 'Antigravity', skills: [] }),
      noMcp
    );
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('gives agy the permission flag once a write skill is granted', () => {
    // agy auto-denies in headless mode, so without this the turn dies producing
    // nothing rather than making the edit it was just told it could make.
    const { args } = buildTurnInvocation(
      options({ provider: 'Antigravity', skills: ['sk-fs'] }),
      noMcp
    );
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('still gives agy the workspace either way', () => {
    // --add-dir is visibility, not capability: without it a chat turn cannot
    // read the directory it is standing in.
    for (const skills of [[], ['sk-fs']]) {
      const { args } = buildTurnInvocation(
        options({ provider: 'Antigravity', skills }),
        noMcp
      );
      expect(args).toContain('--add-dir');
    }
  });
});

describe('a chat that reads the project only through alpha-project-files', () => {
  const files = { configPath: '/runs/chat-1/mcp.json', serverNames: ['alpha-github', 'alpha-project-files'] };
  const roots = [{ name: 'app-be', repo: 'acme/app-be', dir: '/code/app-be' }];
  const allowedIn = (args: string[]) => args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  const deniedIn = (args: string[]) => args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--setting-sources'));

  it('switches Codex\'s own shell off, since its read-only sandbox reads anywhere', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI', modelName: 'gpt-6-astra', projectRoots: roots }), files);
    expect(args).toContain('features.shell_tool=false');
    expect(valueOf(args, '--sandbox')).toBe('read-only');
  });

  it('takes Read, Glob and Grep from Claude and leaves only the MCP tools', () => {
    const { args } = buildTurnInvocation(options({ projectRoots: roots }), files);
    expect(allowedIn(args)).toEqual(['mcp__alpha-github', 'mcp__alpha-project-files']);
    expect(deniedIn(args)).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'Bash', 'Write']));
  });

  it('also applies with no repository on this computer: no local files at all', () => {
    const { args } = buildTurnInvocation(options({ provider: 'OpenAI', projectRoots: [] }), noMcp);
    expect(args).toContain('features.shell_tool=false');
  });

  it('leaves chats without project roots, agents granted a shell, and runs as they were', () => {
    expect(buildTurnInvocation(options({ provider: 'OpenAI' }), files).args).not.toContain('features.shell_tool=false');
    expect(buildTurnInvocation(options({ provider: 'OpenAI', skills: ['sk-bash'], projectRoots: roots }), files).args)
      .not.toContain('features.shell_tool=false');
    expect(buildTurnInvocation(options({ provider: 'OpenAI', mode: 'run', projectRoots: roots }), files).args)
      .not.toContain('features.shell_tool=false');
    expect(allowedIn(buildTurnInvocation(options(), noMcp).args)).toEqual(['Read', 'Glob', 'Grep']);
  });
});

