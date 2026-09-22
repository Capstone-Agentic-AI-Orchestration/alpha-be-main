import { Request, Response, Router } from 'express';

import { route } from './asyncRoute.js';
import { sqliteService } from '../services/sqliteService.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import type { WorkspaceMemberStatus, WorkspaceRole } from '../services/workspaceRegistry.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

/**
 * Workspaces, their members, and who is assigned to what.
 *
 * These routes used to read and write `sqliteService`'s workspace table
 * directly, which knows nothing about membership. That made every one of them
 * wrong in the same way:
 *
 *  - listing returned **every** workspace on the deployment, to anyone;
 *  - creating one was reachable **without signing in at all**, because the
 *    public-path allowlist matches on path and `/workspaces` was on it, so the
 *    exemption meant for the browser's "which workspaces do I have" call
 *    covered POST as well. Each anonymous call seeded a workspace with a full
 *    agent roster;
 *  - the workspace it created had no members, so nobody -- its creator
 *    included -- could then open it: `resolve()` finds no membership and
 *    answers 403.
 *
 * Nothing persisted on Render, so it read as a quirk rather than as the hole
 * it is. It stops being ephemeral the moment workspaces live in Postgres.
 *
 * Every route below goes through the directory, which is the thing that knows
 * about membership, and states the role it requires.
 */
export const workspaceRouter = Router();

const ROLES: readonly WorkspaceRole[] = ['client', 'dev', 'pm', 'admin'];
const STATUSES: readonly WorkspaceMemberStatus[] = ['invited', 'active', 'suspended', 'removed'];

/**
 * A member route may only touch the workspace this request is scoped to.
 *
 * The id in the path would otherwise be an invitation to read another
 * workspace's membership by editing the URL: the caller's role is resolved
 * for their *active* workspace, not for the one they named.
 */
function sameWorkspace(req: Request, res: Response): boolean {
  if (req.params.id !== req.workspace!.workspaceId) {
    res.status(404).json({ error: 'Workspace not found.' });
    return false;
  }
  return true;
}

/** The workspaces this caller belongs to. Not every workspace there is. */
workspaceRouter.get(
  '/workspaces',
  route(async (req, res) => {
    const { userId, teamRole } = req.workspace!;
    res.json(await workspaceRegistry.listForUser(userId, teamRole));
  })
);

/**
 * Create a workspace, as its first admin.
 *
 * Admins only. A workspace's creator becomes its administrator, and the
 * database token minted for them there carries that role -- so "anyone may
 * create one" is also "anyone may hold admin claims somewhere".
 */
workspaceRouter.post(
  '/workspaces',
  route(async (req, res) => {
    if (req.workspace!.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin can create a workspace.' });
      return;
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Workspace name is required' });
      return;
    }

    const workspace = await workspaceRegistry.createWorkspace(req.workspace!.userId, {
      name,
      slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined
    });
    // The agents and squad a new workspace starts with; the row itself is the
    // directory's.
    sqliteService.seedWorkspace(workspace.id, workspace.name);
    res.status(201).json(workspace);
  })
);

/**
 * Join by invite code.
 *
 * The code only: the slug and the id are visible to anyone who can see the
 * workspace at all, and accepting those would have made every workspace open
 * to every signed-in account. A membership an admin suspended or removed is
 * not revived by an old code either.
 */
workspaceRouter.post(
  '/workspaces/join',
  route(async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code) {
      res.status(400).json({ error: 'An invite code is required' });
      return;
    }

    const { userId, teamRole, role } = req.workspace!;
    res.json(await workspaceRegistry.joinWorkspace(userId, code, teamRole ?? role));
  })
);

workspaceRouter.put(
  '/workspaces/:id',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.manage_settings')) return;

    const updated = await workspaceRegistry.updateWorkspace(
      req.params.id,
      { name: req.body?.name, slug: req.body?.slug },
      req.workspace!.role
    );
    if (!updated) {
      res.status(404).json({ error: 'Workspace not found or invalid update' });
      return;
    }
    res.json(updated);
  })
);

workspaceRouter.get(
  '/workspaces/:id/members',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.read_members')) return;
    res.json(await workspaceRegistry.listMembers(req.params.id));
  })
);

/** Change someone's role or suspend them. Admins only. */
workspaceRouter.patch(
  '/workspaces/:id/members/:memberId',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;

    const role = req.body?.role;
    const status = req.body?.status;
    if (role !== undefined && !ROLES.includes(role)) {
      res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
      return;
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }

    const updated = await workspaceRegistry.updateMember(req.params.id, req.params.memberId, { role, status });
    if (!updated) {
      res.status(404).json({ error: 'Member not found in this workspace.' });
      return;
    }
    res.json(updated);
  })
);

workspaceRouter.get(
  '/workspaces/:id/projects/:projectId/assignments',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.read_members')) return;
    if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
    res.json(await workspaceRegistry.listProjectAssignments(req.params.id, req.params.projectId));
  })
);

/**
 * Assign someone to a project.
 *
 * What a developer or client can see at all: everything project-scoped reads
 * these rows, so managing them is `project.manage` -- a PM or an admin.
 */
workspaceRouter.put(
  '/workspaces/:id/projects/:projectId/assignments/:userId',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
    if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
    res
      .status(201)
      .json(await workspaceRegistry.assignProject(req.params.id, req.params.projectId, req.params.userId));
  })
);

workspaceRouter.delete(
  '/workspaces/:id/projects/:projectId/assignments/:userId',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'project.manage')) return;
    if (!requireProjectWorkspace(req, res, req.params.projectId)) return;

    const removed = await workspaceRegistry.removeProjectAssignment(
      req.params.id,
      req.params.projectId,
      req.params.userId
    );
    if (!removed) {
      res.status(404).json({ error: 'That person is not assigned to this project.' });
      return;
    }
    res.json({ success: true });
  })
);
