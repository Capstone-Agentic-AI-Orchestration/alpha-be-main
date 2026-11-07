import { createHash, randomUUID } from 'node:crypto';
import type { Issue, IssueStatus, IssueSubtask } from '../models/index.js';
import type { WorkspaceContext } from '../store/workspaceDirectory.js';
import type { BoardAgentAction, BoardAgentChangeRecord } from '../store/boardAgentChange.js';
import { issueStore } from '../store/stores.js';
import { sqliteService } from './sqliteService.js';
import { supabaseService } from './supabaseService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { boardAgentRefusal, type BoardGrant } from './boardGrant.js';
import {
  BoardRuleError,
  addBoardActivityNote,
  archiveCard,
  createCard,
  prepareCardCreate,
  prepareCardUpdate,
  restoreCard,
  saveCardUpdate
} from './boardService.js';

/**
 * What an agent may do on the board for a developer, and how each change is
 * checked, held for confirmation, recorded and undone.
 *
 * Every write goes through the same card rules as the board screen
 * (boardService), as the developer the agent acts for. On top of those:
 *
 * - Archiving, a change to a card assigned to someone else, and changes to
 *   more than BULK_LIMIT cards in one turn wait for that developer to confirm.
 * - An agent never moves a card into Building or Done, never deletes, and never
 *   moves a card to another project.
 * - Each write names the card version it read; a card changed since is
 *   refused, so an agent never overwrites a person's edit.
 * - A repeated tool call in the same turn returns the first result instead of
 *   changing the board twice.
 */
export const BULK_LIMIT = 5;
export const MAX_WRITES_PER_TURN = 30;
const HOLD_FOR_MS = 24 * 60 * 60 * 1000;
const UNDO_FOR_MS = 24 * 60 * 60 * 1000;

const COLUMN_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  agent_running: 'Building',
  review: 'In review',
  done: 'Done'
};
/** Columns an agent may move a card to. Building is a real build; Done is a person's review. */
export const AGENT_MOVABLE: readonly IssueStatus[] = ['backlog', 'todo', 'in_progress', 'review'];
const AGENT_CREATABLE: readonly IssueStatus[] = ['backlog', 'todo'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];

