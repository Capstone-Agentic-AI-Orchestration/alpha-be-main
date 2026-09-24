import { Request, Response, Router } from 'express';

import { route } from './asyncRoute.js';
import { ALPHA_ORG } from '../config/env.js';
import { githubApi } from '../services/githubApi.js';
import { roleForTeamSlug, roleFromTeams, type TeamMembership } from '../services/identityService.js';
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

type GitHubOrganizationMember = {
  login?: string;
  avatar_url?: string | null;
};

type GitHubOrganizationTeam = {
  slug?: string;
};

type GitHubTeamMember = {
  login?: string;
};

type WorkspaceMemberCandidate = {
  login: string;
  avatarUrl: string | null;
  /** The Alpha role implied by the person's GitHub organization teams. */
  role: WorkspaceRole | null;
  /** Team slugs are returned so the UI can show why a role was detected. */
  teams: string[];
  /** Unknown teams are different from a failed team lookup. */
  roleSource: 'github_team' | 'unassigned' | 'unavailable';
};

/**
 * Resolve organization members to Alpha roles from their GitHub teams.
 *
 * GitHub's organization member endpoint does not include team membership, so
 * the directory is assembled from the organization teams and each team's
 * members. A missing or restricted team endpoint must never turn into a
 * silent developer default; those candidates remain available for an explicit
 * role choice and are marked as unavailable to the UI.
 */
async function withOrganizationRoles(
  organization: string,
  people: GitHubOrganizationMember[]
): Promise<WorkspaceMemberCandidate[]> {
  const candidates = new Map<string, WorkspaceMemberCandidate>();
  for (const person of people) {
    const login = typeof person.login === 'string' ? person.login.trim() : '';
    if (!login) continue;
    candidates.set(login.toLowerCase(), {
      login,
      avatarUrl: typeof person.avatar_url === 'string' ? person.avatar_url : null,
      role: null,
      teams: [],
      roleSource: 'unassigned'
    });
  }

  let teamLookupFailed = false;
  try {
    const teams = await githubApi().getAll<GitHubOrganizationTeam>(
      `/orgs/${encodeURIComponent(organization)}/teams?per_page=100`
    );

    // Keep the requests bounded to one per team and preserve all team slugs so
    // an unrecognised team is still visible to a PM choosing a role manually.
    await Promise.all(
      teams.map(async team => {
        const slug = typeof team.slug === 'string' ? team.slug.trim() : '';
        if (!slug) return;
        try {
          const members = await githubApi().getAll<GitHubTeamMember>(
            `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(slug)}/members?per_page=100`
          );
          for (const member of members) {
            const login = typeof member.login === 'string' ? member.login.trim() : '';
            const candidate = candidates.get(login.toLowerCase());
            if (!candidate) continue;
            if (!candidate.teams.includes(slug)) candidate.teams.push(slug);
          }
        } catch {
          // One private/restricted team should not hide every other org member.
          teamLookupFailed = true;
        }
      })
    );
  } catch {
    teamLookupFailed = true;
  }

  return Array.from(candidates.values()).map(candidate => {
    candidate.teams.sort((a, b) => a.localeCompare(b));
    const memberships: TeamMembership[] = candidate.teams.map(slug => ({ org: organization, slug }));
    const role = roleFromTeams(memberships, organization) as WorkspaceRole | undefined;
    return {
      ...candidate,
      role: role ?? null,
      roleSource: role ? 'github_team' : teamLookupFailed ? 'unavailable' : 'unassigned'
    };
  });
}

type OrganizationTeamRoster = {
  slug: string;
  name: string;
  role: WorkspaceRole;
  people: Array<{ login: string; avatar_url?: string | null }>;
};

/**
 * Read the role-granting GitHub teams and their people once for team-based
 * staffing surfaces. Unmapped teams are intentionally omitted: they cannot
 * grant an Alpha role and would make the picker imply access it cannot give.
 */
async function readTeamRoster(organization: string): Promise<OrganizationTeamRoster[]> {
  const all = await githubApi().getAll<GitHubOrganizationTeam & { name?: string }>(
    `/orgs/${encodeURIComponent(organization)}/teams?per_page=100`
  );
  const roleTeams = all.flatMap(team => {
    const slug = typeof team.slug === 'string' ? team.slug.trim() : '';
    const role = slug ? roleForTeamSlug(slug) : undefined;
    return role ? [{ slug, name: typeof team.name === 'string' && team.name.trim() ? team.name.trim() : slug, role }] : [];
  });

  return Promise.all(
    roleTeams.map(async team => ({
      ...team,
      people: await githubApi().getAll<{ login: string; avatar_url?: string | null }>(
        `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(team.slug)}/members?per_page=100`
      )
    }))
  );
}

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
 * The role-granting teams available while a workspace is being created.
 *
 * This is read as the caller, so GitHub's own visibility rules still apply.
 * Only administrators and project managers may see the staffing roster.
 */
