import { describe, expect, it } from 'vitest';
import { buildTurnInvocation } from './cliRunner.js';
import { nativeTaskEditsEnabled } from './runnerService.js';

const noMcp = { configPath: null as string | null, serverNames: [] as string[] };

describe('native task edits (opt-in)', () => {
  it('is off unless ALPHA_NATIVE_TASK_EDITS=codex, and only for Codex', () => {
    expect(nativeTaskEditsEnabled('OpenAI', {})).toBe(false);
    expect(nativeTaskEditsEnabled('OpenAI', { ALPHA_NATIVE_TASK_EDITS: 'codex' })).toBe(true);
    expect(nativeTaskEditsEnabled('Anthropic', { ALPHA_NATIVE_TASK_EDITS: 'codex' })).toBe(false);
    expect(nativeTaskEditsEnabled('OpenAI', { ALPHA_NATIVE_TASK_EDITS: '1' })).toBe(false);
  });

  it('gives Codex a workspace-write sandbox on the task worktree only, without network', () => {
    const own = { name: 'shop-fe', repo: 'acme/shop-fe', dir: '/work/shop-fe' };
    const { args } = buildTurnInvocation({
      runId: 'run-1', cwd: own.dir, mode: 'chat', approvalMode: 'approve', projectRoots: [own],
      provider: 'OpenAI', modelName: 'gpt-5', systemPrompt: 'You are the Frontend Agent.', personaName: 'Frontend Agent',
      prompt: 'Build the cart page.', priorSession: null
    }, noMcp);

    expect(args.join(' ')).toContain('--sandbox workspace-write');
    expect(args.filter((arg, index) => args[index - 1] === '--add-dir' && arg !== own.dir && !/cache/i.test(arg))).toEqual([]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.join(' ')).not.toContain('network_access=true');
  });
});
