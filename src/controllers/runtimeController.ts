import { Request, Response, Router } from 'express';
import { runtimeRefreshService } from '../services/runtimeRefreshService.js';
import { IS_CLOUD } from '../config/env.js';
import { machineRuntimes } from '../services/machineRuntimes.js';
import { requireWorkspaceCapability } from './workspaceContext.js';
import { desktopOnly } from './desktopOnly.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { withRuntimeIsolation } from '../services/runtimeIsolation.js';
import { codexAlphaSignIn } from '../services/codexAlphaSignIn.js';

export const runtimeRouter = Router();

runtimeRouter.get('/runtimes', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  const cached = machineRuntimes();
  // Empty in the cloud because there are none, not because nobody has looked.
  if (cached.length > 0 || IS_CLOUD) {
    return res.json(IS_CLOUD ? cached : withRuntimeIsolation(cached));
  }
  // Runtime discovery is an execution-side capability. A PM may inspect a
  // cached catalog, but an empty catalog must not trigger a host scan.
  if (!workspaceRegistry.can(req.workspace!.role, 'agent.run')) {
    return res.json([]);
  }
  runtimeRefreshService.refresh(true).then(r => res.json(withRuntimeIsolation(r))).catch(err => res.status(500).json({ error: err.message }));
});

runtimeRouter.post('/runtimes/scan', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  try {
    const runtimes = await runtimeRefreshService.refresh(true);
    res.json(withRuntimeIsolation(runtimes));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to scan runtimes' });
  }
});

runtimeRouter.post('/runtimes/:id/refresh', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  try {
    const runtime = await runtimeRefreshService.refreshOne(req.params.id);
    res.json(withRuntimeIsolation([runtime])[0]);
  } catch (err: any) {
    const message = err?.message || 'Failed to refresh runtime';
    res.status(message.startsWith('Unknown runtime:') ? 404 : 500).json({ error: message });
  }
});

/*
 * Codex sign-in for Alpha: Codex agents then run from Alpha's own Codex home,
 * without the operator's personal instructions, skills or memories.
 */
runtimeRouter.get('/runtimes/codex/alpha-sign-in', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  res.json(codexAlphaSignIn.current());
});

runtimeRouter.post('/runtimes/codex/alpha-sign-in', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  const state = await codexAlphaSignIn.start(() => { void runtimeRefreshService.refreshOne('codex').catch(() => undefined); });
  res.status(state.status === 'failed' ? 502 : 200).json(state);
});

runtimeRouter.delete('/runtimes/codex/alpha-sign-in', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  res.json(codexAlphaSignIn.cancel());
});

runtimeRouter.post('/runtimes/codex/alpha-sign-out', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
  const state = await codexAlphaSignIn.signOut();
  void runtimeRefreshService.refreshOne('codex').catch(() => undefined);
  res.json(state);
});
