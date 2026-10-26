import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Agent, Issue, IssueComment, Project, Squad } from '../models/index.js';
import type { BoardChangePage } from './boardChangeSync.js';
import { createTestDatabase } from '../store/testDatabase.js';
import { withProjectDefaults } from '../store/projectStore.js';

/**
 * A desktop on a team's board.
 *
 * The desktop's SQLite is real; the team's board is a stub standing in for
 * Postgres behind the Data API, since what is under test is what the pull does
 * to this machine's copy. The rows it would send back are checked against the
 * real migration separately, at the bottom.
 */

let tmp: string;
let opened: { close(): void }[] = [];

const now = '2026-09-22T10:00:00.000Z';

const cloudProject = (over: Partial<Project> = {}): Project =>
  withProjectDefaults({
    id: 'gh-repo-100',
    name: 'checkout',
    key: 'CHK',
    githubOrg: 'acme',
    resources: [{ id: 'gh-repo-100-repo', type: 'github_repo', name: 'acme/checkout', pathOrUrl: 'https://github.com/acme/checkout' }],
    createdAt: now,
    // Pinned: the default is the time of the call, which a real row does not change.
    startDate: now,
    ...over
  });

const cloudIssue = (over: Partial<Issue> = {}): Issue => ({
  id: 'gh-issue-9001',
  identifier: 'CHK-7',
  title: 'Cart loses items',
  description: 'Steps to reproduce',
  status: 'todo',
  priority: 'high',
  projectId: 'gh-repo-100',
  labels: [],
  subtasks: [],
  comments: [],
  githubRepo: 'acme/checkout',
  githubNumber: 7,
  githubUrl: 'https://github.com/acme/checkout/issues/7',
  createdAt: now,
  updatedAt: now,
  ...over
});

const cloudComment = (over: Partial<IssueComment> = {}): IssueComment => ({
  id: 'gh-acme/checkout-555',
  issueId: 'gh-issue-9001',
  authorType: 'user',
  authorName: 'octocat',
  content: 'Reproduced on staging.',
  createdAt: now,
  ...over
});

const cloudAgent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'agent-teammate',
    name: 'Reviewer',
    role: 'Reviewer',
    avatar: '◆',
    color: '#6366f1',
    description: 'Reviews changes',
    owner: 'PM1',
    isMine: false,
    modelProvider: 'anthropic',
    modelName: 'claude-sonnet-5',
    systemPrompt: 'Review carefully.',
    autonomyLevel: 'supervised',
    temperature: 0.7,
    skills: [],
    mcpServers: [],
    customCliArgs: '',
    envVars: [],
    concurrencyLimit: 2,
    isArchived: false,
    allowedUsers: 'team',
    createdAt: now,
    ...over
  }) as Agent;

const cloudSquad = (over: Partial<Squad> = {}): Squad =>
  ({
    id: 'squad-web',
    name: 'Web squad',
    description: '',
    avatar: '◈',
    color: '#6366f1',
    topology: 'Sequential',
    leaderAgentId: undefined,
    memberAgentIds: ['agent-teammate'],
    mission: 'Ship the checkout',
    activeRunsCount: 0,
    completedRunsCount: 0,
    ...over
  }) as Squad;

interface Board {
  projects?: Project[];
  issues?: Issue[];
  comments?: IssueComment[];
  agents?: Agent[];
  squads?: Squad[];
  owners?: Array<{ squad_id: string; user_id: string; status: string }>;
  links?: Array<{ squad_id: string; project_id: string; relationship: string; status: string }>;
  assignments?: Array<{ project_id: string; user_id: string; status: string }>;
}

/** The team's board as the pull will read it. */
function source(board: Board = {}) {
  return {
    projects: async () => board.projects ?? [cloudProject()],
    issues: async () => board.issues ?? [cloudIssue()],
    comments: async () => board.comments ?? [cloudComment()],
    agents: async () => board.agents ?? [],
    squads: async () => board.squads ?? [],
    squadOwners: async () => board.owners ?? [],
    squadProjects: async () => board.links ?? [],
    projectAssignments: async () => board.assignments ?? []
  };
}

async function load() {
  process.env.ALPHA_HOME = tmp;
  delete process.env.ALPHA_MODE;
  vi.resetModules();
  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService);
  const board = await import('./sharedBoard.js');
  const svc = sql.sqliteService as any;
  const { runWithWorkspace } = await import('./workspaceContext.js');
  const inWorkspace = <T>(fn: () => T) => runWithWorkspace('ws-default', fn);
  return { svc, board, inWorkspace };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-sharedboard-'));
  opened = [];
});

