import { describe, expect, it } from 'vitest';
import { describeProjectBuild } from './chatBuildContext.js';

describe('the build the chat agent is told about', () => {
  it('gives the status, the reason it stopped, what each agent did and the open findings', () => {
    const text = describeProjectBuild({
      run: { plan: { goal: 'Informational shop with login' }, status: 'blocked', stoppedReason: 'Every final check passed, but 1 blocking review finding is still open.' },
      tasks: [{ id: 't1', title: 'Build the login API', ownerAgentId: 'backend', status: 'accepted' }],
      attempts: [{ taskId: 't1', status: 'accepted', result: { summary: 'Added /api/auth/login with tests.' } }],
      findings: [{ status: 'open', severity: 'warning', evidence: { title: 'No login rate limit' }, path: 'src/routes/auth.ts' }]
    } as any, id => (id === 'backend' ? 'Backend Agent' : id))!;
    expect(text).toContain('Status: stopped and waiting for the person');
    expect(text).toContain('Why it stopped: Every final check passed');
    expect(text).toContain('Task "Build the login API" by Backend Agent: accepted — Added /api/auth/login with tests.');
    expect(text).toContain('Open warning finding: No login rate limit (src/routes/auth.ts)');
  });

  it('says nothing when the project has no build', () => {
    expect(describeProjectBuild(undefined, id => id)).toBeUndefined();
  });

  it('does not expose another conversation\'s build, even when passed a snapshot directly', () => {
    const snapshot = {
      run: { originChatThreadId: 'thread-a', plan: { goal: 'Private build A' }, status: 'executing' },
      tasks: [], attempts: [], findings: []
    } as any;
    expect(describeProjectBuild(snapshot, id => id, 'thread-b')).toBeUndefined();
    expect(describeProjectBuild(snapshot, id => id, 'thread-a')).toContain('Private build A');
  });
});