export interface BoardToolResult {
  status: 'done' | 'held' | 'unchanged';
  summary: string;
  changeId?: string;
  card?: Record<string, unknown>;
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as object).sort().map(key => JSON.stringify(key) + ':' + stableStringify((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function requestKeyFor(action: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(action + ':' + stableStringify(args)).digest('hex').slice(0, 32);
}

const actorLabel = (agentName: string, actorLogin: string) => agentName + ' for ' + actorLogin;

/** A card as an agent sees it in a list: small, no comments, so a whole board fits in a turn. */
export function compactCard(issue: Issue): Record<string, unknown> {
  const open = (issue.subtasks ?? []).filter(item => !item.completed).length;
  return {
    card: issue.identifier,
    title: issue.title,
    column: COLUMN_LABEL[issue.status] ?? issue.status,
    priority: issue.priority,
    ...(issue.assignedHuman ? { assignee: issue.assignedHuman } : {}),
    ...(issue.labels?.length ? { labels: issue.labels } : {}),
    ...(issue.dueDate ? { due: issue.dueDate } : {}),
    ...(issue.subtasks?.length ? { checklist: (issue.subtasks.length - open) + '/' + issue.subtasks.length + ' done' } : {}),
    updated_at: issue.updatedAt
  };
}

/** One card in full, for reading before a change. Comments are the latest ten, shortened. */
export function fullCard(issue: Issue, cards: Issue[]): Record<string, unknown> {
  const identifierOf = (id?: string) => cards.find(card => card.id === id)?.identifier ?? id;
  return {
    ...compactCard(issue),
    description: (issue.description ?? '').slice(0, 4000),
    checklist: (issue.subtasks ?? []).map(item => ({ title: item.title, done: item.completed })),
    ...(issue.parentIssueId ? { parent: identifierOf(issue.parentIssueId) } : {}),
    ...(issue.dependsOnIssueIds?.length ? { depends_on: issue.dependsOnIssueIds.map(identifierOf) } : {}),
    ...(issue.plannedStartDate ? { planned_start: issue.plannedStartDate } : {}),
    ...(issue.plannedEndDate ? { planned_end: issue.plannedEndDate } : {}),
    ...(issue.githubUrl ? { github: issue.githubUrl } : {}),
    recent_comments: (issue.comments ?? []).filter(comment => !comment.isThinking).slice(-10)
      .map(comment => ({ by: comment.authorName, at: comment.createdAt, text: comment.content.slice(0, 500) }))
  };
}

async function projectCards(grant: Pick<BoardGrant, 'context' | 'projectId'>, includeArchived = false): Promise<Issue[]> {
  const all = await issueStore().list(grant.context.workspaceId);
  return all.filter(issue => issue.projectId === grant.projectId && (includeArchived || !issue.archivedAt));
}

/** A card in this turn's project, by identifier (CAP-104) or id. */
export async function resolveCard(grant: Pick<BoardGrant, 'context' | 'projectId'>, ref: unknown, includeArchived = false): Promise<Issue> {
  const wanted = typeof ref === 'string' ? ref.trim() : '';
  if (!wanted) throw new BoardRuleError('Name the card, for example CAP-104.', 400);
  const cards = await projectCards(grant, true);
  const card = cards.find(issue => issue.id === wanted || issue.identifier.toLowerCase() === wanted.toLowerCase());
  if (!card) throw new BoardRuleError('There is no card ' + wanted + ' in this project.', 404);
  if (card.archivedAt && !includeArchived) throw new BoardRuleError(card.identifier + ' is archived. Restore it first.', 409);
  return card;
}

// --- Reading ---

export async function listCards(grant: BoardGrant, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  let cards = await projectCards(grant, args.archived === true);
  if (args.archived === true) cards = cards.filter(card => card.archivedAt);
  const column = typeof args.column === 'string' ? args.column : undefined;
  if (column) cards = cards.filter(card => card.status === column || (COLUMN_LABEL[card.status] ?? '').toLowerCase() === column.toLowerCase());
  const search = text(args.search, 200)?.toLowerCase();
  if (search) cards = cards.filter(card => (card.identifier + ' ' + card.title + ' ' + (card.description ?? '')).toLowerCase().includes(search));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 50)));
  return { total: cards.length, cards: cards.slice(0, limit).map(compactCard), ...(cards.length > limit ? { note: 'Shortened; narrow with column or search.' } : {}) };
}

export async function getCard(grant: BoardGrant, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const card = await resolveCard(grant, args.card, true);
  return fullCard(card, await projectCards(grant, true));
}

// --- Writing ---

function requireAccess(grant: BoardGrant, action: BoardAgentAction, card?: Issue) {
  const refusal = boardAgentRefusal(grant.context, grant.projectId);
  if (refusal) throw new BoardRuleError(refusal, 403);
  if (action === 'comment') {
    if (grant.access === 'write') return;
    if (grant.access === 'comment' && card && card.id === grant.ownIssueId) return;
    throw new BoardRuleError('This turn may comment only on its own task card.', 403);
  }
  if (grant.access !== 'write') {
    throw new BoardRuleError('Only the Manager Agent changes cards. Ask the developer to have the Manager Agent make this change.', 403);
  }
  if (grant.writes >= MAX_WRITES_PER_TURN) {
    throw new BoardRuleError('This turn has made ' + MAX_WRITES_PER_TURN + ' board changes, the most one reply may make. Ask the developer to continue in a new message.', 429);
  }
}

