import type { Issue, IssueComment } from '../models/index.js';
import { sqliteService } from '../services/sqliteService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import type { IssueStore } from './issueStore.js';

/**
 * The board on a developer's machine.
 *
 * A thin adapter over `sqliteService`, which still owns the SQL: the runner
 * reads and writes these rows synchronously mid-run, and a second writer for
 * them is not something a store interface should introduce.
 */
export class SqliteIssueStore implements IssueStore {
  async list(workspaceId: string): Promise<Issue[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getIssues());
  }

  async get(workspaceId: string, id: string): Promise<Issue | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.getIssues().find(issue => issue.id === id) ?? null);
  }

  async create(workspaceId: string, input: Partial<Issue>): Promise<Issue> {
    return runWithWorkspace(workspaceId, () => sqliteService.createIssue(input));
  }

  async update(workspaceId: string, id: string, updates: Partial<Issue>): Promise<Issue | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.updateIssue(id, updates));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return runWithWorkspace(workspaceId, () => sqliteService.deleteIssue(id));
  }

  async addComment(workspaceId: string, comment: IssueComment): Promise<IssueComment> {
    return runWithWorkspace(workspaceId, () => sqliteService.addIssueComment(comment));
  }
}
