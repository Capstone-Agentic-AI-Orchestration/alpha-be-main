import { Router } from 'express';
import { route } from './asyncRoute.js';
import { desktopOnly } from './desktopOnly.js';
import { requireWorkspaceCapability } from './workspaceContext.js';
import { localPreviewService } from '../services/localPreviewService.js';
export const localPreviewRouter = Router();
localPreviewRouter.get('/chat/threads/:id/previews', desktopOnly, route(async (req, res) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  try { res.json(await localPreviewService.list(req.workspace!, req.params.id)); }
  catch (error) { res.status(403).json({ error: (error as Error).message }); }
}));
localPreviewRouter.post('/chat/threads/:id/previews', desktopOnly, route(async (req, res) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  const repository = req.body?.repository;
  if (repository !== undefined && (typeof repository !== 'string' || repository.length > 200)) return res.status(400).json({ error: 'Invalid repository.' });
  try { res.status(202).json(await localPreviewService.start(req.workspace!, req.params.id, repository)); }
  catch (error) { res.status(409).json({ error: (error as Error).message }); }
}));
localPreviewRouter.post('/chat/threads/:id/previews/:previewId/stop', desktopOnly, route(async (req, res) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  try { await localPreviewService.stop(req.workspace!, req.params.id, req.params.previewId); res.json({ stopped: true }); }
  catch (error) { res.status(404).json({ error: (error as Error).message }); }
}));
