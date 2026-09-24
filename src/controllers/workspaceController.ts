import { Request, Response, Router } from 'express';

import { route } from './asyncRoute.js';
import { ALPHA_ORG } from '../config/env.js';
import { githubApi } from '../services/githubApi.js';
import { roleForTeamSlug } from '../services/identityService.js';
import { cloudRequest, refreshMemberships, usesCloudDirectory } from '../services/cloudWorkspaces.js';
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

/**
 * On a team's desktop, answer with the cloud's answer.
 *
 * Returns false when this is not a team desktop, and the route carries on
 * with its local answer. Otherwise the request goes to the same route in the
 * cloud, signed in as this desktop's GitHub account, and the cloud's status
 * and body come back unchanged -- so its permission checks are the ones that
 * count. `mirror` runs after a success, for the routes whose result this
 * machine keeps a copy of.
 */
async function relayToCloud(
  req: Request,
  res: Response,
  mirror?: (body: any) => unknown
): Promise<boolean> {
  if (!usesCloudDirectory()) return false;
  try {
    const answer = await cloudRequest(req.originalUrl.replace(/^\/api(?=\/)/, ''), {
      method: req.method,
      body: req.method === 'GET' || req.method === 'DELETE' ? undefined : req.body,
      workspaceId: req.workspace?.workspaceId
    });
    if (answer.status < 300 && mirror) await mirror(answer.body);
    res.status(answer.status).json(answer.body);
  } catch (err: any) {
    res.status(502).json({ error: `Could not reach the Alpha cloud: ${err?.message ?? err}` });
  }
  return true;
}

/**
 * The workspaces this caller belongs to. Not every workspace there is.
 *
 * On a team desktop, refreshed from the cloud first, so a workspace someone
 * put this developer in shows up without them doing anything. A cloud that
 * does not answer in time leaves the last copy in place.
 */
workspaceRouter.get(
  '/workspaces',
  route(async (req, res) => {
    const { userId, teamRole } = req.workspace!;
    if (usesCloudDirectory()) await refreshMemberships(userId);
    res.json(await workspaceRegistry.listForUser(userId, teamRole));
  })
);

type GitHubPerson = { login: string; avatar_url?: string };

/**
 * The organisation's teams that grant an Alpha role, with their people.
 *
 * Only role-granting teams: someone in no such team is refused at sign-in, so
 * putting them in a workspace gives it a member who can never open it. Read
 * as the caller, so a secret team they cannot see on GitHub stays hidden.
 */
async function readTeamRoster(): Promise<Array<{ slug: string; name: string; role: WorkspaceRole; people: GitHubPerson[] }>> {
  const all = await githubApi().getAll<{ slug: string; name: string }>(`/orgs/${ALPHA_ORG}/teams?per_page=100`);
  const roleTeams = all.flatMap(team => {
    const role = roleForTeamSlug(team.slug);
    return role ? [{ ...team, role }] : [];
  });
  return Promise.all(
    roleTeams.map(async team => ({
      slug: team.slug,
      name: team.name,
      role: team.role,
      people: await githubApi().getAll<GitHubPerson>(
        `/orgs/${ALPHA_ORG}/teams/${encodeURIComponent(team.slug)}/members?per_page=100`
      )
    }))
  );
}

/**
 * The teams, before there is a workspace to add them to.
 *
 * For the create form: a project manager picks the people as they name the
 * workspace, so it opens already staffed. Whoever may create a workspace may
 * read this; nobody else needs it.
 */
workspaceRouter.get(
  '/org/teams',
  route(async (req, res) => {
    const { teamRole } = req.workspace!;
    if (teamRole !== 'pm' && teamRole !== 'admin') {
      res.status(403).json({ error: 'Only a project manager or an admin can read the team roster.' });
      return;
    }
    if (await relayToCloud(req, res)) return;
    if (!ALPHA_ORG) {
      res.status(503).json({ error: 'No GitHub organisation is configured for this deployment.' });
      return;
    }

    try {
      const teams = await readTeamRoster();
      res.json(
        teams.map(team => ({
          slug: team.slug,
          name: team.name,
          role: team.role,
          members: team.people.map(person => ({ login: person.login, avatarUrl: person.avatar_url ?? null }))
        }))
      );
    } catch (err: any) {
      res.status(502).json({ error: `Could not read the ${ALPHA_ORG} teams: ${err?.message ?? err}` });
    }
  })
);

