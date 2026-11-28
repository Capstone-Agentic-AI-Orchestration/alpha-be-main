import { Router, type Request, type Response } from 'express';

import { IS_CLOUD } from '../config/env.js';
import { route } from './asyncRoute.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { database } from '../store/database.js';
import { clientRequestBriefsFromDatabase, validIssueIds } from '../services/clientRequestBriefs.js';

/**
 * GET /projects/:id/client-request-briefs?issues=<id,id>
 *
 * The client requests behind the given tasks: reference, title and the
 * client's description, for a desktop build's planner. The team only -- a
 * client reads their own requests through the portal -- and only requests on
 * this project. Cloud only; a desktop calls the cloud for it.
 */
export const clientRequestBriefRouter = Router();

clientRequestBriefRouter.get('/projects/:id/client-request-briefs', route(async (req: Request, res: Response) => {
  if (!IS_CLOUD) return res.status(404).json({ error: 'Client requests are read from the cloud.' });
  if (!requireWorkspaceCapability(req, res, 'project.read')) return;
  if (req.workspace?.role === 'client') return res.status(403).json({ error: 'Client requests are shared with the project team only.' });
  if (!requireProjectWorkspace(req, res, req.params.id)) return;
  const issueIds = validIssueIds(req.query.issues);
  if (!issueIds) return res.status(400).json({ error: 'List up to 20 task ids in "issues".' });
  res.setHeader('Cache-Control', 'no-store, private');
  return res.json({ items: await clientRequestBriefsFromDatabase(database(), req.workspace!.workspaceId, req.params.id, issueIds) });
}));