afterEach(() => {
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.resetModules();
});

describe('pulling the team board', () => {
  /** What makes a developer's run something the cloud will accept. */
  it('writes the team’s cards under the team’s ids', async () => {
    const { svc, board, inWorkspace } = await load();

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report).toMatchObject({ projectsAdded: 1, issuesAdded: 1, comments: 1, conflicts: [] });
    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue).toMatchObject({ identifier: 'CHK-7', projectId: 'gh-repo-100', priority: 'high' });
    expect(issue.comments.map((c: IssueComment) => c.content)).toContain('Reproduced on staging.');
  });

  it('changes nothing the second time', async () => {
    const { board } = await load();
    await board.pullSharedBoard('ws-default', source());

    const again = await board.pullSharedBoard('ws-default', source());

    expect(again).toMatchObject({ projectsAdded: 0, projectsUpdated: 0, issuesAdded: 0, issuesUpdated: 0, comments: 0 });
  });

  it('takes the team’s changes to a card', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());

    await board.pullSharedBoard('ws-default', source({ issues: [cloudIssue({ title: 'Cart empties', status: 'in_progress' })] }));

    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue).toMatchObject({ title: 'Cart empties', status: 'in_progress' });
  });

  /** The cloud never stores a folder on this disk, so a pull must not erase it. */
  it('keeps this machine’s folder for a project', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());
    inWorkspace(() =>
      svc.updateProject('gh-repo-100', {
        resources: [
          ...cloudProject().resources,
          { id: 'local', type: 'local_path', name: 'checkout', pathOrUrl: 'C:/code/checkout' }
        ]
      })
    );

    await board.pullSharedBoard('ws-default', source({ projects: [cloudProject({ name: 'Checkout service' })] }));

    const project = inWorkspace(() => svc.getProjects()).find((p: Project) => p.id === 'gh-repo-100');
    expect(project.name).toBe('Checkout service');
    expect(project.resources.map((r: any) => r.type)).toEqual(['github_repo', 'local_path']);
  });

  /** The runner owns a card while an agent works on it here. */
  it('leaves a card alone while this machine is running it', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());
    inWorkspace(() => {
      svc.updateIssue('gh-issue-9001', { status: 'agent_running', branchName: 'alpha/fix-cart' });
      svc.savePrototypeRun({
        id: 'run-1', issueId: 'gh-issue-9001', projectId: 'gh-repo-100', agentId: 'agent-architect',
        status: 'running', scenario: 'success', plan: [], currentStageIndex: 0, stages: [], activities: [],
        createdAt: now, updatedAt: now
      });
    });

    await board.pullSharedBoard('ws-default', source({ issues: [cloudIssue({ status: 'todo', title: 'Renamed on the web' })] }));

    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue).toMatchObject({ status: 'agent_running', branchName: 'alpha/fix-cart', title: 'Renamed on the web' });
  });

  /**
   * A project a manager made in a second workspace reached the developer's
   * desktop and was hidden there: the desktop asked a side table, which only
   * the API's create routes wrote to, instead of the row's own workspace_id.
   */
  it('shows what it pulls into a second workspace in that workspace, and not in the default', async () => {
    const { board } = await load();
    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    const second = await workspaceRegistry.createWorkspace('PM1', { name: 'Capstone Test' }, 'pm');
    await workspaceRegistry.addMember(second.id, 'Dev1', 'dev');

    await board.pullSharedBoard(second.id, source({
      assignments: [{ project_id: 'gh-repo-100', user_id: 'Dev1', status: 'active' }]
    }));

    const there = await workspaceRegistry.resolve('Dev1', second.id, 'dev');
    expect(workspaceRegistry.canDiscoverProject(there!, 'gh-repo-100')).toBe(true);
    expect(workspaceRegistry.canAccessProject(there!, 'gh-repo-100')).toBe(true);

    const home = await workspaceRegistry.resolve('Dev1', 'ws-default', 'dev');
    expect(workspaceRegistry.canDiscoverProject(home!, 'gh-repo-100')).toBe(false);
  });

  /**
   * On a team's desktop the catalogue is PM-owned projects, and the desktop
   * cannot see who the PMs are -- it holds only its own membership. Every
   * project it pulled passed the cloud's PM check already, so its creator is
   * enough; one with no creator, made here, is not in the catalogue.
   */
  it('shows a developer on a team desktop what the team board sent, and not an unowned local project', async () => {
    process.env.ALPHA_CLOUD_API = 'https://cloud.test/api';
    try {
      const { svc, board, inWorkspace } = await load();
      const { workspaceRegistry } = await import('./workspaceRegistry.js');

      await board.pullSharedBoard('ws-default', source({ projects: [cloudProject({ createdBy: 'PM1' })] }));
      inWorkspace(() => svc.createProject({ id: 'proj-local', name: 'Local', key: 'LOC', resources: [] }));

      const dev = await workspaceRegistry.resolve('Dev1', 'ws-default', 'dev');
      expect(workspaceRegistry.canDiscoverProject(dev!, 'gh-repo-100')).toBe(true);
      expect(workspaceRegistry.canDiscoverProject(dev!, 'proj-local')).toBe(false);
      // The owner came down with it.
      expect(inWorkspace(() => svc.getProjects()).find((p: Project) => p.id === 'gh-repo-100')?.createdBy).toBe('PM1');
    } finally {
      process.env.ALPHA_CLOUD_API = '';
    }
  });

  /** How the next sync knows a comment has already gone to GitHub. */
  it('learns that a comment was published', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source({ comments: [cloudComment({ id: 'comm-run-1' })] }));

    await board.pullSharedBoard('ws-default', source({ comments: [cloudComment({ id: 'comm-run-1', githubId: 777 })] }));

    const issue = inWorkspace(() => svc.getIssues()).find((i: Issue) => i.id === 'gh-issue-9001');
    expect(issue.comments.find((c: IssueComment) => c.id === 'comm-run-1')?.githubId).toBe(777);
  });
});

