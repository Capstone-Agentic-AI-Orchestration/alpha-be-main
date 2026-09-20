import { Request, Response, Router } from 'express';
import { sqliteService } from '../services/sqliteService.js';

export const workspaceRouter = Router();

/** Workspaces are intentionally not scoped by the active workspace header. */
workspaceRouter.get('/workspaces', (_req: Request, res: Response) => {
  res.json(sqliteService.getWorkspaces());
});

workspaceRouter.post('/workspaces', (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Workspace name is required' });

  const workspace = sqliteService.createWorkspace({
    name,
    slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined,
    organization: typeof req.body?.organization === 'string' ? req.body.organization : undefined
  });
  res.status(201).json(workspace);
});

workspaceRouter.put('/workspaces/:id', (req: Request, res: Response) => {
  const updated = sqliteService.updateWorkspace(req.params.id, {
    name: req.body?.name,
    slug: req.body?.slug,
    organization: req.body?.organization
  });
  if (!updated) return res.status(404).json({ error: 'Workspace not found or invalid update' });
  res.json(updated);
});
