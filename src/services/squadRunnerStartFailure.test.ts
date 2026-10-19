import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('SquadRunner first-agent startup failure', () => {
  let issue: any;
  let savedRuns: any[];
  let runnerService: EventEmitter & { startRun: ReturnType<typeof vi.fn> };
  let updateIssueAndPush: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    issue = { id: 'issue-build', identifier: 'ALPHA-1', projectId: 'project-1', status: 'todo' };
    savedRuns = [];
    runnerService = Object.assign(new EventEmitter(), {
      startRun: vi.fn().mockRejectedValue(new Error('runtime launch failed'))
    });
    updateIssueAndPush = vi.fn((_id: string, changes: Record<string, unknown>) => Object.assign(issue, changes));

    vi.doMock('./sqliteService.js', () => ({ sqliteService: {
      getSquads: () => [{ id: 'squad-1', name: 'Build squad', topology: 'Sequential', memberAgentIds: ['agent-1'] }],
      getIssues: () => [issue],
      getAgents: () => [{ id: 'agent-1', name: 'Builder', isArchived: false }],
      updateIssue: (_id: string, changes: Record<string, unknown>) => Object.assign(issue, changes),
      saveSquadRun: (run: unknown) => savedRuns.push(structuredClone(run)),
      getSquadRun: (id: string) => structuredClone(savedRuns.find(run => run.id === id))
    } }));
    vi.doMock('./runnerService.js', () => ({ runnerService }));
    vi.doMock('./runUsage.js', () => ({ totalTokens: () => 0 }));
    vi.doMock('../utils/logger.js', () => ({ logInfo: vi.fn(), logError: vi.fn() }));
    vi.doMock('./boardWriteThrough.js', () => ({ addCommentAndShare: vi.fn(), updateIssueAndPush }));
    vi.doMock('./githubRepoWorkspace.js', () => ({ agentBranchName: () => 'alpha/build-alpha-1' }));
    vi.doMock('./workspaceContext.js', () => ({
      currentWorkspaceId: () => 'workspace-1',
      runWithWorkspace: (_workspaceId: string, operation: () => unknown) => operation()
    }));
    vi.doMock('./workspaceRegistry.js', () => ({ workspaceRegistry: { bind: vi.fn() } }));
  });

  afterEach(() => {
    vi.doUnmock('./sqliteService.js');
    vi.doUnmock('./runnerService.js');
    vi.doUnmock('./runUsage.js');
    vi.doUnmock('../utils/logger.js');
    vi.doUnmock('./boardWriteThrough.js');
    vi.doUnmock('./githubRepoWorkspace.js');
    vi.doUnmock('./workspaceContext.js');
    vi.doUnmock('./workspaceRegistry.js');
    vi.resetModules();
  });

  it('keeps specialist roles scoped when personas mention other teammates', async () => {
    const { defaultMemberAssignment } = await import('./squadRunner.js');
    for (const [role, phase] of [
      ['Backend Agent', 'implementation'], ['Frontend Agent', 'implementation'],
      ['Database Agent', 'database'], ['Reviewer', 'review'],
      ['QA Tester', 'validation'], ['DevOps', 'delivery']
    ]) {
      const assignment = defaultMemberAssignment({
        id: 'specialist', role, name: 'Specialist', description: 'Coordinate with the research and architecture team',
        systemPrompt: 'Read requirements from the researcher and architect. Implement only your own specialty.'
      } as any, 1, 6);
      expect(assignment.phase).toBe(phase);
      expect(assignment.stageLabel).not.toBe('Requirements and research');
    }
  });

  it('closes the squad and returns the issue to a retryable state', async () => {
    const { SquadRunner } = await import('./squadRunner.js');
    const runner = new SquadRunner();

    await expect(runner.startSquadRun({ squadId: 'squad-1', issueId: issue.id, workspaceId: 'workspace-1' }))
      .rejects.toThrow('runtime launch failed');

    expect(savedRuns.at(-1)).toMatchObject({
      issueId: issue.id,
      status: 'failed',
      stoppedReason: expect.stringContaining('runtime launch failed')
    });
    expect(issue.status).toBe('in_progress');
    expect(updateIssueAndPush).toHaveBeenCalledWith(issue.id, { status: 'in_progress' });
  });
});