describe('the team’s roster', () => {
  it('adopts the cloud ID for a locally seeded template, preserving settings, history and workspace isolation', async () => {
    const { svc, board, inWorkspace } = await load();
    const { runWithWorkspace } = await import('./workspaceContext.js');
    const workspace = svc.createWorkspace({ name: 'Team workspace' });
    const inTeam = <T>(fn: () => T) => runWithWorkspace(workspace.id, fn);
    const local = inTeam(() => svc.getAgents()).find((a: Agent) => a.templateKey === 'frontend') as Agent;
    const { agentFilePath } = await import('./agentFileService.js');
    fs.writeFileSync(agentFilePath(local.id), '---\nmodel: my-local-model\n---\n\nKeep my local instructions.\n');
    const memory = path.join(tmp, 'memory', 'agents', local.id);
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'learnings.md'), 'A local lesson.');
    const cloud = { ...local, id: 'team-frontend', modelName: 'cloud-model' };
    inTeam(() => {
      svc.createProject({ ...cloudProject(), leadAgentId: local.id });
      svc.createIssue({ ...cloudIssue(), assignedAgentId: local.id });
      svc.savePrototypeRun({
        id: 'local-history', issueId: 'gh-issue-9001', projectId: 'gh-repo-100', agentId: local.id,
        status: 'completed', scenario: 'success', plan: [], currentStageIndex: 0, stages: [], activities: [],
        createdAt: now, updatedAt: now
      });
      svc.createChatThread({ id: 'local-chat', title: 'Local chat', agentIds: [local.id], targetAgentId: local.id });
      svc.createSquad(cloudSquad({ leaderAgentId: local.id, memberAgentIds: [local.id] }));
    });
    const report = await board.pullSharedBoard(workspace.id, source({
      agents: [cloud], issues: [cloudIssue({ assignedAgentId: cloud.id })]
    }));
    expect(report.conflicts).toEqual([]);
    expect(report.unpublished.agents.some(agent => agent.id === local.id)).toBe(false);
    const roster = inTeam(() => svc.getAgents()) as Agent[];
    expect(roster.filter(agent => agent.templateKey === 'frontend')).toHaveLength(1);
    expect(roster.find(agent => agent.id === cloud.id)).toMatchObject({ modelName: 'my-local-model', systemPrompt: 'Keep my local instructions.' });
    expect(inTeam(() => svc.getPrototypeRuns()).find((run: { id: string }) => run.id === 'local-history')?.agentId).toBe(cloud.id);
    expect(inTeam(() => svc.getIssues())[0].assignedAgentId).toBe(cloud.id);
    expect(inTeam(() => svc.getChatThreads())[0]).toMatchObject({ agentIds: [cloud.id], targetAgentId: cloud.id });
    expect(inTeam(() => svc.getSquads())[0]).toMatchObject({ leaderAgentId: cloud.id, memberAgentIds: [cloud.id] });
    expect(fs.readFileSync(path.join(tmp, 'memory', 'agents', cloud.id, 'learnings.md'), 'utf8')).toBe('A local lesson.');
    expect(inWorkspace(() => svc.getAgents()).find((a: Agent) => a.id === 'agent-frontend')).toBeTruthy();
    await expect(board.pullSharedBoard(workspace.id, source({ agents: [cloud] }))).resolves.toMatchObject({ agentsAdded: 0, conflicts: [] });
  });

  it('adds an agent this machine does not have', async () => {
    const { svc, board, inWorkspace } = await load();

    const report = await board.pullSharedBoard('ws-default', source({ agents: [cloudAgent()] }));

    expect(report.agentsAdded).toBe(1);
    const agent = inWorkspace(() => svc.getAgents()).find((a: Agent) => a.id === 'agent-teammate');
    expect(agent).toMatchObject({ name: 'Reviewer', systemPrompt: 'Review carefully.' });
  });

  /**
   * The persona file is this machine's authority on how an agent behaves, and
   * `updateAgent` rewrites the file's frontmatter from whatever it is handed.
   */
  it('leaves alone what this machine’s persona file declares', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source({ agents: [cloudAgent()] }));
    const { agentFilePath } = await import('./agentFileService.js');
    fs.writeFileSync(
      agentFilePath('agent-teammate'),
      `---\nname: Reviewer\nmodel: claude-opus-5\n---\n\nMy own instructions.\n`
    );

    await board.pullSharedBoard(
      'ws-default',
      source({ agents: [cloudAgent({ modelName: 'claude-haiku-4-5', description: 'Reviews changes twice' })] })
    );

    const agent = inWorkspace(() => svc.getAgents()).find((a: Agent) => a.id === 'agent-teammate');
    // The file decides the model; the team still decides everything else.
    expect(agent.modelName).toBe('claude-opus-5');
    expect(agent.description).toBe('Reviews changes twice');
  });

  it('still reads legacy squads from the team board', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() => svc.createSquad({ ...cloudSquad({ id: 'squad-mine', name: 'Mine' }) }));

    const report = await board.pullSharedBoard('ws-default', source({ squads: [cloudSquad()] }));

    expect(report.squadsAdded).toBe(1);
    // A squad made before the upgrade stays local; nothing seeds one any more.
    expect(report.unpublished.squads.map((s: Squad) => s.id)).toEqual(['squad-mine']);
    // The seeded roster is this machine's until it is published.
    expect(report.unpublished.agents.length).toBeGreaterThan(0);
  });

  /**
   * Without the assignment, a developer's squad run is refused here for a
   * project a project manager assigned it to on the web.
   */
  it('mirrors who owns a squad and which projects it serves', async () => {
    const { board } = await load();

    await board.pullSharedBoard(
      'ws-default',
      source({
        squads: [cloudSquad()],
        owners: [{ squad_id: 'squad-web', user_id: 'Dev1', status: 'active' }],
        links: [{ squad_id: 'squad-web', project_id: 'gh-repo-100', relationship: 'assigned', status: 'active' }]
      })
    );

    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    const links = await workspaceRegistry.listSquadProjectAssignments('ws-default', 'gh-repo-100');
    expect(links.map(l => [l.squadId, l.status])).toEqual([['squad-web', 'active']]);
    const context = await workspaceRegistry.resolve('Dev1', 'ws-default', 'dev');
    expect(context?.access.squadOwners.get('squad-web')).toBe('Dev1');
  });

  /**
   * A developer sees a project's tasks only with an assignment, and this
   * machine answers from its own copy. A project manager assigning them on
   * the web left the project empty on their desktop until this was mirrored.
   */
  it('mirrors who is on which project, so a developer sees its tasks', async () => {
    const { board } = await load();
    const { workspaceRegistry } = await import('./workspaceRegistry.js');

    await board.pullSharedBoard(
      'ws-default',
      source({ assignments: [{ project_id: 'gh-repo-100', user_id: 'Dev1', status: 'active' }] })
    );

    const context = await workspaceRegistry.resolve('Dev1', 'ws-default', 'dev');
    expect(workspaceRegistry.canAccessProject(context!, 'gh-repo-100')).toBe(true);
  });

  it('takes an assignment away when the team removed it', async () => {
    const { board } = await load();
    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    await board.pullSharedBoard(
      'ws-default',
      source({ assignments: [{ project_id: 'gh-repo-100', user_id: 'Dev1', status: 'active' }] })
    );

    await board.pullSharedBoard(
      'ws-default',
      source({ assignments: [{ project_id: 'gh-repo-100', user_id: 'Dev1', status: 'removed' }] })
    );
    const afterRemoved = await workspaceRegistry.resolve('Dev1', 'ws-default', 'dev');
    // Assignments now decide only what a client may reach; the record itself must still follow the team's.
    expect(afterRemoved!.access.assignedProjectIds.has('gh-repo-100')).toBe(false);

    // And the same when the row is gone from the team's copy altogether.
    await board.pullSharedBoard(
      'ws-default',
      source({ assignments: [{ project_id: 'gh-repo-100', user_id: 'Dev1', status: 'active' }] })
    );
    await board.pullSharedBoard('ws-default', source({ assignments: [] }));
    const afterGone = await workspaceRegistry.resolve('Dev1', 'ws-default', 'dev');
    expect(afterGone!.access.assignedProjectIds.has('gh-repo-100')).toBe(false);
  });
});

