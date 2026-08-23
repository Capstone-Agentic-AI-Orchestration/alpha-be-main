import { Request, Response, Router } from 'express';
import { runnerService } from '../services/runnerService.js';
import { sqliteService } from '../services/sqliteService.js';

export const runRouter = Router();

runRouter.get('/runs', (req: Request, res: Response) => {
  res.json(sqliteService.getPrototypeRuns());
});

runRouter.post('/runs/start', async (req: Request, res: Response) => {
  try {
    const { issueId, agentId, plan, scenario } = req.body;
    if (!issueId || !agentId) {
      return res.status(400).json({ error: 'issueId and agentId are required' });
    }
    const run = await runnerService.startRun({
      issueId,
      agentId,
      plan: plan || [],
      scenario
    });
    res.status(201).json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to start run' });
  }
});

runRouter.post('/runs/:id/cancel', async (req: Request, res: Response) => {
  try {
    await runnerService.cancelRun(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to cancel run' });
  }
});

runRouter.post('/runs/:id/retry', async (req: Request, res: Response) => {
  try {
    const existing = sqliteService.getPrototypeRuns().find(r => r.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Run not found' });

    const newRun = await runnerService.startRun({
      issueId: existing.issueId,
      agentId: existing.agentId,
      plan: existing.plan,
      scenario: 'success'
    });
    res.status(201).json(newRun);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to retry run' });
  }
});
