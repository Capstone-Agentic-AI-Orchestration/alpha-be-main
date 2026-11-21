import { describe, expect, it } from 'vitest';
import type { Issue } from '../models/index.js';
import { boardCardSpec, selectBoardCards } from './boardCardBuild.js';

const card = (identifier: string, extra: Partial<Issue> = {}): Issue => ({
  id: `id-${identifier}`, identifier, title: `${identifier} title`, description: '', status: 'backlog', priority: 'high',
  projectId: 'p', labels: [], subtasks: [], createdAt: '', updatedAt: '', ...extra
} as Issue);

const board = [
  card('PRO-101', { archivedAt: '2026-11-19', status: 'todo' }),
  card('PRO-102', { archivedAt: '2026-11-19' }),
  card('PRO-103', { subtasks: [{ id: 's1', title: 'Define Expense type', completed: false }, { id: 's2', title: 'Done already', completed: true }] }),
  card('PRO-104', { dependsOnIssueIds: ['id-PRO-106'] }),
  card('PRO-105', { status: 'done' }),
  card('PRO-106'),
  card('PRO-108', { labels: ['alpha:chat-build'], status: 'todo' })
];

describe('board cards named in a chat build request', () => {
  it('builds every open card for "do all the tasks", leaving out archived, finished, and build-record cards', () => {
    const { cards } = selectBoardCards('do all the task first plan on it', board);
    expect(cards.map(item => item.identifier)).toEqual(['PRO-103', 'PRO-106', 'PRO-104']);
  });

  it('builds only the named cards and reports the archived ones it left out', () => {
    const selection = selectBoardCards('Resolve the overlap between PRO-102 and PRO-103, then build PRO-105.', board);
    expect(selection.cards.map(item => item.identifier)).toEqual(['PRO-103', 'PRO-105']);
    expect(selection.archived).toEqual(['PRO-102']);
  });

  it('leaves ordinary requests alone, including a page called "all tasks"', () => {
    expect(selectBoardCards('Fix the layout of the all tasks page', board).cards).toEqual([]);
    expect(selectBoardCards('Add a dark mode toggle', board).cards).toEqual([]);
  });

  it('turns open checklist items into requirements, and a card without a checklist into one requirement', () => {
    const spec = boardCardSpec([board[2], board[5]], () => undefined);
    expect(spec.requirements.map(item => item.description)).toEqual(['PRO-103 title: Define Expense type', 'PRO-106 title: PRO-106 title']);
    expect(spec.requirements[1].id).toMatch(/^CARD-/);
    expect(spec.brief).toContain('1. PRO-103 title (priority: high)');
    expect(spec.brief).toContain('follow these tasks');
  });
});

describe('cards chosen by the chat router', () => {
  it('builds every open task for ["all"], whatever the request text says', () => {
    expect(selectBoardCards('I want you to start will the task, do it per phase', board, ['all']).cards.map(item => item.identifier))
      .toEqual(['PRO-103', 'PRO-106', 'PRO-104']);
  });

  it('builds the chosen keys and ignores keys in the text', () => {
    expect(selectBoardCards('build PRO-105 too', board, ['PRO-106']).cards.map(item => item.identifier)).toEqual(['PRO-106']);
  });

  it('falls back to the request text when the router chose nothing', () => {
    expect(selectBoardCards('build PRO-105', board, []).cards.map(item => item.identifier)).toEqual(['PRO-105']);
  });
});

describe('a request that names one of Alpha\'s own build cards', () => {
  it('builds the open tasks that build covered instead of nothing', () => {
    const record = card('PRO-108', { labels: ['alpha:chat-build'], status: 'todo', title: 'Build: Complete the remaining Project A expense workflow tasks',
      description: 'Original request:\nComplete the remaining Project A expense workflow tasks in dependency order.' });
    const { cards } = selectBoardCards('Build PRO-108, Complete the remaining expense workflow, phase by phase.', [...board.filter(item => item.identifier !== 'PRO-108'), record]);
    expect(cards.map(item => item.identifier)).toEqual(['PRO-103', 'PRO-106', 'PRO-104']);
  });

  it('builds the tasks a build card lists', () => {
    const record = card('PRO-110', { labels: ['alpha:chat-build'], description: 'Original request:\nBuild it\n\nBoard tasks: PRO-103, PRO-106' });
    expect(selectBoardCards('continue PRO-110', [...board, record]).cards.map(item => item.identifier)).toEqual(['PRO-103', 'PRO-106']);
  });
});
