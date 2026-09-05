import { Request, Response, Router } from 'express';
import { chatService } from '../services/chatService.js';
import { sqliteService } from '../services/sqliteService.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';

export const chatRouter = Router();

chatRouter.get('/chat/threads', (req: Request, res: Response) => {
  res.json(sqliteService.getChatThreads());
});

chatRouter.post('/chat/threads', (req: Request, res: Response) => {
  const thread = sqliteService.createChatThread(req.body);
  res.status(201).json(thread);
});

/**
 * Point a conversation at a project — the directory its agents will inspect.
 *
 * Separate from the message route because it changes what an agent can see,
 * not what it was told. `projectId: null` clears it and returns the thread to
 * the managed workspace root.
 */
chatRouter.put('/chat/threads/:id', (req: Request, res: Response) => {
  const { projectId } = req.body ?? {};

  if (projectId !== null && typeof projectId !== 'string') {
    return res.status(400).json({ error: 'projectId must be a string or null' });
  }

  if (projectId && !sqliteService.getProjects().some(p => p.id === projectId)) {
    return res.status(404).json({ error: `No project with id "${projectId}"` });
  }

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
    ? sqliteService.getProjects().find(p => p.id === projectId)
    : undefined;
  const workspace = project ? resolveProjectWorkspace(project) : null;

  res.json({
    ...updated,
    workspaceDir: workspace?.dir ?? null,
    workspaceManaged: workspace?.managed ?? null
  });
});

chatRouter.get('/chat/threads/:id/messages', (req: Request, res: Response) => {
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
chatRouter.delete('/chat/threads/:id', (req: Request, res: Response) => {
  const deleted = sqliteService.deleteChatThread(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Thread not found' });
  res.json({ success: true });
});

chatRouter.delete('/chat/threads/:id/messages', (req: Request, res: Response) => {
  const removed = sqliteService.clearChatMessages(req.params.id);
  if (removed < 0) return res.status(404).json({ error: 'Thread not found' });
  res.json({ success: true, removed });
});

chatRouter.post('/chat/messages', async (req: Request, res: Response) => {
  try {
    const { threadId, content, senderName } = req.body;
    if (!threadId || !content) {
      return res.status(400).json({ error: 'threadId and content are required' });
    }
    const result = await chatService.sendMessage({ threadId, content, senderName });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to process chat message' });
  }
});
