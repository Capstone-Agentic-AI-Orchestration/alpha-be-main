import { describe, expect, it } from 'vitest';
import { describeBoardTasks, describeProjectBuild } from './chatBuildContext.js';

describe('the board tasks the chat agent is told about', () => {
  it('gives each task\'s priority beside its column, so the agent can rank them', () => {
    const text = describeBoardTasks([
      { identifier: 'PRO-101', title: 'Landing Page', status: 'todo', priority: 'medium' },
      { identifier: 'PRO-102', title: 'Project setup and expense storage layer', status: 'backlog', priority: 'high' },
      { identifier: 'PRO-107', title: 'Untriaged idea', status: 'backlog' }
    ], id => id, { canSeeBuilds: true, scoped: false });

    expect(text).toContain('### PRO-101 · Landing Page (board column: todo · priority: medium)');
    expect(text).toContain('### PRO-102 · Project setup and expense storage layer (board column: backlog · priority: high)');
    expect(text).toContain('### PRO-107 · Untriaged idea (board column: backlog)');
  });
});

describe('board records for the Manager Agent', () => {
  it('include each card\'s description and checklist', () => {
    const text = describeBoardTasks([{ identifier: 'PRO-103', title: 'App scaffold', status: 'backlog', priority: 'high',
      description: 'The app scaffold builds cleanly.', checklist: [{ title: 'Define Expense type', completed: false }, { title: 'Set up Vite', completed: true }] },
    { identifier: 'PRO-106', title: 'Summary', status: 'backlog' }], id => id, { canSeeBuilds: true, scoped: false });
    expect(text).toContain('- Description: The app scaffold builds cleanly.');
    expect(text).toContain('  - [ ] Define Expense type');
    expect(text).toContain('  - [x] Set up Vite');
    expect(text).toContain('- Checklist: none');
  });
});

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

