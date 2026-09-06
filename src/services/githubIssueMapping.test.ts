import { describe, it, expect } from 'vitest';
import {
  parseRepoRef,
  statusFromIssue,
  priorityFromIssue,
  mapIssue,
  labelsForWrite,
  stateForStatus,
  isPullRequest,
  foreignLabels,
  GitHubIssue
} from './githubIssueMapping.js';

/**
 * Alpha's six columns against GitHub's two states.
 *
 * The board moves to GitHub so six collaborators can share it, which means
 * every column has to survive a round trip through an issue that only knows
 * open and closed. The extra state rides on labels; the cases below are the
 * ones where that mapping could quietly lose or invent work.
 */
const issue = (over: Partial<GitHubIssue> = {}): GitHubIssue => ({
  number: 14,
  title: 'Add a thing',
  body: 'Because it is missing.',
  state: 'open',
  labels: [],
  user: { login: 'ZaneZamoraC1Cs' },
  assignees: [],
  html_url: 'https://github.com/org/repo/issues/14',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  ...over
});

describe('parseRepoRef', () => {
  it('reads the forms a project might have recorded', () => {
    const expected = { owner: 'Capstone-Agentic-AI-Orchestration', repo: 'alpha-be-main' };
    for (const input of [
      'https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main',
      'https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main.git',
      'https://github.com/Capstone-Agentic-AI-Orchestration/alpha-be-main/',
      'git@github.com:Capstone-Agentic-AI-Orchestration/alpha-be-main.git',
      'Capstone-Agentic-AI-Orchestration/alpha-be-main'
    ]) {
      expect(parseRepoRef(input)).toEqual(expected);
    }
  });

  /** A local path is a working copy, not a repository reference. */
  it('refuses anything that is not a GitHub repository', () => {
    expect(parseRepoRef('C:\\Users\\Lloyd\\Documents\\alpha-be-main')).toBeNull();
    expect(parseRepoRef('https://gitlab.com/org/repo')).toBeNull();
    expect(parseRepoRef('')).toBeNull();
    expect(parseRepoRef(undefined)).toBeNull();
  });
});

describe('isPullRequest', () => {
  /**
   * GitHub's issues endpoint returns pull requests too.
   *
   * This organisation's repositories hold five pull requests and zero issues,
   * so without this the board's first sync would show five cards for work that
   * is already merged.
   */
  it('tells a pull request from an issue', () => {
    expect(isPullRequest(issue())).toBe(false);
    expect(isPullRequest(issue({ pull_request: { url: 'https://…' } }))).toBe(true);
  });
});

describe('statusFromIssue', () => {
  it('reads the column from an alpha label', () => {
    expect(statusFromIssue(issue({ labels: [{ name: 'alpha:in-progress' }] }))).toBe('in_progress');
    expect(statusFromIssue(issue({ labels: [{ name: 'alpha:review' }] }))).toBe('review');
    expect(statusFromIssue(issue({ labels: [{ name: 'alpha:backlog' }] }))).toBe('backlog');
  });

  it('puts an untriaged issue in Todo', () => {
    // How a teammate who never opens Alpha files one.
    expect(statusFromIssue(issue({ labels: [] }))).toBe('todo');
    expect(statusFromIssue(issue({ labels: [{ name: 'bug' }] }))).toBe('todo');
  });

  it('treats closed as done whatever the labels say', () => {
    expect(statusFromIssue(issue({ state: 'closed' }))).toBe('done');
    expect(statusFromIssue(issue({ state: 'closed', labels: [{ name: 'alpha:todo' }] }))).toBe('done');
  });

  /**
   * An issue closed and then reopened keeps whatever labels it had.
   *
   * Trusting `alpha:done` on an open issue would file live work in the Done
   * column, where nobody looks — the board would lose it silently.
   */
  it('never puts an open issue in Done', () => {
    expect(statusFromIssue(issue({ state: 'open', labels: [{ name: 'alpha:done' }] }))).toBe('todo');
  });

  it('accepts labels as plain strings', () => {
    // The REST shape varies by endpoint; both forms appear in the wild.
    expect(statusFromIssue(issue({ labels: ['alpha:review'] as any }))).toBe('review');
  });
});

describe('priorityFromIssue', () => {
  it('reads a priority label', () => {
    expect(priorityFromIssue(issue({ labels: [{ name: 'alpha:p-urgent' }] }))).toBe('urgent');
  });

  it('defaults to medium when nothing says', () => {
    expect(priorityFromIssue(issue())).toBe('medium');
  });
});

describe('mapIssue', () => {
  it('carries across the fields the board draws', () => {
    const mapped = mapIssue(
      issue({ labels: [{ name: 'alpha:review' }, { name: 'bug' }], assignees: [{ login: 'Lloyd1020' }] }),
      'org/repo'
    );

    expect(mapped).toMatchObject({
      githubNumber: 14,
      githubRepo: 'org/repo',
      title: 'Add a thing',
      status: 'review',
      createdBy: 'ZaneZamoraC1Cs',
      assignedHuman: 'Lloyd1020'
    });
    // Alpha's own labels are plumbing; the ones people chose are content.
    expect(mapped.labels).toEqual(['bug']);
  });

  it('survives an issue with an empty body', () => {
    expect(mapIssue(issue({ body: null }), 'org/repo').description).toBe('');
  });
});

describe('foreignLabels', () => {
  it('keeps everyone else’s labels and drops Alpha’s', () => {
    const names = foreignLabels(
      issue({ labels: [{ name: 'alpha:todo' }, { name: 'bug' }, { name: 'good first issue' }] })
    );
    expect(names).toEqual(['bug', 'good first issue']);
  });
});

describe('labelsForWrite', () => {
  /**
   * A status change from Alpha must not wipe a teammate's triage.
   *
   * Replacing the whole label set is the obvious implementation and it silently
   * deletes `bug`, `security`, `good first issue` — work someone did on
   * github.com, undone by someone dragging a card.
   */
  it('keeps labels Alpha does not own', () => {
    const next = labelsForWrite('in_progress', 'high', ['bug', 'alpha:todo', 'alpha:p-low']);
    expect(next).toContain('bug');
    expect(next).toContain('alpha:in-progress');
    expect(next).toContain('alpha:p-high');
    expect(next).not.toContain('alpha:todo');
    expect(next).not.toContain('alpha:p-low');
  });

  /**
   * Done is expressed by closing, not by a label.
   *
   * A leftover `alpha:done` on a reopened issue is exactly the state the
   * statusFromIssue guard exists to survive — better not to create it.
   */
  it('writes no status label for done', () => {
    const next = labelsForWrite('done', 'medium', ['bug']);
    expect(next).toEqual(['bug', 'alpha:p-medium']);
  });
});

describe('stateForStatus', () => {
  it('closes only for done', () => {
    expect(stateForStatus('done')).toBe('closed');
    for (const s of ['backlog', 'todo', 'in_progress', 'agent_running', 'review'] as const) {
      expect(stateForStatus(s)).toBe('open');
    }
  });
});
