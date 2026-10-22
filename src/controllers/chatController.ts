import { Request, Response, Router } from 'express';
import { route } from './asyncRoute.js';
import { agentStore, chatStore, projectStore } from '../store/stores.js';
import { chatService, ChatRouteError } from '../services/chatService.js';
import { sqliteService } from '../services/sqliteService.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';
import { requireEntityWorkspace, requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import {
  clearMessagesAndShare,
  createThreadAndShare,
  deleteThreadAndShare,
  shareThread
} from '../services/chatWriteThrough.js';
import { desktopOnly } from './desktopOnly.js';
import { parseChatOverride } from '../services/chatRouter.js';
import { IS_CLOUD } from '../config/env.js';
import { supabaseService } from '../services/supabaseService.js';
import { retryChatSync } from '../services/chatSyncService.js';
import { chatAttachmentService, MAX_CHAT_ATTACHMENT_BYTES } from '../services/chatAttachmentService.js';

export const chatRouter = Router();

/** Sync health for the current owner's local chat outbox. */
chatRouter.get('/chat/sync/status', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  if (IS_CLOUD) return res.json({ enabled: false, state: 'shared', pending: 0, failed: 0 });
  const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : undefined;
  if (threadId && !requireEntityWorkspace(req, res, 'chat_threads', threadId)) return;
  const status = sqliteService.getChatSyncStatus(req.workspace!.workspaceId, req.workspace!.userId, threadId);
  const enabled = supabaseService.sharesBoard();
  res.json({
    enabled,
    state: !enabled ? 'local_only' : status.failed ? 'failed' : status.pending ? 'syncing' : 'synced',
    ...status
  });
}));

