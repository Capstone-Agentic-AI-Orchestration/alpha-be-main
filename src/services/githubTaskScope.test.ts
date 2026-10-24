import { describe, expect, it } from 'vitest';
import { githubToolWithinScope } from './githubTaskScope.js';
describe('project-scoped GitHub assessment', () => {
  it('permits only read operations on the selected repository', () => {
    expect(githubToolWithinScope('github_workflow_runs', ['test/app'], { repo: 'test/app' })).toBe(true);
    expect(githubToolWithinScope('github_workflow_runs', ['test/app'], { repo: 'C:/other/project' })).toBe(false);
    expect(githubToolWithinScope('github_read_file', ['test/app'], { repo: 'other/app', path: 'src/app.ts' })).toBe(false);
    expect(githubToolWithinScope('github_read_file', ['test/app'], { repo: 'test/app', path: '.env' })).toBe(false);
    for (const name of ['github_push_branch', 'github_open_pull_request', 'github_clone_repository', 'github_list_repositories', 'github_review_pull_request']) expect(githubToolWithinScope(name, ['test/app'])).toBe(false);
    expect(githubToolWithinScope('github_check_access', [], { repo: 'test/app' })).toBe(false);
  });
});
