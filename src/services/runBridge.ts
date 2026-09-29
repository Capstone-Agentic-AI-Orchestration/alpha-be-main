import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * What an agent's tools may do on behalf of the run that started them.
 *
 * A tool server runs as a grandchild of this process -- this process spawns
 * the agent CLI, the CLI spawns the server -- with no Alpha sign-in of its
 * own. It is handed a token instead: minted when the run's tool config is
 * written, naming exactly one run, its agent, the project's repositories and
 * whether it may write, and revoked when the run's config is cleaned up.
 * The bridge routes accept nothing else, so a tool can reach only the
 * repositories of the run it belongs to, for as long as that run lasts.
 *
 * Kept in memory: a token outlives nothing, and a restart ends every run.
 */

export interface RunGrant {
  runId: string;
  agentId: string | null;
  /** The workspace the run was started in; its forwards to the cloud carry it. */
  workspaceId: string | null;
  /** `owner/name`, lowercased for comparison, each with what the project knows about it. */
  repos: Record<string, { repo: string; stack?: string; partner?: string }>;
  access: 'read' | 'write';
}

const grantsByTokenHash = new Map<string, RunGrant>();
const tokenHashByRun = new Map<string, string>();

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** A new token for `grant.runId`, replacing any earlier one for the same run. */
export function mintRunGrant(grant: RunGrant): string {
  revokeRunGrant(grant.runId);
  const token = randomBytes(32).toString('hex');
  const tokenHash = hash(token);
  grantsByTokenHash.set(tokenHash, grant);
  tokenHashByRun.set(grant.runId, tokenHash);
  return token;
}

/** The grant a token stands for, or null for an unknown, revoked or malformed one. */
export function grantForToken(token: string | undefined): RunGrant | null {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return grantsByTokenHash.get(hash(token)) ?? null;
}

export function revokeRunGrant(runId: string): void {
  const tokenHash = tokenHashByRun.get(runId);
  if (tokenHash) grantsByTokenHash.delete(tokenHash);
  tokenHashByRun.delete(runId);
}

/** The grant's entry for `repo`, when the run may touch it. */
export function grantedRepo(grant: RunGrant, repo: string) {
  return grant.repos[repo.toLowerCase()] ?? null;
}

// ─── Production changes waiting for a person ────────────────────────────────

/**
 * An agent's change to production variables, held until a project manager or
 * admin approves it. The values are held here, in memory, and nowhere else:
 * not on disk, not in the run log, not in the cloud until approval sends
 * them. A restart drops them; the agent can ask again.
 */
export interface PendingHostingChange {
  id: string;
  runId: string;
  agentId: string | null;
  workspaceId: string | null;
  repo: string;
  hints: { stack?: string; partner?: string };
  environment: 'main';
  vars: Array<{ key: string; value: string }>;
  redeploy: boolean;
  createdAt: string;
}

/** A change nobody decided on within this long is dropped with its values. */
const PENDING_TTL_MS = 12 * 60 * 60 * 1000;

const pending = new Map<string, PendingHostingChange>();

function dropExpired(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, change] of pending) if (Date.parse(change.createdAt) < cutoff) pending.delete(id);
}

export function holdHostingChange(change: Omit<PendingHostingChange, 'id' | 'createdAt'>): PendingHostingChange {
  dropExpired();
  const held: PendingHostingChange = { ...change, id: randomUUID(), createdAt: new Date().toISOString() };
  pending.set(held.id, held);
  return held;
}

/** What a person reviewing the change sees: everything but the values. */
export function describePending(change: PendingHostingChange) {
  const { vars, hints: _hints, ...rest } = change;
  return { ...rest, keys: vars.map(v => v.key) };
}

export function pendingForRun(runId: string): PendingHostingChange[] {
  dropExpired();
  return [...pending.values()].filter(change => change.runId === runId);
}

/** Take the change out of the queue: approving and rejecting both end it. */
export function takePending(runId: string, id: string): PendingHostingChange | null {
  dropExpired();
  const change = pending.get(id);
  if (!change || change.runId !== runId) return null;
  pending.delete(id);
  return change;
}