function requireCurrent(card: Issue, expected: unknown) {
  if (typeof expected !== 'string' || !expected) {
    throw new BoardRuleError('Read ' + card.identifier + ' first and pass its updated_at as expected_updated_at.', 400);
  }
  if (expected !== card.updatedAt) {
    throw new BoardRuleError(card.identifier + ' changed at ' + card.updatedAt + ', after you read it. Read it again, then decide whether your change still applies.', 409);
  }
}

function holdReason(grant: BoardGrant, action: BoardAgentAction, targetKey: string, card?: Issue): string | null {
  if (action === 'archive') return 'Archiving waits for ' + grant.actorLogin + ' to confirm.';
  if (card?.assignedHuman && card.assignedHuman.toLowerCase() !== grant.actorLogin.toLowerCase() && action !== 'comment') {
    return card.identifier + ' is assigned to ' + card.assignedHuman + ', so changing it waits for ' + grant.actorLogin + ' to confirm.';
  }
  if (action !== 'comment' && !grant.touched.has(targetKey) && grant.touched.size >= BULK_LIMIT) {
    return 'This reply has already changed ' + BULK_LIMIT + ' cards, so further changes wait for ' + grant.actorLogin + ' to confirm.';
  }
  return null;
}

const pick = (issue: Issue | undefined, keys: string[]): Record<string, unknown> | undefined =>
  issue ? Object.fromEntries([...keys, 'updatedAt', 'identifier'].map(key => [key, (issue as unknown as Record<string, unknown>)[key] ?? null])) : undefined;

function newRecord(grant: BoardGrant, action: BoardAgentAction, requestKey: string, input: Record<string, unknown>, summary: string, card?: Issue): BoardAgentChangeRecord {
  return {
    id: 'bac-' + randomUUID(),
    workspaceId: grant.context.workspaceId,
    projectId: grant.projectId,
    ...(card ? { issueId: card.id } : {}),
    runId: grant.runId,
    requestKey,
    ...(grant.agentId ? { agentId: grant.agentId } : {}),
    agentName: grant.agentName,
    actorUserId: grant.context.userId,
    actorLogin: grant.actorLogin,
    action,
    status: 'applied',
    summary,
    input,
    createdAt: new Date().toISOString()
  };
}

const store = <T>(workspaceId: string, fn: () => T): T => runWithWorkspace(workspaceId, fn);

function describe(change: BoardAgentChangeRecord): BoardToolResult {
  if (change.status === 'held') {
    return { status: 'held', changeId: change.id, summary: 'Waiting for ' + change.actorLogin + ' to confirm: ' + change.summary + '. ' + (change.reason ?? '') };
  }
  if (change.status === 'applied') return { status: 'done', changeId: change.id, summary: change.summary + '.' };
  return { status: 'unchanged', changeId: change.id, summary: change.summary + ' was ' + change.status + (change.reason ? ': ' + change.reason : '') + '.' };
}

