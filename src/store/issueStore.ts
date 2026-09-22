import type { Issue, IssueComment } from '../models/index.js';

/**
 * Issues and their comments — the board itself.
 *
 * Postgres in the cloud, SQLite on a desktop, behind one interface. The
 * comments come back on their issue rather than through a second call,
 * because that is how every caller wants them and how both stores read them.
 */
export interface IssueStore {
  list(workspaceId: string): Promise<Issue[]>;
  get(workspaceId: string, id: string): Promise<Issue | null>;
  create(workspaceId: string, input: Partial<Issue>): Promise<Issue>;
  update(workspaceId: string, id: string, updates: Partial<Issue>): Promise<Issue | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  /** Add (or replace, by id) one comment on an issue in this workspace. */
  addComment(workspaceId: string, comment: IssueComment): Promise<IssueComment>;
}

/**
 * The next free `KEY-nnn` for a project.
 *
 * Derived from the identifiers that exist rather than from a counter, so it
 * stays correct after a deletion and needs no extra state. Starts at 101 to
 * match the seeded issues, which is also why it reads as a number rather than
 * an index.
 */
export function nextIssueIdentifier(projectKey: string, existing: string[]): string {
  const key = (projectKey || 'ISS').toUpperCase();
  const highest = existing.reduce((max, identifier) => {
    const n = Number(String(identifier).split('-').pop());
    return Number.isFinite(n) && n > max ? n : max;
  }, 100);
  return `${key}-${highest + 1}`;
}

/**
 * An issue has one execution owner.
 *
 * A squad wins when a caller sends both: an agent assigned alongside a squad
 * is the older field left behind, and running both would mean two owners for
 * the same card.
 */
export function oneOwner(issue: {
  assignedAgentId?: string;
  assignedSquadId?: string;
}, changed: { assignedAgentId?: boolean; assignedSquadId?: boolean } = {}): void {
  if (!issue.assignedAgentId || !issue.assignedSquadId) return;
  if (changed.assignedSquadId) issue.assignedAgentId = undefined;
  else issue.assignedSquadId = undefined;
}
