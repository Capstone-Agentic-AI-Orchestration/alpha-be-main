import { Request, Response, Router } from 'express';
import { runtimeRefreshService } from '../services/runtimeRefreshService.js';
import { IS_CLOUD } from '../config/env.js';
import { machineRuntimes } from '../services/machineRuntimes.js';
import { requireWorkspaceCapability } from './workspaceContext.js';
import { desktopOnly } from './desktopOnly.js';

export const runtimeRouter = Router();

runtimeRouter.get('/runtimes', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  const cached = machineRuntimes();
  // Empty in the cloud because there are none, not because nobody has looked.
  if (cached.length > 0 || IS_CLOUD) {
    return res.json(cached);
  }
  runtimeRefreshService.refresh(true).then(r => res.json(r)).catch(err => res.status(500).json({ error: err.message }));
});

runtimeRouter.post('/runtimes/scan', desktopOnly, async (req: Request, res: Response) => {
  try {
    const runtimes = await runtimeRefreshService.refresh(true);
    res.json(runtimes);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to scan runtimes' });
  }
});

runtimeRouter.post('/runtimes/:id/refresh', desktopOnly, async (req: Request, res: Response) => {
  try {
    const runtime = await runtimeRefreshService.refreshOne(req.params.id);
    res.json(runtime);
  } catch (err: any) {
    const message = err?.message || 'Failed to refresh runtime';
    res.status(message.startsWith('Unknown runtime:') ? 404 : 500).json({ error: message });
  }
});