/** Field changes an agent may make to a card, translated to the card's own names. */
function cardUpdates(args: Record<string, unknown>, cards: Issue[], current?: Issue): { updates: Record<string, unknown>; fields: string[] } {
  const updates: Record<string, unknown> = {};
  const title = text(args.title, 300);
  if (title) updates.title = title;
  if (typeof args.description === 'string') updates.description = args.description.slice(0, 20000);
  if (args.priority !== undefined) {
    if (typeof args.priority !== 'string' || !PRIORITIES.includes(args.priority)) throw new BoardRuleError('priority must be one of ' + PRIORITIES.join(', ') + '.', 400);
    updates.priority = args.priority;
  }
  if (args.labels !== undefined) {
    if (!Array.isArray(args.labels) || args.labels.some(label => typeof label !== 'string')) throw new BoardRuleError('labels must be a list of words.', 400);
    updates.labels = (args.labels as string[]).map(label => label.trim()).filter(Boolean).slice(0, 20);
  }
  if (args.checklist !== undefined) {
    if (!Array.isArray(args.checklist)) throw new BoardRuleError('checklist must be a list of items.', 400);
    const existing = current?.subtasks ?? [];
    updates.subtasks = (args.checklist as unknown[]).slice(0, 40).map((item, index): IssueSubtask => {
      const entry = (typeof item === 'object' && item !== null ? item : {}) as { title?: unknown; done?: unknown };
      const title = typeof item === 'string' ? item.trim() : text(entry.title, 500) ?? '';
      if (!title) throw new BoardRuleError('Each checklist item needs text.', 400);
      const done = entry.done === true;
      const same = existing.find(old => old.title === title);
      return { ...(same ?? {}), id: same?.id ?? 'sub-' + randomUUID().slice(0, 8) + '-' + index, title, completed: done };
    });
  }
  if (args.assignee !== undefined) updates.assignedHuman = text(args.assignee, 100) ?? '';
  if (args.due_date !== undefined) updates.dueDate = args.due_date ?? '';
  if (args.planned_start !== undefined) updates.plannedStartDate = args.planned_start ?? '';
  if (args.planned_end !== undefined) updates.plannedEndDate = args.planned_end ?? '';
  const byRef = (ref: unknown) => {
    const wanted = String(ref).trim().toLowerCase();
    const card = cards.find(issue => issue.identifier.toLowerCase() === wanted || issue.id === ref);
    if (!card) throw new BoardRuleError('There is no card ' + String(ref) + ' in this project.', 400);
    return card.id;
  };
  if (args.depends_on !== undefined) {
    if (!Array.isArray(args.depends_on)) throw new BoardRuleError('depends_on must be a list of cards.', 400);
    updates.dependsOnIssueIds = (args.depends_on as unknown[]).map(byRef);
  }
  if (args.parent !== undefined) updates.parentIssueId = args.parent ? byRef(args.parent) : '';
  const fields = Object.keys(updates);
  return { updates, fields };
}

/** Apply a recorded change to the board. Used straight away, or when the developer confirms a held one. */
async function applyChange(change: BoardAgentChangeRecord): Promise<BoardAgentChangeRecord> {
  const workspaceId = change.workspaceId;
  const by = actorLabel(change.agentName, change.actorLogin);
  const input = change.input as Record<string, any>;
  const grantLike = { context: { workspaceId } as WorkspaceContext, projectId: change.projectId };

  if (change.action === 'create') {
    const rest = await prepareCardCreate(workspaceId, { ...(input.fields as object), projectId: change.projectId });
    const { saved } = await createCard(workspaceId, rest, change.actorLogin, issue => issue.identifier + ' created by ' + by + '.');
    return { ...change, issueId: saved.id, summary: 'Created ' + saved.identifier + ' "' + saved.title + '"', after: pick(saved, Object.keys(input.fields ?? {})) };
  }

  const card = await resolveCard(grantLike, change.issueId, change.action === 'restore');
  const expected = (change.before)?.updatedAt;
  if (expected && expected !== card.updatedAt) {
    throw new BoardRuleError(card.identifier + ' changed after the agent read it, so this change was not made.', 409);
  }

  if (change.action === 'archive') {
    const { saved } = await archiveCard(workspaceId, card, by);
    return { ...change, after: pick(saved, ['archivedAt', 'archivedBy']) };
  }
  if (change.action === 'restore') {
    const { saved } = await restoreCard(workspaceId, card, by);
    return { ...change, after: pick(saved, ['archivedAt', 'archivedBy']) };
  }
  if (change.action === 'comment') {
    const comment = await issueStore().addComment(workspaceId, {
      id: 'comm-' + card.id + '-agent-' + randomUUID().slice(0, 12),
      issueId: card.id,
      authorType: 'agent',
      authorName: change.agentName,
      ...(change.agentId ? { agentId: change.agentId } : {}),
      content: String(input.text) + '\n\n(on behalf of ' + change.actorLogin + ')',
      createdAt: new Date().toISOString()
    });
    void supabaseService.shareComment(comment);
    return change;
  }

  // update or move
  const updates = await prepareCardUpdate(workspaceId, card, { ...(input.updates as object) });
  const { saved } = await saveCardUpdate(workspaceId, card, updates);
  // One note per card per turn: the team sees who changed it and for whom,
  // and the full detail stays in this desktop's change log (less to sync).
  const notedThisTurn = store(workspaceId, () => sqliteService.listBoardAgentChanges(workspaceId, { runId: change.runId, limit: 200 }))
    .some(other => other.issueId === card.id && other.status === 'applied' && (other.action === 'update' || other.action === 'move'));
  if (!notedThisTurn) {
    const assignedElsewhere = card.assignedHuman && card.assignedHuman.toLowerCase() !== change.actorLogin.toLowerCase();
    await addBoardActivityNote(workspaceId, card.id,
      'Changed by ' + by + ': ' + change.summary + '.' + (assignedElsewhere ? ' Assigned to ' + card.assignedHuman + '.' : ''),
      'agent');
  }
  return { ...change, after: pick(saved, Object.keys(input.updates ?? {})) };
}

