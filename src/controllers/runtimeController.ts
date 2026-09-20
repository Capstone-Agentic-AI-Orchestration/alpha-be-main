import { Request, Response, Router } from 'express';
import { runtimeService } from '../services/runtimeService.js';
import { sqliteService } from '../services/sqliteService.js';
import { requireWorkspaceCapability } from './workspaceContext.js';

export const runtimeRouter = Router();

runtimeRouter.get('/runtimes', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  const cached = sqliteService.getRuntimes();
  if (cached.length > 0) {
    return res.json(cached);
  }
  runtimeService.scanRuntimes().then(r => res.json(r)).catch(err => res.status(500).json({ error: err.message }));
});

runtimeRouter.post('/runtimes/scan', async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'agent.manage')) return;
    const runtimes = await runtimeService.scanRuntimes();
    res.json(runtimes);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to scan runtimes' });
  }
});