describe('cards this machine made before it joined the team', () => {
  /**
   * Every installed desktop up to 2.0.6 ran off the team board, and made its
   * own projects for the organisation's repositories. Each pull then clashed
   * with the team's copy, warned, and left the team's cards out. The team's
   * project is adopted instead, and this machine's history comes with it.
   */
  it('adopts the team’s project for a repository it already has, history included', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() => {
      svc.createProject({
        id: 'proj-mine', name: 'My checkout', key: 'MINE',
        resources: [
          { id: 'r', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' },
          { id: 'l', type: 'local_path', name: 'checkout', pathOrUrl: 'C:/code/checkout' }
        ]
      });
      // The same GitHub issue the team has, and a card only this machine has.
      svc.createIssue({ id: 'issue-mine', identifier: 'MINE-1', projectId: 'proj-mine', title: 'Cart', githubRepo: 'acme/checkout', githubNumber: 7 });
      svc.createIssue({ id: 'issue-local', identifier: 'MINE-2', projectId: 'proj-mine', title: 'Only here' });
      svc.addIssueComment({ id: 'comm-local', issueId: 'issue-mine', authorType: 'user', authorName: 'Dev1', content: 'Tried a fix.', createdAt: now });
      svc.savePrototypeRun({
        id: 'run-old', issueId: 'issue-mine', projectId: 'proj-mine', agentId: 'agent-architect',
        status: 'completed', scenario: 'success', plan: [], currentStageIndex: 0, stages: [], activities: [],
        createdAt: now, updatedAt: now
      });
    });

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report.conflicts).toEqual([]);
    expect(report).toMatchObject({ projectsAdopted: 1, issuesAdopted: 1 });

    const projects = inWorkspace(() => svc.getProjects());
    expect(projects.map((p: Project) => p.id)).toEqual(['gh-repo-100']);
    expect(projects[0].key).toBe('CHK');
    // The folder is this machine's, and stays.
    expect(projects[0].resources.map((r: any) => r.type)).toContain('local_path');

    const issues = inWorkspace(() => svc.getIssues());
    const adopted = issues.find((i: Issue) => i.id === 'gh-issue-9001');
    expect(adopted).toMatchObject({ identifier: 'CHK-7', projectId: 'gh-repo-100' });
    expect(adopted.comments.map((c: IssueComment) => c.content)).toContain('Tried a fix.');
    expect(issues.find((i: Issue) => i.id === 'issue-local')).toMatchObject({ projectId: 'gh-repo-100' });

    const run = inWorkspace(() => svc.getPrototypeRuns()).find((r: any) => r.id === 'run-old');
    expect(run).toMatchObject({ issueId: 'gh-issue-9001', projectId: 'gh-repo-100' });

    // And the next pull is an ordinary one.
    expect((await board.pullSharedBoard('ws-default', source())).conflicts).toEqual([]);
  });

  it('adopts a card that is the same GitHub issue as one of the team’s', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source({ issues: [], comments: [] }));
    inWorkspace(() =>
      svc.createIssue({ id: 'issue-mine', identifier: 'CHK-900', projectId: 'gh-repo-100', title: 'Mine', githubRepo: 'acme/checkout', githubNumber: 7 })
    );

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report.conflicts).toEqual([]);
    expect(report.issuesAdopted).toBe(1);
    expect(inWorkspace(() => svc.getIssues()).map((i: Issue) => [i.id, i.identifier])).toEqual([['gh-issue-9001', 'CHK-7']]);
  });

  /** Adopting would take a key another project here uses, so it asks instead. */
  it('reports a same-repository project whose team key is taken here by another', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() => {
      svc.createProject({
        id: 'proj-mine', name: 'My checkout', key: 'MINE',
        resources: [{ id: 'r', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }]
      });
      svc.createProject({ id: 'proj-other', name: 'Other', key: 'CHK', resources: [] });
    });

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report.conflicts).toEqual([expect.objectContaining({ project: 'MINE' })]);
    expect(report.conflicts[0].detail).toMatch(/taken here by Other/);
    expect(inWorkspace(() => svc.getProjects()).map((p: Project) => p.id).sort()).toEqual(['proj-mine', 'proj-other']);
  });

  it('reports a key this machine already uses', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() => svc.createProject({ id: 'proj-other', name: 'Other', key: 'CHK', resources: [] }));

    const report = await board.pullSharedBoard('ws-default', source());

    expect(report.conflicts).toEqual([expect.objectContaining({ project: 'CHK' })]);
  });
});