/** Explicitly retry this owner's queued chat changes after a visible sync error. */
chatRouter.post('/chat/sync/retry', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  const threadId = typeof req.body?.threadId === 'string' ? req.body.threadId : undefined;
  if (threadId && !requireEntityWorkspace(req, res, 'chat_threads', threadId)) return;
  const queued = retryChatSync(req.workspace!.workspaceId, req.workspace!.userId, threadId);
  res.json({ queued });
}));

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
chatRouter.get('/chat/threads', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  /**
   * The same conversations on the web as on the desktop that had them: the
   * desktop publishes each one under its owner's login, and the cloud reads
   * back only that login's. Answering agents is still the desktop's, but
   * reading what was said is not.
   */
  res.json(
    workspaceRegistry.scope(
      'chat_threads',
      await chatStore().listThreads(req.workspace!.workspaceId, req.workspace!.userId),
      req.workspace!.workspaceId
    )
  );
}));

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
chatRouter.post('/chat/threads', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  const id = typeof req.body?.id === 'string' ? req.body.id : undefined;

  const existing = id
    ? workspaceRegistry
        .scope('chat_threads', sqliteService.getChatThreads(req.workspace!.userId), req.workspace!.workspaceId)
        .find(t => t.id === id)
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
  const thread = createThreadAndShare({
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
chatRouter.put('/chat/threads/:id', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  const { projectId } = req.body ?? {};

  if (projectId !== null && typeof projectId !== 'string') {
    return res.status(400).json({ error: 'projectId must be a string or null' });
  }

  if (projectId && !requireProjectWorkspace(req, res, projectId)) return;

  const workspaceId = req.workspace!.workspaceId;
  const ownerId = req.workspace!.userId;
  const ownThreads = await chatStore().listThreads(workspaceId, ownerId);
  const current = ownThreads.find(thread => thread.id === req.params.id);
  if (!current) return res.status(404).json({ error: 'Thread not found' });

  if ((current.projectId ?? null) !== (projectId ?? null)) {
    const messages = await chatStore().messages(workspaceId, req.params.id, ownerId);
    if (messages?.length) {
      return res.status(409).json({
        error: 'This conversation already has messages. Start a new conversation to switch projects; the existing chat will stay saved.'
      });
    }
  }

  const updated = sqliteService.setChatThreadProject(req.params.id, projectId);
  if (!updated) return res.status(404).json({ error: 'Thread not found' });
  shareThread(updated);

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
 * A thread can point at one configured agent or none (Alpha's
 * automatic responder). The target is deliberately separate from `agentIds`:
 * that field is the participant history and must not make an old participant
 * answer every future message.
 */
chatRouter.put('/chat/threads/:id/target', desktopOnly, route(async (req: Request, res: Response) => {
  const { targetAgentId = null, targetSquadId = null } = req.body ?? {};

  if (targetAgentId !== null && typeof targetAgentId !== 'string') {
    return res.status(400).json({ error: 'targetAgentId must be a string or null' });
  }
  if (targetSquadId) {
    return res.status(410).json({ error: 'Squads were removed. Choose an agent, or leave the target empty so Alpha answers.' });
  }

  if (targetAgentId) {
    const agent = await agentStore().get(req.workspace!.workspaceId, targetAgentId);
    if (!agent || agent.isArchived) return res.status(404).json({ error: 'Agent not found or archived' });
  }

  // Clears any squad target an older version saved on this thread.
  const updated = sqliteService.setChatThreadTarget(req.params.id, targetAgentId, null);
  if (!updated) return res.status(404).json({ error: 'Thread not found' });
  shareThread(updated);
  return res.json(updated);
}));

/**
 * One conversation's messages, to whoever is having it.
 *
 * The workspace check alone was not enough: a thread id is minted by the
 * client, and any member who had one could read a colleague's prompts. The
 * store answers null for a thread that is not this caller's, which reads the
 * same as a thread that does not exist -- which is all they should learn.
 */
chatRouter.get('/chat/threads/:id/messages', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  const messages = await chatStore().messages(req.workspace!.workspaceId, req.params.id, req.workspace!.userId);
  if (!messages) return res.status(404).json({ error: 'Thread not found' });
  res.json(messages);
}));

/** Store one chat attachment in the desktop's private local data directory. */
chatRouter.post('/chat/threads/:id/attachments', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  if (!Buffer.isBuffer(req.body) || req.body.byteLength < 1 || req.body.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    return res.status(400).json({ error: 'Choose a file smaller than 10 MB.' });
  }
  let name = '';
  try { name = decodeURIComponent(String(req.headers['x-chat-file-name'] ?? '')); }
  catch { return res.status(400).json({ error: 'The file name could not be read.' }); }
  try {
    const attachment = await chatAttachmentService.upload({
      threadId: req.params.id, name,
      contentType: String(req.headers['x-chat-file-type'] ?? 'application/octet-stream'),
      bytes: req.body
    });
    res.status(201).json({ attachment });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'The attachment could not be saved.' });
  }
}));

chatRouter.delete('/chat/threads/:threadId/attachments/:attachmentId', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.threadId)) return;
  const removed = chatAttachmentService.deletePending(req.params.threadId, req.params.attachmentId);
  if (!removed) return res.status(404).json({ error: 'This attachment is already linked to a message or no longer exists.' });
  res.json({ success: true });
});

chatRouter.post('/chat/threads/:threadId/messages/:messageId/stop', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.threadId)) return;
  try { res.json(await chatService.stopTurn(req.params.threadId, req.params.messageId)); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'This chat turn could not be stopped.' }); }
}));

chatRouter.post('/chat/threads/:threadId/messages/:messageId/steer', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.threadId)) return;
  try {
    const result = chatService.steerTurn(req.params.threadId, req.params.messageId, String(req.body?.instruction ?? ''));
    res.json(result);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'This chat turn could not be steered.' }); }
}));

/**
 * The user's answer to how Alpha handled a message.
 *
 * `messageId` is the user's own message. `build` plans it with the
 * Orchestrator (Plan this build / Build this instead); `answer` withdraws an
 * unstarted plan and has Alpha answer it instead (Just answer / This was just
 * a question). Every server-side build check still applies.
 */