/** The shared path for every agent write: access, repeat check, hold or apply, record. */
async function write(
  grant: BoardGrant,
  action: BoardAgentAction,
  args: Record<string, unknown>,
  prepare: () => Promise<{ card?: Issue; summary: string; input: Record<string, unknown>; beforeKeys: string[] }>
): Promise<BoardToolResult> {
  const requestKey = requestKeyFor(action, args);
  const previous = store(grant.context.workspaceId, () => sqliteService.findBoardAgentChange(grant.context.workspaceId, grant.runId, requestKey));
  if (previous) return describe(previous);

  // Refuse an agent that may not change cards before reading anything for it.
  if (action !== 'comment') requireAccess(grant, action);
  const { card, summary, input, beforeKeys } = await prepare();
  if (action === 'comment') requireAccess(grant, action, card);
  const targetKey = card?.id ?? 'new:' + requestKey;
  const reason = holdReason(grant, action, targetKey, card);
  let change = newRecord(grant, action, requestKey, input, summary, card);
  change.before = pick(card, beforeKeys);
  grant.writes += 1;
  if (action !== 'comment') grant.touched.add(targetKey);

  if (reason) {
    change = { ...change, status: 'held', reason, expiresAt: new Date(Date.now() + HOLD_FOR_MS).toISOString() };
    store(grant.context.workspaceId, () => sqliteService.insertBoardAgentChange(change));
    return describe(change);
  }

  try {
    change = await applyChange(change);
  } catch (err) {
    if (err instanceof BoardRuleError) {
      grant.writes -= 1;
      throw err;
    }
    throw err;
  }
  store(grant.context.workspaceId, () => sqliteService.insertBoardAgentChange(change));
  return describe(change);
}

export async function createCardForAgent(grant: BoardGrant, args: Record<string, unknown>): Promise<BoardToolResult> {
  return write(grant, 'create', args, async () => {
    const title = text(args.title, 300);
    if (!title) throw new BoardRuleError('A new card needs a title.', 400);
    const status = (typeof args.column === 'string' ? args.column : 'todo') as IssueStatus;
    if (!AGENT_CREATABLE.includes(status)) throw new BoardRuleError('New cards start in Backlog or Todo.', 400);
    const cards = await projectCards(grant);
    const { updates } = cardUpdates({ ...args, title }, cards);
    const fields = { ...updates, status, priority: updates.priority ?? 'medium', labels: updates.labels ?? [], subtasks: updates.subtasks ?? [] };
    return { summary: 'Create "' + title + '" in ' + COLUMN_LABEL[status], input: { fields }, beforeKeys: [] };
  });
}

