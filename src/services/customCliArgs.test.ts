import { describe, it, expect } from 'vitest';
import { parseCustomCliArgs, tokenize, buildEnv } from './customCliArgs.js';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('--foo --bar')).toEqual(['--foo', '--bar']);
  });

  it('keeps a quoted value as one token', () => {
    expect(tokenize('--foo "some value"')).toEqual(['--foo', 'some value']);
  });

  it('handles single quotes', () => {
    expect(tokenize("--foo 'some value'")).toEqual(['--foo', 'some value']);
  });

  it('keeps an empty quoted string as a token', () => {
    expect(tokenize('--foo ""')).toEqual(['--foo', '']);
  });

  it('collapses runs of whitespace', () => {
    expect(tokenize('  --foo    --bar  ')).toEqual(['--foo', '--bar']);
  });

  it('returns nothing for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('parseCustomCliArgs — what it keeps', () => {
  it('keeps a flag the runner does not own', () => {
    expect(parseCustomCliArgs('--debug').args).toEqual(['--debug']);
  });

  it('keeps a flag and its separate value', () => {
    expect(parseCustomCliArgs('--fallback-model haiku').args).toEqual([
      '--fallback-model',
      'haiku'
    ]);
  });

  it('keeps an inline value', () => {
    expect(parseCustomCliArgs('--fallback-model=haiku').args).toEqual(['--fallback-model=haiku']);
  });

  it('does not treat the next flag as a value', () => {
    expect(parseCustomCliArgs('--debug --verbose-errors').args).toEqual([
      '--debug',
      '--verbose-errors'
    ]);
  });

  it('returns nothing for undefined or empty', () => {
    expect(parseCustomCliArgs(undefined)).toEqual({ args: [], rejected: [] });
    expect(parseCustomCliArgs('   ')).toEqual({ args: [], rejected: [] });
  });
});

describe('parseCustomCliArgs — what it refuses', () => {
  it.each([
    '--dangerously-skip-permissions',
    '--allowedTools',
    '--disallowed-tools',
    '--permission-mode',
    '--add-dir',
    '--sandbox',
    '--approve-for-me',
    '--setting-sources',
    '--mcp-config',
    '--strict-mcp-config',
    '--system-prompt',
    '--append-system-prompt',
    '--output-format',
    '--model',
    '-m',
    '--resume',
    '-r',
    '--conversation',
    '-p',
    '--print',
    '--'
  ])('refuses %s because the runner sets it', flag => {
    const { args, rejected } = parseCustomCliArgs(flag);
    expect(args).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it('matches a reserved flag regardless of case', () => {
    expect(parseCustomCliArgs('--AllowedTools Bash').args).toEqual([]);
  });

  it('swallows the value of a refused flag rather than leaving it stray', () => {
    // Left behind, `Bash` would land as a positional argument — for `claude -p`
    // that is a second prompt.
    expect(parseCustomCliArgs('--allowedTools Bash').args).toEqual([]);
  });

  it('swallows an inline value on a refused flag', () => {
    expect(parseCustomCliArgs('--model=gpt-4 --debug').args).toEqual(['--debug']);
  });

  it('refuses a bare positional argument', () => {
    const { args, rejected } = parseCustomCliArgs('rm -rf /');
    expect(args).not.toContain('rm');
    expect(rejected[0]).toContain('positional');
  });

  it('refuses control characters', () => {
    const { args, rejected } = parseCustomCliArgs(`--foo${String.fromCharCode(0)}bar`);
    expect(args).toEqual([]);
    expect(rejected[0]).toContain('control characters');
  });

  it('keeps the safe flags from a mixed string and reports the rest', () => {
    const { args, rejected } = parseCustomCliArgs(
      '--debug --dangerously-skip-permissions --fallback-model haiku'
    );

    expect(args).toEqual(['--debug', '--fallback-model', 'haiku']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('--dangerously-skip-permissions');
  });

  it('says why each flag was refused', () => {
    expect(parseCustomCliArgs('--model x').rejected[0]).toContain('set by Alpha');
  });

  it('does not let shell metacharacters through as a separate command', () => {
    // cross-spawn runs with no shell, so these are literal argument text; the
    // point is only that they arrive as one refused positional, not as argv.
    const { args } = parseCustomCliArgs('; rm -rf / && curl evil.test');
    expect(args).not.toContain(';');
    expect(args).not.toContain('rm');
    expect(args).not.toContain('curl');
  });
});

describe('buildEnv', () => {
  it('returns an empty environment for no vars', () => {
    expect(buildEnv(undefined)).toEqual({ env: {}, rejected: [] });
    expect(buildEnv([])).toEqual({ env: {}, rejected: [] });
  });

  it('keeps a valid key', () => {
    expect(buildEnv([{ key: 'API_KEY', value: 'secret' }]).env).toEqual({ API_KEY: 'secret' });
  });

  it('allows a leading underscore and digits after the first character', () => {
    expect(buildEnv([{ key: '_MY_VAR2', value: 'x' }]).env).toEqual({ _MY_VAR2: 'x' });
  });

  it('trims surrounding whitespace from the key', () => {
    expect(buildEnv([{ key: '  API_KEY  ', value: 'x' }]).env).toEqual({ API_KEY: 'x' });
  });

  it.each(['2FA', 'has space', 'has=equals', 'has-dash', ''])(
    'refuses the invalid key %j',
    key => {
      const { env, rejected } = buildEnv([{ key, value: 'x' }]);
      expect(env).toEqual({});
      expect(rejected).toHaveLength(1);
    }
  );

  it('never puts the value in a rejection message', () => {
    const { rejected } = buildEnv([{ key: 'bad key', value: 'super-secret-token' }]);
    expect(rejected.join(' ')).not.toContain('super-secret-token');
  });

  it('keeps the valid entries alongside the refused ones', () => {
    const { env, rejected } = buildEnv([
      { key: 'GOOD', value: '1' },
      { key: 'bad key', value: '2' }
    ]);

    expect(env).toEqual({ GOOD: '1' });
    expect(rejected).toHaveLength(1);
  });

  it('coerces a missing value to an empty string rather than dropping the key', () => {
    expect(buildEnv([{ key: 'EMPTY' } as any]).env).toEqual({ EMPTY: '' });
  });
});