chatRouter.post('/chat/threads/:threadId/messages/:messageId/route', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  const { action, repositories, projectId } = req.body ?? {};
  if (action !== 'build' && action !== 'answer') {
    return res.status(400).json({ error: 'action must be build or answer' });
  }
  if (repositories !== undefined && (!Array.isArray(repositories) || repositories.length > 30 || repositories.some((item: unknown) => typeof item !== 'string' || !item.trim()))) {
    return res.status(400).json({ error: 'repositories must be a list of up to 30 repository names' });
  }
  if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
    return res.status(400).json({ error: 'projectId must be a string or omitted' });
  }
  if (req.workspace!.role === 'client') {
    return res.status(403).json({ error: 'Project builds are available to the internal project team.' });
  }
  const thread = sqliteService.getChatThreads().find(item => item.id === req.params.threadId);
  if (!thread || thread.ownerId !== req.workspace!.userId) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }
  if (projectId && thread.projectId && thread.projectId !== projectId) {
    return res.status(409).json({ error: 'This conversation is already attached to another project.' });
  }
  const scopedProjectId = thread.projectId ?? projectId ?? undefined;
  if (scopedProjectId && !requireProjectWorkspace(req, res, scopedProjectId)) return;
  if (!thread.projectId && scopedProjectId) {
    const scopedThread = sqliteService.setChatThreadProject(thread.id, scopedProjectId);
    if (!scopedThread) return res.status(404).json({ error: 'Conversation not found.' });
    shareThread(scopedThread);
  }
  try {
    const result = await chatService.routeMessage({
      threadId: thread.id,
      messageId: req.params.messageId,
      action,
      userId: req.workspace!.userId,
      routing: {
        context: req.workspace!,
        repositories: Array.isArray(repositories) ? [...new Set(repositories.map((item: string) => item.trim()))] : undefined,
        canBuild: workspaceRegistry.can(req.workspace!.role, 'agent.run')
      }
    });
    res.status(201).json(result);
  } catch (error) {
    const status = error instanceof ChatRouteError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Alpha could not update how this message is handled.' });
  }
}));

/**
 * Delete a conversation, or empty one.
 *
 * Neither existed. The UI has had a Delete and a Clear button since the chat
 * view was written, and both only ever changed React state — the rows stayed
 * in SQLite. That was invisible while hydration was also wiping the client's
 * copy, because a deleted thread came back empty and looked deleted.
 */
chatRouter.delete('/chat/threads/:id', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  const deleted = deleteThreadAndShare(req.params.id);
  if (deleted) await workspaceRegistry.unbind('chat_threads', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Thread not found' });
  res.json({ success: true });
}));

chatRouter.delete('/chat/threads/:id/messages', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.id)) return;
  const removed = clearMessagesAndShare(req.params.id);
  if (removed < 0) return res.status(404).json({ error: 'Thread not found' });
  res.json({ success: true, removed });
});