/**
 * The cloud decides the catalogue. A project it hid or deleted used to stay on
 * every desktop -- the whole GitHub organisation, in Alpha Workspace's case --
 * because a pull never removed anything.
 */
describe('a project the team no longer lists', () => {
  const payments = (over: Partial<Project> = {}) =>
    cloudProject({
      id: 'gh-repo-200',
      name: 'payments',
      key: 'PAY',
      resources: [{ id: 'gh-repo-200-repo', type: 'github_repo', name: 'acme/payments', pathOrUrl: 'https://github.com/acme/payments' }],
      createdBy: 'PM1',
      ...over
    });
  const paymentsIssue = cloudIssue({ id: 'gh-issue-9100', identifier: 'PAY-1', projectId: 'gh-repo-200' });
  const ids = (svc: any, inWorkspace: <T>(fn: () => T) => T) =>
    inWorkspace(() => svc.getProjects()).map((p: Project) => p.id).sort();

  it('leaves this machine, cards and all, and its cards are not written back', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard(
      'ws-default',
      source({ projects: [cloudProject({ createdBy: 'PM1' }), payments()], issues: [cloudIssue(), paymentsIssue] }),
      'Dev1'
    );

    // The cloud hides payments; its card is still readable there, as RLS allows.
    const report = await board.pullSharedBoard(
      'ws-default',
      source({ projects: [cloudProject({ createdBy: 'PM1' })], issues: [cloudIssue(), paymentsIssue] }),
      'Dev1'
    );

    expect(report.projectsRemoved).toBe(1);
    expect(ids(svc, inWorkspace)).toEqual(['gh-repo-100']);
    expect(inWorkspace(() => svc.getIssues()).map((i: Issue) => i.id)).toEqual(['gh-issue-9001']);
  });

  it('keeps a project the person syncing made, which may not have reached the cloud yet', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() => svc.createProject({ id: 'proj-mine', name: 'Mine', key: 'MINE', resources: [], createdBy: 'dev1' }));

    const report = await board.pullSharedBoard('ws-default', source({ projects: [cloudProject({ createdBy: 'PM1' })] }), 'Dev1');

    expect(report.projectsRemoved).toBe(0);
    expect(ids(svc, inWorkspace)).toContain('proj-mine');
  });

  it('keeps a project with no creator, which predates the team board', async () => {
    const { svc, board, inWorkspace } = await load();
    inWorkspace(() => svc.createProject({ id: 'proj-old', name: 'Old', key: 'OLD', resources: [] }));

    await board.pullSharedBoard('ws-default', source({ projects: [cloudProject({ createdBy: 'PM1' })] }), 'Dev1');

    expect(ids(svc, inWorkspace)).toContain('proj-old');
  });

  /** An unauthenticated read sees no rows; acting on it would empty the catalogue. */
  it('removes nothing when the cloud lists no projects at all', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source({ projects: [payments()], issues: [paymentsIssue] }), 'Dev1');

    const report = await board.pullSharedBoard('ws-default', source({ projects: [], issues: [] }), 'Dev1');

    expect(report.projectsRemoved).toBe(0);
    expect(ids(svc, inWorkspace)).toEqual(['gh-repo-200']);
  });

  it('removes nothing when the caller does not say who is syncing', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source({ projects: [cloudProject({ createdBy: 'PM1' }), payments()] }));

    await board.pullSharedBoard('ws-default', source({ projects: [cloudProject({ createdBy: 'PM1' })] }));

    expect(ids(svc, inWorkspace)).toEqual(['gh-repo-100', 'gh-repo-200']);
  });
});

