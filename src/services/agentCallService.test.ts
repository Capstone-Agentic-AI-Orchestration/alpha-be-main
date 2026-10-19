import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sqlite: { getActiveOrchestrationForProject: vi.fn() } }));
vi.mock('./sqliteService.js', () => ({ sqliteService: mocks.sqlite }));
vi.mock('./cliRunner.js', () => ({ runCliTurn: vi.fn() }));
vi.mock('./chatWriteThrough.js', () => ({ saveChatMessageAndShare: vi.fn() }));

import { AgentCallService } from './agentCallService.js';

describe('independent agent call scope', () => {
  const service = new AgentCallService() as any;
  it('blocks code calls while an orchestration owns the same repository', () => {
    mocks.sqlite.getActiveOrchestrationForProject.mockReturnValue({
      runId: 'orchestration-1', repository: 'acme/tasks', status: 'executing', branchName: 'alpha/orchestration/run-1'
    });

    expect(() => service.assertNoActiveOrchestration('workspace-1', 'project-1', 'acme/tasks'))
      .toThrow(/independent code call is paused.*executing.*acme\/tasks/);
    expect(mocks.sqlite.getActiveOrchestrationForProject).toHaveBeenCalledWith('project-1', 'acme/tasks');
  });

  it('allows independent code calls after the orchestration ownership ends', () => {
    mocks.sqlite.getActiveOrchestrationForProject.mockReturnValue(undefined);

    expect(() => service.assertNoActiveOrchestration('workspace-1', 'project-1', 'acme/tasks')).not.toThrow();
  });

  it.each(['ask', 'review', 'revise', 'implement'])('preserves persona boundaries in %s mode', operationMode => {
    const prompt = service.buildPrompt({ operationMode, instruction: 'Build the whole application' },
      { name: 'Portal', key: 'PORT', description: 'Use the existing API contract' },
      { name: 'API specialist', role: 'Backend Agent' });
    expect(prompt).toContain('Role: Backend Agent');
    expect(prompt).toContain('independent call to you alone');
    expect(prompt).toContain('When the request exceeds your role');
    expect(prompt).toContain('Use the existing API contract');
    expect(prompt).toContain(`Operation mode: ${operationMode.toUpperCase()}`);
    expect(prompt).toContain('Do not run shell commands');
    if (['revise', 'implement'].includes(operationMode)) expect(prompt).toContain('Do not apply it.');
  });
});