export async function updateCardForAgent(grant: BoardGrant, args: Record<string, unknown>): Promise<BoardToolResult> {
  return write(grant, 'update', args, async () => {
    const card = await resolveCard(grant, args.card);
    requireCurrent(card, args.expected_updated_at);
    const { updates, fields } = cardUpdates(args, await projectCards(grant), card);
    if (!fields.length) throw new BoardRuleError('Say what to change: title, description, priority, labels, checklist, assignee, dates, depends_on or parent.', 400);
    if ((args).column || (args).status) throw new BoardRuleError('Use board_move_card to change a card\'s column.', 400);
    return { card, summary: 'Updated ' + card.identifier + ' (' + fields.join(', ') + ')', input: { updates }, beforeKeys: fields };
  });
}

export async function moveCardForAgent(grant: BoardGrant, args: Record<string, unknown>): Promise<BoardToolResult> {
  return write(grant, 'move', args, async () => {
    const card = await resolveCard(grant, args.card);
    const status = args.column as IssueStatus;
    if (status === 'agent_running') throw new BoardRuleError('Cards enter Building only when a developer starts a build.', 409);
    if (status === 'done') throw new BoardRuleError('Only a person marks a card Done, after reviewing it.', 409);
    if (!AGENT_MOVABLE.includes(status)) throw new BoardRuleError('column must be one of ' + AGENT_MOVABLE.join(', ') + '.', 400);
    requireCurrent(card, args.expected_updated_at);
    return { card, summary: 'Moved ' + card.identifier + ' to ' + COLUMN_LABEL[status], input: { updates: { status } }, beforeKeys: ['status'] };
  });
}

export async function commentForAgent(grant: BoardGrant, args: Record<string, unknown>): Promise<BoardToolResult> {
  return write(grant, 'comment', args, async () => {
    const card = await resolveCard(grant, args.card);
    const body = text(args.text, 4000);
    if (!body) throw new BoardRuleError('A comment needs text.', 400);
    return { card, summary: 'Commented on ' + card.identifier, input: { text: body }, beforeKeys: [] };
  });
}

export async function archiveForAgent(grant: BoardGrant, args: Record<string, unknown>): Promise<BoardToolResult> {
  return write(grant, 'archive', args, async () => {
    const card = await resolveCard(grant, args.card);
    requireCurrent(card, args.expected_updated_at);
    const why = text(args.reason, 300);
    return { card, summary: 'Archive ' + card.identifier + (why ? ' (' + why + ')' : ''), input: { reason: why ?? '' }, beforeKeys: ['archivedAt', 'archivedBy'] };
  });
}

export async function restoreForAgent(grant: BoardGrant, args: Record<string, unknown>): Promise<BoardToolResult> {
  return write(grant, 'restore', args, async () => {
    const card = await resolveCard(grant, args.card, true);
    if (!card.archivedAt) throw new BoardRuleError(card.identifier + ' is not archived.', 409);
    return { card, summary: 'Restored ' + card.identifier, input: {}, beforeKeys: ['archivedAt', 'archivedBy'] };
  });
}

// --- The developer's decisions ---

function expireHeld(change: BoardAgentChangeRecord): BoardAgentChangeRecord {
  if (change.status === 'held' && change.expiresAt && Date.parse(change.expiresAt) < Date.now()) {
    const expired = { ...change, status: 'expired' as const, decidedAt: new Date().toISOString() };
    store(change.workspaceId, () => sqliteService.updateBoardAgentChange(expired));
    return expired;
  }
  return change;
}

export function listAgentChanges(context: WorkspaceContext, filter: { projectId?: string; status?: string; limit?: number }): BoardAgentChangeRecord[] {
  return store(context.workspaceId, () => sqliteService.listBoardAgentChanges(context.workspaceId, filter)).map(expireHeld);
}

function ownChange(context: WorkspaceContext, id: string): BoardAgentChangeRecord {
  const change = store(context.workspaceId, () => sqliteService.getBoardAgentChange(context.workspaceId, id));
  if (!change) throw new BoardRuleError('That change is no longer available.', 404);
  if (change.actorUserId !== context.userId) {
    throw new BoardRuleError('Only ' + change.actorLogin + ', who asked for this change, can decide on it.', 403);
  }
  return expireHeld(change);
}