/**
 * Create a workspace: project managers and admins.
 *
 * Decided by the caller's GitHub team, not by their role in the workspace
 * they happen to have open. A project manager may promote someone to `pm`
 * inside their own workspace, so a workspace role is something a PM can hand
 * out -- and "may create workspaces" must not be. The `project-managers` and
 * `admins` teams are the organisation's decision.
 *
 * The creator joins at their team role, never above it. Making every creator
 * the new workspace's admin would let any project manager mint themselves
 * admin database claims by creating a workspace, which is exactly what the
 * `admins` team exists to decide.
 *
 * `members` staffs it in the same step: each person is in the workspace at
 * once, as with any add -- nothing to send them, nothing for them to accept.
 * Checked in full before anything is written, so a bad entry refuses the
 * whole request rather than leaving a half-staffed workspace behind.
 *
 * On a team desktop the workspace is made in the cloud, where the rest of the
 * team can see it, and this machine's copy is refreshed so it can be opened
 * straight away.
 */
workspaceRouter.post(
  '/workspaces',
  route(async (req, res) => {
    const { teamRole, userId } = req.workspace!;
    if (teamRole !== 'pm' && teamRole !== 'admin') {
      res.status(403).json({ error: 'Only a project manager or an admin can create a workspace.' });
      return;
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Workspace name is required' });
      return;
    }

    const requested: unknown[] = Array.isArray(req.body?.members) ? req.body.members : [];
    const members = new Map<string, { userId: string; role: WorkspaceRole }>();
    for (const entry of requested) {
      const login = typeof (entry as any)?.userId === 'string' ? (entry as any).userId.trim() : '';
      const role = (entry as any)?.role;
      if (!login || !ROLES.includes(role)) {
        res.status(400).json({ error: `Each member needs a userId and a role of ${ROLES.join(', ')}.` });
        return;
      }
      if (role === 'admin' && teamRole !== 'admin') {
        res.status(403).json({ error: 'Only an admin can make someone an admin of this workspace.' });
        return;
      }
      // The creator is already in it, at their team role.
      if (login.toLowerCase() !== userId.toLowerCase()) members.set(login.toLowerCase(), { userId: login, role });
    }

    if (await relayToCloud(req, res, () => refreshMemberships(userId, 30_000))) return;

    const workspace = await workspaceRegistry.createWorkspace(
      userId,
      { name, slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined },
      teamRole
    );
    await seedRoster(workspace.id, workspace.name);
    for (const member of members.values()) {
      await workspaceRegistry.addMember(workspace.id, member.userId, member.role);
    }
    res.status(201).json({ ...workspace, memberCount: workspace.memberCount + members.size });
  })
);

workspaceRouter.put(
  '/workspaces/:id',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.manage_settings')) return;
    if (await relayToCloud(req, res, () => refreshMemberships(req.workspace!.userId, 30_000))) return;

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
    if (await relayToCloud(req, res)) return;

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
    if (await relayToCloud(req, res)) return;
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

/**
 * The organisation's teams that grant an Alpha role, with their people.
 *
 * What a project manager staffing a workspace actually thinks in: "the
 * developers", not a flat list of logins. Only teams that map to a role are
 * listed -- someone in no such team is refused at sign-in, so adding them to a
 * workspace would put a name on it that can never open it.
 *
 * Read as the caller, so a secret team they cannot see on GitHub is not shown
 * to them here either. Each person says whether they are already in this
 * workspace and as what, so the list doubles as a view of who is missing.
 */
workspaceRouter.get(
  '/workspaces/:id/members/teams',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;
    if (await relayToCloud(req, res)) return;
    if (!ALPHA_ORG) {
      res.status(503).json({ error: 'No GitHub organisation is configured for this deployment.' });
      return;
    }

    let teams: Awaited<ReturnType<typeof readTeamRoster>>;
    try {
      teams = await readTeamRoster();
    } catch (err: any) {
      res.status(502).json({ error: `Could not read the ${ALPHA_ORG} teams: ${err?.message ?? err}` });
      return;
    }

    const here = new Map(
      (await workspaceRegistry.listMembers(req.params.id))
        .filter(member => member.status === 'active')
        .map(member => [member.userId.toLowerCase(), member.role])
    );
    res.json(
      teams.map(team => ({
        slug: team.slug,
        name: team.name,
        role: team.role,
        members: team.people.map(person => ({
          login: person.login,
          avatarUrl: person.avatar_url ?? null,
          workspaceRole: here.get(person.login.toLowerCase()) ?? null
        }))
      }))
    );
  })
);

workspaceRouter.get(
  '/workspaces/:id/members',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.read_members')) return;
    if (await relayToCloud(req, res)) return;
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
    if (await relayToCloud(req, res)) return;

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
    if (await relayToCloud(req, res)) return;
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
    // Kept here as well: this machine's own checks read the local copy.
    const { id, projectId, userId } = req.params;
    if (await relayToCloud(req, res, () => workspaceRegistry.assignProject(id, projectId, userId))) return;
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
    const { id, projectId, userId } = req.params;
    if (await relayToCloud(req, res, () => workspaceRegistry.removeProjectAssignment(id, projectId, userId))) return;

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
