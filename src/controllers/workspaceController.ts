import { Request, Response, Router } from 'express';

import { route } from './asyncRoute.js';
import { ALPHA_ORG } from '../config/env.js';
import { githubApi } from '../services/githubApi.js';
import { agentStore, squadStore } from '../store/stores.js';
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

/**
 * The agents and squad a new workspace starts with.
 *
 * Through the stores, so a cloud workspace gets its roster in Postgres and a
 * desktop one in SQLite. Projects and issues stay empty on purpose: those are
 * the owner's work, not product seed data.
 */
export async function seedRoster(workspaceId: string, name: string): Promise<void> {
  await agentStore().ensureOfficial(workspaceId);
  await squadStore().create(workspaceId, await coreSquad(workspaceId, `squad-${workspaceId}`, name));
}

/**
 * The default workspace's roster, on every boot.
 *
 * Nothing else creates it: a workspace made through the API is seeded as it
 * is made, but the default one is the directory's, and the directory makes it
 * as a bare row. Idempotent throughout -- the official agents are keyed on
 * their template, and the core squad is created only if it is not there --
 * so a boot that has run before adds nothing.
 *
 * The row comes first. Every agent and squad has a foreign key to its
 * workspace, and this used to run before anything had created the default
 * one, so it failed that key and left the workspace everyone lands in with no
 * agents at all.
 */
export async function seedDefaultWorkspace(): Promise<void> {
  const workspaceId = workspaceRegistry.getDefaultWorkspaceId();
  await workspaceRegistry.ensureDefaultWorkspace();
  await agentStore().ensureOfficial(workspaceId);
  // `squad-core` is the id the desktop's own default squad has always had.
  if (!(await squadStore().get(workspaceId, 'squad-core'))) {
    await squadStore().create(workspaceId, await coreSquad(workspaceId, 'squad-core', 'Alpha'));
  }
}

async function coreSquad(workspaceId: string, id: string, name: string) {
  const agents = await agentStore().list(workspaceId);
  return {
    id,
    name: `${name} Core Squad`,
    description: 'Official Alpha roles working in sequence.',
    avatar: '◈',
    color: '#6366f1',
    topology: 'Sequential' as const,
    leaderAgentId: agents.find(agent => agent.role === 'Manager Agent')?.id ?? agents[0]?.id,
    memberAgentIds: agents.map(agent => agent.id),
    mission: 'Research, plan, build, review, and validate approved project work.',
    activeRunsCount: 0,
    completedRunsCount: 0
  };
}

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
    await seedRoster(workspace.id, workspace.name);
    res.status(201).json(workspace);
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

/**
 * Put someone in this workspace, now.
 *
 * Not an invite: a project manager staffing their workspace knows who they
 * want, and a code they have to pass along -- which the person then has to
 * find, paste and accept -- is a step that exists for strangers. The person
 * finds the workspace waiting at their next sign-in.
 *
 * Granting `admin` stays an admin's to do. A project manager may staff their
 * workspace with developers, managers and clients; making someone an
 * administrator of it is the one thing that would let them hand out the
 * database claims an admin carries.
 */
workspaceRouter.post(
  '/workspaces/:id/members',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;

    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    const role = req.body?.role;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    if (!ROLES.includes(role)) {
      res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
      return;
    }
    if (role === 'admin' && req.workspace!.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin can make someone an admin of this workspace.' });
      return;
    }

    res.status(201).json(await workspaceRegistry.addMember(req.params.id, userId, role));
  })
);

/**
 * Who there is to add: the organisation's people, minus this workspace's.
 *
 * Read as the caller, so it lists the members they can see on GitHub and no
 * more. Without it, staffing a workspace means typing logins exactly right.
 */
workspaceRouter.get(
  '/workspaces/:id/members/candidates',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;
    if (!ALPHA_ORG) {
      res.status(503).json({ error: 'No GitHub organisation is configured for this deployment.' });
      return;
    }

    let people: Array<{ login: string; avatar_url?: string }>;
    try {
      people = await githubApi().getAll(`/orgs/${ALPHA_ORG}/members?per_page=100`);
    } catch (err: any) {
      res.status(502).json({ error: `Could not read the ${ALPHA_ORG} members: ${err?.message ?? err}` });
      return;
    }

    const taken = new Set(
      (await workspaceRegistry.listMembers(req.params.id))
        .filter(member => member.status === 'active')
        .map(member => member.userId.toLowerCase())
    );
    res.json(
      people
        .filter(person => !taken.has(person.login.toLowerCase()))
        .map(person => ({ login: person.login, avatarUrl: person.avatar_url ?? null }))
    );
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