describe('asSyncReport', () => {
  it('puts clashes where the app shows them one by one', async () => {
    const { board } = await load();

    const shaped = board.asSyncReport({
      projectsAdded: 2, projectsUpdated: 1, issuesAdded: 5, issuesUpdated: 3, unchanged: 4, comments: 6,
      agentsAdded: 0, agentsUpdated: 0, squadsAdded: 0, squadsUpdated: 0, projectsAdopted: 0, issuesAdopted: 0,
      projectsRemoved: 0,
      unpublished: { agents: [], squads: [] },
      conflicts: [{ project: 'MINE', detail: 'clash' }]
    });

    expect(shaped).toMatchObject({ projectsImported: 2, created: 5, errors: [{ project: 'MINE', detail: 'clash' }] });
  });
});

describe('supabaseBoardSource', () => {
  /** A stand-in for supabase-js's query builder: every call returns the builder, `range` answers. */
  function fakeClient(pages: Record<string, unknown[][]>, error?: string) {
    const calls: Array<{ table: string; from: number; to: number }> = [];
    return {
      calls,
      client: {
        from(table: string) {
          const builder: any = {
            select: () => builder,
            eq: () => builder,
            order: () => builder,
            range: async (from: number, to: number) => {
              calls.push({ table, from, to });
              if (error) return { data: null, error: { message: error } };
              return { data: pages[table]?.[from / 1000] ?? [], error: null };
            }
          };
          return builder;
        }
      } as any
    };
  }

  /** A board of more than a thousand cards must not stop at the first page. */
  it('reads every page', async () => {
    const { board } = await load();
    const row = (i: number) => ({
      id: `i${i}`, identifier: `CHK-${i}`, title: 't', description: '', status: 'todo', priority: 'low', project_id: 'p',
      assigned_agent_id: null, assigned_squad_id: null, assigned_human: null, created_by: null, labels: [], subtasks: [],
      branch_name: null, pr_url: null, github_repo: null, github_number: null, github_url: null,
      created_at: now, updated_at: now
    });
    const { client, calls } = fakeClient({
      issues: [Array.from({ length: 1000 }, (_, i) => row(i)), [row(1000)]]
    });

    const issues = await board.supabaseBoardSource(client).issues('ws-default');

    expect(issues).toHaveLength(1001);
    expect(calls.map(c => c.from)).toEqual([0, 1000]);
  });

  it('fails loudly rather than pulling a partial board', async () => {
    const { board } = await load();
    const { client } = fakeClient({}, 'JWT expired');

    await expect(board.supabaseBoardSource(client).projects('ws-default')).rejects.toThrow('JWT expired');
  });
});

