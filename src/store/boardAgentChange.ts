/**
 * One board change an agent made, or asked a person to confirm, on that
 * person's behalf. See boardAgentService.
 */
export type BoardAgentAction = 'create' | 'update' | 'move' | 'comment' | 'archive' | 'restore';
export type BoardAgentChangeStatus = 'applied' | 'held' | 'rejected' | 'expired' | 'undone' | 'failed';

export interface BoardAgentChangeRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  issueId?: string;
  runId: string;
  /** Identifies one tool call within a run, so a repeated call does not change the board twice. */
  requestKey: string;
  agentId?: string;
  agentName: string;
  actorUserId: string;
  actorLogin: string;
  action: BoardAgentAction;
  status: BoardAgentChangeStatus;
  /** One readable line, e.g. "Moved CAP-104 to Todo". */
  summary: string;
  input: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  createdAt: string;
  expiresAt?: string;
  decidedAt?: string;
  decidedBy?: string;
}

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
const parse = (value: unknown) => (typeof value === 'string' && value ? JSON.parse(value) : undefined);

export function boardAgentChangeParams(change: BoardAgentChangeRecord): Record<string, unknown> {
  return {
    id: change.id,
    workspaceId: change.workspaceId,
    projectId: change.projectId,
    issueId: change.issueId ?? null,
    runId: change.runId,
    requestKey: change.requestKey,
    agentId: change.agentId ?? null,
    agentName: change.agentName,
    actorUserId: change.actorUserId,
    actorLogin: change.actorLogin,
    action: change.action,
    status: change.status,
    summary: change.summary,
    inputJson: JSON.stringify(change.input ?? {}),
    beforeJson: json(change.before),
    afterJson: json(change.after),
    reason: change.reason ?? null,
    createdAt: change.createdAt,
    expiresAt: change.expiresAt ?? null,
    decidedAt: change.decidedAt ?? null,
    decidedBy: change.decidedBy ?? null
  };
}

export function boardAgentChangeFromRow(row: any): BoardAgentChangeRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    ...(row.issue_id ? { issueId: row.issue_id } : {}),
    runId: row.run_id,
    requestKey: row.request_key,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    agentName: row.agent_name,
    actorUserId: row.actor_user_id,
    actorLogin: row.actor_login,
    action: row.action,
    status: row.status,
    summary: row.summary,
    input: parse(row.input_json) ?? {},
    ...(row.before_json ? { before: parse(row.before_json) } : {}),
    ...(row.after_json ? { after: parse(row.after_json) } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {})
  };
}