chatRouter.post('/chat/messages', desktopOnly, async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
    const { threadId, content, senderName, targetAgentId, targetSquadId, repository, repositories, projectId, intent, clientMessageId, attachmentIds, issueId } = req.body;
    if (typeof threadId !== 'string' || !threadId.trim() || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'threadId and content are required' });
    }
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId must be a string or omitted' });
    }
    if (intent !== undefined && !['auto', 'build', 'ask'].includes(intent)) {
      return res.status(400).json({ error: 'intent must be auto, build, or ask' });
    }
    if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !clientMessageId.trim() || clientMessageId.length > 200)) {
      return res.status(400).json({ error: 'clientMessageId must be a non-empty string of at most 200 characters' });
    }
    if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > 8 || attachmentIds.some((id: unknown) => typeof id !== 'string'))) {
      return res.status(400).json({ error: 'attachmentIds must be a list of up to 8 attachment ids' });
    }
    if (targetAgentId !== undefined && targetAgentId !== null && typeof targetAgentId !== 'string') {
      return res.status(400).json({ error: 'targetAgentId must be a string or null' });
    }
    if (targetSquadId) {
      return res.status(410).json({ error: 'Squads were removed. Mention an agent, or ask Alpha to build and the Orchestrator assigns agents per task.' });
    }
    if (issueId !== undefined && (typeof issueId !== 'string' || !issueId.trim() || issueId.length > 200)) {
      return res.status(400).json({ error: 'A task identifier is required and must be at most 200 characters' });
    }
    if (issueId && intent !== 'build') {
      return res.status(400).json({ error: 'A task can only be attached to a build request' });
    }
    if (repository !== undefined && repository !== null && typeof repository !== 'string') {
      return res.status(400).json({ error: 'repository must be a repository name or omitted' });
    }
    if (repositories !== undefined && (!Array.isArray(repositories) || repositories.length > 30 || repositories.some((item: unknown) => typeof item !== 'string' || !item.trim()))) {
      return res.status(400).json({ error: 'repositories must be a list of up to 30 repository names' });
    }
    const requestedRepositories = Array.isArray(repositories)
      ? [...new Set(repositories.map((item: string) => item.trim()))]
      : typeof repository === 'string' && repository.trim() ? [repository.trim()] : undefined;

    const existingThread = sqliteService.getChatThreads().find(thread => thread.id === threadId);
    if (existingThread && existingThread.ownerId !== req.workspace!.userId) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    if (existingThread?.projectId && projectId && existingThread.projectId !== projectId) {
      return res.status(409).json({ error: 'This conversation is already attached to another project.' });
    }
    const scopedProjectId = existingThread?.projectId ?? projectId ?? undefined;
    if (scopedProjectId && !requireProjectWorkspace(req, res, scopedProjectId)) return;
    if (issueId) {
      if (!scopedProjectId) return res.status(400).json({ error: "Choose the task's project before starting its build" });
      if (!requireEntityWorkspace(req, res, 'issues', issueId)) return;
    }
    if (existingThread && !existingThread.projectId && scopedProjectId) {
      const scopedThread = sqliteService.setChatThreadProject(threadId, scopedProjectId);
      if (!scopedThread) return res.status(404).json({ error: 'Conversation not found.' });
      shareThread(scopedThread);
    }

    /**
     * Alpha is the Orchestrator. An unaddressed message goes to Alpha, which
     * answers it or decides it is a build; `chatService` enforces every check
     * before a build starts. A direct @mention still goes to that agent.
     *
     * `/build` and `/ask` replace the old mode buttons as explicit overrides.
     * The `intent` field is still read for one release so an older desktop
     * renderer keeps working: `build` acts as `/build`, `ask` as `/ask`.
     */
    const isInternal = req.workspace!.role !== 'client';
    const override = parseChatOverride(content).override;
    const forcedBuild = intent === 'build' || override === 'build';
    const answerOnly = intent === 'ask' || override === 'ask';
    const buildRequest = isInternal && forcedBuild
      ? { context: req.workspace!, repositories: requestedRepositories, issueId: issueId || undefined }
      : undefined;
    const routing = isInternal && !buildRequest
      ? {
          context: req.workspace!,
          repositories: requestedRepositories,
          canBuild: workspaceRegistry.can(req.workspace!.role, 'agent.run'),
          answerOnly
        }
      : undefined;
    const result = await chatService.sendMessage({
      threadId,
      content,
      senderName,
      targetAgentId,
      projectId: scopedProjectId,
      clientMessageId,
      attachmentIds,
      workspaceId: req.workspace!.workspaceId,
      userId: req.workspace!.userId,
      buildRequest,
      routing
    });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to process chat message' });
  } finally {
    if (typeof req.body?.threadId === 'string' && typeof req.body?.clientMessageId === 'string') {
      chatService.finishTurn(req.body.threadId, req.body.clientMessageId);
    }
  }
});
