import { Request, Response, Router } from 'express';
import { route } from './asyncRoute.js';
import { agentStore, projectStore, squadStore } from '../store/stores.js';
import { chatService } from '../services/chatService.js';
import { sqliteService } from '../services/sqliteService.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';
import { requireEntityWorkspace, requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';

export const chatRouter = Router();

/**
 * The caller's own conversations, and only those.
 *
 * This used to be scoped by workspace alone, so every member of a workspace
 * received every other member's threads — a developer could read a colleague's
 * prompts by loading the chat list. The table had no owner column, so there
 * was nothing to filter on and the filter was never written.
 *
 * No project-manager bypass, deliberately. Prompts are working notes rather
 * than managed output; oversight sees runs, stages and patches instead. The
 * same split is enforced again in Postgres by the policies in
 * `0002_row_level_security.sql`, because the desktop reaches that database
 * without passing through this route.
 */
chatRouter.get('/chat/threads', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  res.json(
    workspaceRegistry.scope(
      'chat_threads',
      sqliteService.getChatThreads(req.workspace!.userId),
      req.workspace!.workspaceId
    )
  );
});

/**
 * Create a conversation, idempotently on the id the client chose.
 *
 * The client mints the id and posts it, and two things can create the same
 * thread: this route, and `chatService.sendMessage`, which creates one lazily
 * when a message arrives for a thread it does not know. The browser writes
 * optimistically and reconciles — see `persist` — so the POST is not awaited
 * before the first message can be sent, and either order is reachable. A plain
 * INSERT loses that race with `UNIQUE constraint failed`, answering 500 about a
 * thread that exists and is perfectly usable.
 *
 * Returning the existing row is honest here in a way the same trick would not
 * be on the PUT below. A POST asks for the thread to exist; if it already does,
 * under the same id, nothing was misreported. The PUT asserts a property of a
 * thread presumed to exist, so its 404 carries information — that the id is
 * unknown — and creating a row there would manufacture the very thing the
 * caller got wrong. 201 and 200 keep the difference visible to anyone reading
 * the wire.
 */
chatRouter.post('/chat/threads', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  const id = typeof req.body?.id === 'string' ? req.body.id : undefined;

  const existing = id
    ? workspaceRegistry.scope('chat_threads', sqliteService.getChatThreads(req.workspace!.userId), req.workspace!.workspaceId).find(t => t.id === id)
    : undefined;
  if (existing) return res.status(200).json(existing);

  if (req.body?.projectId !== undefined && req.body.projectId !== null) {
    if (typeof req.body.projectId !== 'string') {
      return res.status(400).json({ error: 'projectId must be a string or null' });
    }
    if (!requireProjectWorkspace(req, res, req.body.projectId)) return;
  }

  /**
   * The owner is taken from the resolved caller, never from the body.
   *
   * A client that could name its own `ownerId` could create a thread
   * attributed to someone else, or read one by claiming to own it. The
   * middleware already decided who this is.
   */
  const thread = sqliteService.createChatThread({
    ...req.body,
    ownerId: req.workspace!.userId
  });
  workspaceRegistry.bind('chat_threads', thread.id, req.workspace!.workspaceId);
  res.status(201).json(thread);
});

/**
 * Point a conversation at a project — the directory its agents will inspect.
 *
 * Separate from the message route because it changes what an agent can see,
 * not what it was told. `projectId: null` clears it and returns the thread to
 * the managed workspace root.
 */
