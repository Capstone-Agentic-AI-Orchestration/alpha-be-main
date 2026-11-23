import { describe, expect, it } from 'vitest';
import type { Issue } from '../models/index.js';
import type { FeatureSpecRecord } from './featureSpecContract.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import {
  MAX_PRODUCT_PICTURE_CHARS, productPictureFor, projectBrief, renderProductPicture, teamProductPicture, type ProductPictureSource
} from './productPicture.js';
import { composeProjectContext } from './projectPlaybook.js';

const project = {
  id: 'proj-a',
  name: 'Project A',
  description: 'I want project a to be a informational website\n\nFrom the conversation with the client:\nQ: What else do you need\nA: nothing'
};

function card(identifier: string, title: string, status: Issue['status'], extra: Partial<Issue> = {}): Issue {
  return {
    id: `issue-${identifier}`, identifier, title, description: '', status, priority: 'medium', projectId: project.id,
    labels: [], createdAt: '2026-11-20T00:00:00.000Z', ...extra
  } as unknown as Issue;
}

const issues: Issue[] = [
  card('PRO-103', 'Add, edit, and delete expenses', 'backlog', { description: 'Users can create, update, and remove expenses.' }),
  card('PRO-101', 'Landing Page', 'todo'),
  card('PRO-100', 'Project scaffold', 'done'),
  card('PRO-099', 'Old idea', 'backlog', { archivedAt: '2026-11-19T00:00:00.000Z' }),
  card('PRO-110', 'Build: Keep Project A informational.', 'todo', {
    labels: ['alpha:chat-build'], createdAt: '2026-11-21T00:00:00.000Z',
    description: 'Build requested from project chat using the task-driven orchestrator.\n\nOriginal request: Keep Project A informational. Reconcile the expense workflow tasks PRO-102 through PRO-106 with that direction.'
  })
];

function build(goal: string, status: string, extra: Record<string, unknown> = {}): OrchestrationSnapshot {
  return {
    run: { status, plan: { goal, decisions: [] } }, tasks: [], attempts: [], ...extra
  } as unknown as OrchestrationSnapshot;
}

const snapshots: OrchestrationSnapshot[] = [
  build('Complete the expense workflow tasks', 'blocked', {
    run: { status: 'blocked', plan: { goal: 'Complete the expense workflow tasks', decisions: [{ about: 'Scope', decision: 'Expense tracking stays out until the owner decides.' }] } },
    attempts: [{ status: 'rejected', failureReason: 'The specialist reported a blocker: The project owner must decide whether Project A remains informational or includes an expense workflow.' }]
  }),
  build('Redesign everything', 'cancelled', { tasks: [{ status: 'accepted', title: 'Cancelled work' }] }),
  build('Build the landing page shell', 'completed', { tasks: [{ status: 'accepted', title: 'Page layout and hero' }, { status: 'pending', title: 'Not done' }] })
];

const specs: Record<string, FeatureSpecRecord> = {
  'issue-PRO-101': { status: 'approved', spec: { summary: 'A one-page site introducing the resort.' } } as unknown as FeatureSpecRecord
};

const source: ProductPictureSource = {
  issues: () => issues,
  snapshots: () => snapshots,
  approvedSpec: issueId => specs[issueId] ?? null
};

describe('product picture', () => {
  it('gives the team the brief, planned work, requests, builds, decisions and open questions', () => {
    const text = productPictureFor(project, 'team', source);
    expect(text).toContain('Brief (project description): I want project a to be a informational website');
    // Active and planned work first; archived cards and Alpha's own build records are not planned work.
    expect(text.indexOf('PRO-101 Landing Page')).toBeLessThan(text.indexOf('PRO-103 Add, edit, and delete expenses'));
    expect(text).toContain('PRO-101 Landing Page (approved spec: A one-page site introducing the resort.)');
    expect(text).not.toContain('Old idea');
    expect(text).toContain('Finished on the board:\n- PRO-100 Project scaffold');
    expect(text).toContain('Requests made in chat (newest first):\n- Keep Project A informational. Reconcile the expense workflow tasks');
    expect(text).toContain('Delivered builds:\n- Build the landing page shell Accepted so far: Page layout and hero.');
    expect(text).toContain('Builds in progress:\n- Complete the expense workflow tasks');
    expect(text).toContain('Scope: Expense tracking stays out until the owner decides.');
    expect(text).toContain('Open product questions (a specialist stopped on these):\n- The project owner must decide whether Project A remains informational');
    // A cancelled build delivered nothing.
    expect(text).not.toContain('Redesign everything');
    expect(text).not.toContain('Cancelled work');
  });

  it('gives a client the brief only, without reading any orchestration data', () => {
    const refusing: ProductPictureSource = {
      issues: () => { throw new Error('a client picture must not read the board'); },
      snapshots: () => { throw new Error('a client picture must not read builds'); },
      approvedSpec: () => { throw new Error('a client picture must not read specs'); }
    };
    const text = productPictureFor(project, 'client', refusing);
    expect(text).toBe('## About Project A\n\nBrief (project description): I want project a to be a informational website From the conversation with the client: Q: What else do you need A: nothing');
    for (const word of ['build', 'Build', 'plan', 'agent', 'blocker', 'specialist', 'decision', 'PRO-', 'approval']) {
      expect(text).not.toContain(word);
    }
  });

  it('stays within its size bound and says when there is no brief', () => {
    const many = Array.from({ length: 60 }, (_, index) => card(`PRO-${200 + index}`, `Card ${index} ${'x'.repeat(150)}`, 'todo', { description: 'y'.repeat(400) }));
    const text = renderProductPicture(teamProductPicture({ project: { name: 'Big', description: 'z'.repeat(5_000) }, issues: many, snapshots: [] }));
    expect(text.length).toBeLessThanOrEqual(MAX_PRODUCT_PICTURE_CHARS);
    expect(renderProductPicture(teamProductPicture({ project: { name: 'Empty', description: '' }, issues: [], snapshots: [] })))
      .toContain('Brief: none recorded yet.');
  });

  it('is where build planning reads the brief too', () => {
    expect(projectBrief('  Informational site  ')).toBe('Informational site');
    expect(projectBrief('   ')).toBeUndefined();
    expect(composeProjectContext({ description: project.description, repositories: [] })).toBe(`Project: ${projectBrief(project.description)}`);
  });
});