describe('the rows the desktop writes back', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await pg?.close();
  });

  /**
   * Column names are the one thing no type catches: a typo is a valid object
   * that every insert refuses. So they go into the real migration.
   */
  it('fit the real schema, and read back as they were sent', async () => {
    const { issueRow, commentRow, toIssue, toComment } = await import('../store/postgresIssueStore.js');
    await pg.exec(`insert into workspaces (id, name, slug) values ('ws-default', 'Alpha', 'alpha')`);
    await pg.exec(`insert into projects (id, workspace_id, name, key) values ('gh-repo-100', 'ws-default', 'checkout', 'CHK')`);

    const issue = cloudIssue({ assignedHuman: 'octocat', labels: ['bug'] });
    const comment = cloudComment({ githubId: 555 });
    const insert = async (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row);
      await pg.query(
        `insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map(column => {
          const value = row[column];
          return Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value) : value;
        })
      );
    };
    await insert('issues', issueRow('ws-default', issue));
    await insert('issue_comments', commentRow(comment));

    const [back] = (await pg.query<any>('select * from issues')).rows;
    const [backComment] = (await pg.query<any>('select * from issue_comments')).rows;
    expect(toIssue(back, [])).toEqual({ ...issue, comments: [] });
    expect(toComment(backComment)).toEqual({ ...comment, isThinking: false, authorAvatar: undefined, agentId: undefined });
  });
});

describe('applying incremental team-board pages', () => {
  const page = (changes: BoardChangePage['changes'], cursor = '4'): BoardChangePage => ({
    workspaceId: 'ws-default',
    nextCursor: { workspaceId: 'ws-default', value: cursor },
    hasMore: false,
    resetRequired: false,
    changes
  });

  it('replays pages idempotently while keeping machine paths and runner-owned issue fields', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());

    const project = inWorkspace(() => svc.getProjects().find((row: Project) => row.id === 'gh-repo-100')) as Project;
    const machineResources = [
      { id: 'local-path', type: 'local_path', name: 'Worktree', pathOrUrl: 'C:\\work\\checkout' },
      { id: 'local-dir', type: 'local_dir', name: 'Checkout', pathOrUrl: 'C:\\work\\checkout' }
    ];
    inWorkspace(() => svc.updateProject(project.id, { resources: [...project.resources, ...machineResources] }));

    const issue = inWorkspace(() => svc.getIssues().find((row: Issue) => row.id === 'gh-issue-9001')) as Issue;
    const agentId = inWorkspace(() => svc.getAgents()[0].id);
    inWorkspace(() => {
      svc.updateIssue(issue.id, {
        status: 'agent_running',
        assignedAgentId: agentId,
        branchName: 'local/active-work',
        prUrl: 'https://github.com/acme/checkout/pull/7'
      });
      svc.savePrototypeRun({
        id: 'run-active', issueId: issue.id, projectId: project.id, agentId, status: 'running',
        scenario: 'success', plan: [], currentStageIndex: 0, stages: [], activities: [], createdAt: now, updatedAt: now
      });
      svc.setBoardSyncCursor('ws-default', '1');
    });

    const changes: BoardChangePage['changes'] = [
      {
        cursor: '2', table: 'projects', rowKey: { id: project.id }, operation: 'update',
        row: cloudProject({ name: 'Renamed by the team' }) as unknown as Record<string, unknown>
      },
      {
        cursor: '3', table: 'issues', rowKey: { id: issue.id }, operation: 'update',
        row: cloudIssue({ title: 'Renamed card', status: 'todo', branchName: undefined, prUrl: undefined }) as unknown as Record<string, unknown>
      },
      {
        cursor: '4', table: 'issue_comments', rowKey: { id: 'cloud-comment-2' }, operation: 'insert',
        row: cloudComment({ id: 'cloud-comment-2', content: 'A new team comment.' }) as unknown as Record<string, unknown>
      }
    ];

    await board.applySharedBoardChanges('ws-default', page(changes));
    const first = inWorkspace(() => ({
      project: svc.getProjects().find((row: Project) => row.id === project.id),
      issue: svc.getIssues().find((row: Issue) => row.id === issue.id),
      runs: svc.getPrototypeRuns(),
      cursor: svc.getBoardSyncCursor('ws-default')
    }));
    await board.applySharedBoardChanges('ws-default', page(changes));
    const replayed = inWorkspace(() => ({
      project: svc.getProjects().find((row: Project) => row.id === project.id),
      issue: svc.getIssues().find((row: Issue) => row.id === issue.id),
      runs: svc.getPrototypeRuns(),
      cursor: svc.getBoardSyncCursor('ws-default')
    }));

    expect(first).toEqual(replayed);
    expect(first.project?.name).toBe('Renamed by the team');
    expect(first.project?.resources.map((resource: any) => resource.type)).toEqual([
      'github_repo', 'local_path', 'local_dir'
    ]);
    expect(first.issue).toMatchObject({
      title: 'Renamed card', status: 'agent_running', assignedAgentId: agentId,
      branchName: 'local/active-work', prUrl: 'https://github.com/acme/checkout/pull/7'
    });
    expect(first.issue?.comments.filter((comment: IssueComment) => comment.id === 'cloud-comment-2')).toHaveLength(1);
    expect(first.runs).toHaveLength(1);
    expect(first.cursor).toBe('4');
  });

  it('removes deleted issues and their local comments before saving the next cursor', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());
    expect(inWorkspace(() => svc.getIssues().map((issue: Issue) => issue.id))).toContain('gh-issue-9001');
    inWorkspace(() => svc.setBoardSyncCursor('ws-default', '1'));

    await board.applySharedBoardChanges('ws-default', page([{
      cursor: '2', table: 'issue_comments', rowKey: { id: 'gh-acme/checkout-555' }, operation: 'delete', row: null
    }], '2'));
    expect(inWorkspace(() => svc.getIssues()[0]?.comments)).toEqual([]);
    expect(inWorkspace(() => svc.getBoardSyncCursor('ws-default'))).toBe('2');

    await board.applySharedBoardChanges('ws-default', page([{
      cursor: '3', table: 'issues', rowKey: { id: 'gh-issue-9001' }, operation: 'delete', row: null
    }], '3'));

    expect(inWorkspace(() => svc.getIssues())).toEqual([]);
    expect(inWorkspace(() => svc.getBoardSyncCursor('ws-default'))).toBe('3');
  });

  it('does not advance the saved cursor when applying a local write fails', async () => {
    const { svc, board, inWorkspace } = await load();
    await board.pullSharedBoard('ws-default', source());
    inWorkspace(() => svc.setBoardSyncCursor('ws-default', '1'));
    svc.db.exec(`
      CREATE TRIGGER fail_shared_board_project_update
      BEFORE UPDATE ON projects WHEN OLD.id = 'gh-repo-100'
      BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;
    `);

    await expect(board.applySharedBoardChanges('ws-default', page([{
      cursor: '2', table: 'projects', rowKey: { id: 'gh-repo-100' }, operation: 'update',
      row: cloudProject({ name: 'Should not apply' }) as unknown as Record<string, unknown>
    }], '2'))).rejects.toThrow('disk write failed');

    expect(inWorkspace(() => svc.getBoardSyncCursor('ws-default'))).toBe('1');
  });
});