workspaceRouter.get(
  '/org/teams',
  route(async (req, res) => {
    const teamRole = req.workspace!.teamRole ?? req.workspace!.role;
    if (teamRole !== 'pm' && teamRole !== 'admin') {
      res.status(403).json({ error: 'Only an admin or project manager can read the team roster.' });
      return;
    }
    if (!ALPHA_ORG) {
      res.status(503).json({ error: 'No GitHub organisation is configured for this deployment.' });
      return;
    }

    try {
      const teams = await readTeamRoster(ALPHA_ORG);
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
 * Create a workspace and staff it in the same action.
 *
 * Admins and project managers may start a workspace. The person who starts it
 * is enrolled immediately, and selected organisation members are enrolled in
 * the same request so the new workspace is ready to use when it opens.
 * Project managers may staff a workspace, but only an admin may grant the
 * admin role.
 */
workspaceRouter.post(
  '/workspaces',
  route(async (req, res) => {
    const caller = req.workspace!;
    const creatorRole = caller.teamRole ?? caller.role;
    if (creatorRole !== 'admin' && creatorRole !== 'pm') {
      res.status(403).json({ error: 'Only an admin or project manager can create a workspace.' });
      return;
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Workspace name is required' });
      return;
    }

    if (req.body?.members !== undefined && !Array.isArray(req.body.members)) {
      res.status(400).json({ error: 'members must be an array' });
      return;
    }

    const selectedMembers: Array<{ userId: string; role: WorkspaceRole }> = [];
    const seen = new Set([caller.userId.trim().toLowerCase()]);
    for (const rawMember of (Array.isArray(req.body?.members) ? req.body.members : [])) {
      if (!rawMember || typeof rawMember !== 'object') {
        res.status(400).json({ error: 'Each member must include a userId and role' });
        return;
      }

      const userId = typeof (rawMember as any).userId === 'string'
        ? (rawMember as any).userId.trim()
        : '';
      const memberRole = (rawMember as any).role as WorkspaceRole;
      if (!userId || !ROLES.includes(memberRole)) {
        res.status(400).json({ error: `Each member role must be one of ${ROLES.join(', ')}` });
        return;
      }
      if (memberRole === 'admin' && creatorRole !== 'admin') {
        res.status(403).json({ error: 'Only an admin can add an admin while creating a workspace.' });
        return;
      }

      const key = userId.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selectedMembers.push({ userId, role: memberRole });
    }

    const workspace = await workspaceRegistry.createWorkspace(
      caller.userId,
      {
        name,
        slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined
      },
      creatorRole
    );

    for (const member of selectedMembers) {
      await workspaceRegistry.addMember(workspace.id, member.userId, member.role);
    }
    workspace.memberCount = selectedMembers.length + 1;
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

    let people: GitHubOrganizationMember[];
    try {
      people = await githubApi().getAll<GitHubOrganizationMember>(
        `/orgs/${encodeURIComponent(ALPHA_ORG)}/members?per_page=100`
      );
    } catch (err: any) {
      res.status(502).json({ error: `Could not read the ${ALPHA_ORG} members: ${err?.message ?? err}` });
      return;
    }

    const taken = new Set(
      (await workspaceRegistry.listMembers(req.params.id))
        .filter(member => member.status === 'active')
        .map(member => member.userId.toLowerCase())
    );
    const candidates = await withOrganizationRoles(ALPHA_ORG, people);
    res.json(candidates.filter(candidate => !taken.has(candidate.login.toLowerCase())));
  })
);

/**
 * The organisation's role-granting teams and their people for an existing
 * workspace. Each person carries their current workspace role, if present,
 * so Settings can show who is still available to staff.
 */
workspaceRouter.get(
  '/workspaces/:id/members/teams',
  route(async (req, res) => {
    if (!sameWorkspace(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'workspace.manage_members')) return;
    if (!ALPHA_ORG) {
      res.status(503).json({ error: 'No GitHub organisation is configured for this deployment.' });
      return;
    }

    let teams: OrganizationTeamRoster[];
    try {
      teams = await readTeamRoster(ALPHA_ORG);
    } catch (err: any) {
      res.status(502).json({ error: `Could not read the ${ALPHA_ORG} teams: ${err?.message ?? err}` });
      return;
    }

    const workspaceRoles = new Map(
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
          workspaceRole: workspaceRoles.get(person.login.toLowerCase()) ?? null
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
 * these rows, so managing them is `project.manage` -- a project manager.
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
