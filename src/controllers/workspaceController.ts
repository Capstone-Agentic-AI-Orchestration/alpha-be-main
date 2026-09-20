import { Request, Response, Router } from 'express';
import { currentIdentity } from '../services/identityService.js';
import { requireWorkspaceCapability } from './workspaceContext.js';
import {
  WorkspaceMemberStatus,
  WorkspaceRole,
  workspaceRegistry
} from '../services/workspaceRegistry.js';

export const workspaceRouter = Router();

workspaceRouter.get('/workspaces', async (_req: Request, res: Response) => {
  try {
    const identity = await currentIdentity();
    if (identity.access === 'no_team') {
      return res.status(403).json({ error: 'Your account is not a member of an Alpha workspace.' });
    }
    res.json(workspaceRegistry.listForUser(identity.login, identity.role as WorkspaceRole | undefined));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Could not load workspaces.' });
  }
});

workspaceRouter.post('/workspaces', async (req: Request, res: Response) => {
  try {
    const identity = await currentIdentity();
    const workspace = workspaceRegistry.createWorkspace(identity.login, {
      name: String(req.body?.name ?? ''),
      slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined
    });
    res.status(201).json(workspace);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Could not create workspace.' });
  }
});

workspaceRouter.post('/workspaces/join', async (req: Request, res: Response) => {
  try {
    const identity = await currentIdentity();
    const workspace = workspaceRegistry.joinWorkspace(identity.login, String(req.body?.code ?? ''), 'dev');
    res.status(200).json(workspace);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Could not join workspace.' });
  }
});

workspaceRouter.get('/workspaces/:id', (req: Request, res: Response) => {
  if (!req.workspace || req.workspace.workspaceId !== req.params.id) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  res.json(req.workspace.workspace);
});

workspaceRouter.patch('/workspaces/:id', (req: Request, res: Response) => {
  if (!req.workspace || req.workspace.workspaceId !== req.params.id) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  if (!requireWorkspaceCapability(req, res, 'workspace.manage_settings')) return;
  try {
    const updated = workspaceRegistry.updateWorkspace(req.params.id, {
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined
    });
    if (!updated) return res.status(404).json({ error: 'Workspace not found.' });
    res.json({ ...updated, role: req.workspace.role });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Could not update workspace.' });
  }
});

workspaceRouter.get('/workspaces/:id/members', (req: Request, res: Response) => {
  if (!req.workspace || req.workspace.workspaceId !== req.params.id) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  if (!requireWorkspaceCapability(req, res, 'workspace.read_members')) return;
  res.json(workspaceRegistry.listMembers(req.params.id));
});

workspaceRouter.patch('/workspaces/:id/members/:memberId', (req: Request, res: Response) => {
  if (!req.workspace || req.workspace.workspaceId !== req.params.id) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;

  const role = req.body?.role as WorkspaceRole | undefined;
  const status = req.body?.status as WorkspaceMemberStatus | undefined;
  if (role && !['client', 'dev', 'pm', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid workspace role.' });
  }
  if (status && !['invited', 'active', 'suspended', 'removed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid workspace member status.' });
  }

  const updated = workspaceRegistry.updateMember(req.params.id, req.params.memberId, { role, status });
  if (!updated) return res.status(404).json({ error: 'Workspace member not found.' });
  res.json(updated);
});

workspaceRouter.get('/workspaces/:id/projects/:projectId/assignments', (req: Request, res: Response) => {
  if (!req.workspace || req.workspace.workspaceId !== req.params.id) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  if (!requireWorkspaceCapability(req, res, 'workspace.read_members')) return;
  const project = workspaceRegistry.belongsTo('projects', req.params.projectId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found in the active workspace.' });
  res.json(workspaceRegistry.listProjectAssignments(req.params.id, req.params.projectId));
});

workspaceRouter.put('/workspaces/:id/projects/:projectId/assignments/:userId', (req: Request, res: Response) => {
  if (!req.workspace || req.workspace.workspaceId !== req.params.id) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;
  if (!workspaceRegistry.belongsTo('projects', req.params.projectId, req.params.id)) {
    return res.status(404).json({ error: 'Project not found in the active workspace.' });
  }
  res.status(201).json(workspaceRegistry.assignProject(req.params.id, req.params.projectId, req.params.userId));
});

workspaceRouter.delete('/workspaces/:id/projects/:projectId/assignments/:userId', (req: Request, res: Response) => {
  if (!req.workspace || req.workspace.workspaceId !== req.params.id) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;
  const removed = workspaceRegistry.removeProjectAssignment(req.params.id, req.params.projectId, req.params.userId);
  if (!removed) return res.status(404).json({ error: 'Project assignment not found.' });
  res.json({ success: true });
});