/** The developer confirms a held change. It is applied only if the card is as the agent saw it. */
export async function approveAgentChange(context: WorkspaceContext, id: string): Promise<BoardAgentChangeRecord> {
  const change = ownChange(context, id);
  if (change.status !== 'held') throw new BoardRuleError('This change is ' + change.status + ', not waiting for you.', 409);
  const refusal = boardAgentRefusal(context, change.projectId);
  if (refusal) throw new BoardRuleError(refusal, 403);
  const decided = { decidedAt: new Date().toISOString(), decidedBy: context.userId };
  try {
    const applied = { ...(await applyChange(change)), status: 'applied' as const, reason: undefined, ...decided };
    store(context.workspaceId, () => sqliteService.updateBoardAgentChange(applied));
    return applied;
  } catch (err) {
    if (!(err instanceof BoardRuleError)) throw err;
    const failed = { ...change, status: 'failed' as const, reason: err.message, ...decided };
    store(context.workspaceId, () => sqliteService.updateBoardAgentChange(failed));
    throw err;
  }
}

export function rejectAgentChange(context: WorkspaceContext, id: string): BoardAgentChangeRecord {
  const change = ownChange(context, id);
  if (change.status !== 'held') throw new BoardRuleError('This change is ' + change.status + ', not waiting for you.', 409);
  const rejected = { ...change, status: 'rejected' as const, decidedAt: new Date().toISOString(), decidedBy: context.userId };
  store(context.workspaceId, () => sqliteService.updateBoardAgentChange(rejected));
  return rejected;
}

/**
 * Undo an applied change within a day, if nobody changed the card since.
 * A created card is archived rather than deleted; comments cannot be undone.
 */
export async function undoAgentChange(context: WorkspaceContext, id: string): Promise<BoardAgentChangeRecord> {
  const change = ownChange(context, id);
  if (change.status !== 'applied') throw new BoardRuleError('Only a change that was made can be undone.', 409);
  if (Date.now() - Date.parse(change.decidedAt ?? change.createdAt) > UNDO_FOR_MS) throw new BoardRuleError('Undo is available for 24 hours after a change.', 409);
  if (change.action === 'comment') throw new BoardRuleError('Comments cannot be undone.', 409);
  const refusal = boardAgentRefusal(context, change.projectId);
  if (refusal) throw new BoardRuleError(refusal, 403);
  const workspaceId = context.workspaceId;
  const grantLike = { context, projectId: change.projectId };
  const card = await resolveCard(grantLike, change.issueId, true);
  const by = change.actorLogin;
  const after = change.after as Record<string, unknown> | undefined;

  if (change.action === 'create' || change.action === 'restore') {
    if (!card.archivedAt) await archiveCard(workspaceId, card, by + ' (undo)');
  } else if (change.action === 'archive') {
    if (card.archivedAt) await restoreCard(workspaceId, card, by + ' (undo)');
  } else {
    if (after?.updatedAt && after.updatedAt !== card.updatedAt) {
      throw new BoardRuleError(card.identifier + ' changed after this edit, so it cannot be undone automatically.', 409);
    }
    const before = { ...(change.before ?? {}) } as Record<string, unknown>;
    delete before.updatedAt;
    delete before.identifier;
    const revert = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value === null ? (key === 'dependsOnIssueIds' ? [] : '') : value]));
    const updates = await prepareCardUpdate(workspaceId, card, revert);
    await saveCardUpdate(workspaceId, card, updates);
    await addBoardActivityNote(workspaceId, card.id, 'Undid "' + change.summary + '" (' + by + ').', 'undo');
  }
  const undone = { ...change, status: 'undone' as const, decidedAt: new Date().toISOString(), decidedBy: context.userId };
  store(workspaceId, () => sqliteService.updateBoardAgentChange(undone));
  return undone;
}

