import { describe, expect, it } from 'vitest';

import { publishedNotice } from './orchestrationChatNotice.js';
import { isUnchangedPublication } from './orchestrationStateMachine.js';

/** What the Orchestrator says in the build's chat once publication finishes. */
describe('the publication notice in chat', () => {
  const record = (repository: string, url: string, unchanged = false) => ({
    repository, branchName: 'b', baseBranch: 'dev', resultCommit: 'c', pullRequestUrl: url, publishedAt: 'now', ...(unchanged ? { unchanged } : {})
  });

  it('lists each pull request and names the repositories that had nothing to publish', () => {
    const text = publishedNotice([record('acme/project-a-be', '', true), record('acme/project-a-fe', 'https://github.com/acme/project-a-fe/pull/3')]);
    expect(text).toContain('Opened the pull request:');
    expect(text).toContain('- project-a-fe: https://github.com/acme/project-a-fe/pull/3');
    expect(text).toContain('project-a-be had no changes, so it has no pull request.');
    expect(text).toContain('Merge on GitHub');
  });

  it('says plainly when the build changed nothing at all', () => {
    expect(publishedNotice([record('acme/x', '', true)])).toBe('Nothing to publish: the build changed no repository, so there is no pull request.');
  });
});

describe('a repository recorded as unchanged', () => {
  const validated = { baseCommit: 'abc', resultCommit: 'abc' };
  it('counts only when validation shows its result is its base commit and it has no pull request', () => {
    expect(isUnchangedPublication({ unchanged: true, resultCommit: 'abc', pullRequestUrl: '' }, validated)).toBe(true);
    expect(isUnchangedPublication({ unchanged: true, resultCommit: 'abc', pullRequestUrl: '' }, { baseCommit: 'old', resultCommit: 'abc' })).toBe(false);
    expect(isUnchangedPublication({ unchanged: true, resultCommit: 'abc', pullRequestUrl: 'https://github.com/a/b/pull/1' }, validated)).toBe(false);
    expect(isUnchangedPublication({ resultCommit: 'abc', pullRequestUrl: '' }, validated)).toBe(false);
  });
});