chatRouter.put('/chat/threads/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  const { projectId } = req.body ?? {};

  if (projectId !== null && typeof projectId !== 'string') {
    return res.status(400).json({ error: 'projectId must be a string or null' });
  }

  if (projectId && !requireProjectWorkspace(req, res, projectId)) return;

  const updated = sqliteService.setChatThreadProject(req.params.id, projectId);
  if (!updated) return res.status(404).json({ error: 'Thread not found' });

  /**
   * Say which directory that actually resolved to.
   *
   * A project can hold more than one working copy — a repository Alpha
   * scaffolded and a folder the user attached by hand — and the resolver
   * prefers the managed one. On a project with both, choosing it silently
   * points the agent at whichever the rule picked, which is how a review of
   * "the project" came back describing a starter template. Naming the path is
   * what makes that visible before the first question rather than after a
   * confidently wrong answer.
   */
  const project = projectId
    ? await projectStore().get(req.workspace!.workspaceId, projectId)
    : null;
  const workspace = project ? resolveProjectWorkspace(project) : null;

  res.json({
    ...updated,
    workspaceDir: workspace?.dir ?? null,
    workspaceManaged: workspace?.managed ?? null
  });
}));

/**
 * Choose who answers an unmentioned message in a conversation.
 *
 * A thread can point at one configured agent, one squad, or neither (Alpha's
 * automatic responder). The target is deliberately separate from `agentIds`:
 * that field is the participant history and must not make an old participant
 * answer every future message.
 */
chatRouter.put('/chat/threads/:id/target', route(async (req: Request, res: Response) => {
  const { targetAgentId = null, targetSquadId = null } = req.body ?? {};

  if (
    (targetAgentId !== null && typeof targetAgentId !== 'string') ||
    (targetSquadId !== null && typeof targetSquadId !== 'string')
  ) {
    return res.status(400).json({ error: 'Target ids must be strings or null' });
  }

  if (targetAgentId && targetSquadId) {
    return res.status(400).json({ error: 'Choose an agent or a squad, not both' });
  }

  if (targetAgentId) {
    const agent = await agentStore().get(req.workspace!.workspaceId, targetAgentId);
    if (!agent || agent.isArchived) return res.status(404).json({ error: 'Agent not found or archived' });
  }

  if (targetSquadId && !(await squadStore().get(req.workspace!.workspaceId, targetSquadId))) {
    return res.status(404).json({ error: 'Squad not found' });
  }

  const updated = sqliteService.setChatThreadTarget(req.params.id, targetAgentId, targetSquadId);
  if (!updated) return res.status(404).json({ error: 'Thread not found' });
  return res.json(updated);
}));

chatRouter.get('/chat/threads/:id/messages', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  res.json(sqliteService.getChatMessages(req.params.id));
});

/**
 * Delete a conversation, or empty one.
 *
 * Neither existed. The UI has had a Delete and a Clear button since the chat
 * view was written, and both only ever changed React state — the rows stayed
 * in SQLite. That was invisible while hydration was also wiping the client's
 * copy, because a deleted thread came back empty and looked deleted.
 */
chatRouter.delete('/chat/threads/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  const deleted = sqliteService.deleteChatThread(req.params.id);
  if (deleted) await workspaceRegistry.unbind('chat_threads', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Thread not found' });
  res.json({ success: true });
}));

chatRouter.delete('/chat/threads/:id/messages', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  const removed = sqliteService.clearChatMessages(req.params.id);
  if (removed < 0) return res.status(404).json({ error: 'Thread not found' });
  res.json({ success: true, removed });
});

chatRouter.post('/chat/messages', async (req: Request, res: Response) => {
  try {
    const { threadId, content, senderName, targetAgentId, targetSquadId } = req.body;
    if (!threadId || !content) {
      return res.status(400).json({ error: 'threadId and content are required' });
    }
    if (
      (targetAgentId !== undefined && targetAgentId !== null && typeof targetAgentId !== 'string') ||
      (targetSquadId !== undefined && targetSquadId !== null && typeof targetSquadId !== 'string')
    ) {
      return res.status(400).json({ error: 'Target ids must be strings or null' });
    }
    if (targetAgentId && targetSquadId) {
      return res.status(400).json({ error: 'Choose an agent or a squad, not both' });
    }
    const result = await chatService.sendMessage({
      threadId,
      content,
      senderName,
      targetAgentId,
      targetSquadId
    });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to process chat message' });
  }
});
