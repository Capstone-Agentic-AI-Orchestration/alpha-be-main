import type { Project, ProjectResource } from '../models/index.js';
import type { Sql } from './database.js';
import { withProjectDefaults, type ProjectStore } from './projectStore.js';

/**
 * Projects in the cloud.
 *
 * Every statement is scoped by `workspace_id`, so a project of another
 * workspace is not merely filtered out afterwards -- it is never read. The
 * row-level policies say the same thing to anyone reaching Postgres directly;
 * this is the cloud's own path, which connects as the tables' owner.
 *
 * ## What is deliberately not here
 *
 * `envVars`. A project's environment values resolve `${VAR}` in MCP server
 * definitions, which is to say they are credentials -- a database URL, an API
 * key -- and they belong to the machine that runs the agent, not to a shared
 * table every workspace member can read. The Postgres schema has no column
 * for them, for the same reason `0003` dropped the agents' CLI arguments and
 * environment: cloud rows that turn into a command on someone's laptop.
 *
 * `local_path` resources are dropped on write for the other half of that
 * reason: a path from one developer's disk means nothing on another's, and
 * the web app would render it as though it did.
 */
export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string): Promise<Project[]> {
    const { rows } = await this.sql.query<ProjectRow>(
      'select * from projects where workspace_id = $1 order by created_at desc',
      [workspaceId]
    );
    return rows.map(toProject);
  }

  async get(workspaceId: string, id: string): Promise<Project | null> {
    const { rows } = await this.sql.query<ProjectRow>(
      'select * from projects where workspace_id = $1 and id = $2',
      [workspaceId, id]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async create(workspaceId: string, input: Partial<Project>): Promise<Project> {
    const project = withProjectDefaults(input);
    const { rows } = await this.sql.query<ProjectRow>(
      `insert into projects
         (id, workspace_id, name, key, description, color, icon, status, priority,
          start_date, target_date, lead_type, lead_name, lead_agent_id, resources, github_org, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       returning *`,
      [
        project.id,
        workspaceId,
        project.name,
        project.key,
        project.description,
        project.color,
        project.icon,
        project.status,
        project.priority,
        date(project.startDate),
        date(project.targetDate),
        project.leadType,
        project.leadName,
        project.leadAgentId ?? null,
        JSON.stringify(shareable(project.resources)),
        project.githubOrg ?? null,
        date(project.createdAt)
      ]
    );
    return toProject(rows[0]);
  }

  async update(workspaceId: string, id: string, updates: Partial<Project>): Promise<Project | null> {
    const existing = await this.get(workspaceId, id);
    if (!existing) return null;

    const merged = { ...existing, ...updates };
    const { rows } = await this.sql.query<ProjectRow>(
      `update projects set
         name = $3, key = $4, description = $5, color = $6, icon = $7, status = $8, priority = $9,
         start_date = $10, target_date = $11, lead_type = $12, lead_name = $13, lead_agent_id = $14,
         resources = $15, github_org = $16
       where workspace_id = $1 and id = $2
       returning *`,
      [
        workspaceId,
        id,
        merged.name,
        merged.key,
        merged.description,
        merged.color,
        merged.icon,
        merged.status,
        merged.priority,
        date(merged.startDate),
        date(merged.targetDate),
        merged.leadType,
        merged.leadName,
        merged.leadAgentId ?? null,
        JSON.stringify(shareable(merged.resources)),
        merged.githubOrg ?? null
      ]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    // Build steps go with it, by the schema's `on delete cascade`.
    const { rows } = await this.sql.query(
      'delete from projects where workspace_id = $1 and id = $2 returning id',
      [workspaceId, id]
    );
    return rows.length > 0;
  }
}

/** `timestamptz` arrives as a Date from `pg` and PGlite alike. */
type Timestamp = Date | string | null;

interface ProjectRow {
  id: string;
  name: string;
  key: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  status: string | null;
  priority: string | null;
  start_date: Timestamp;
  target_date: Timestamp;
  lead_type: string | null;
  lead_name: string | null;
  lead_agent_id: string | null;
  resources: ProjectResource[] | null;
  github_org: string | null;
  created_at: Timestamp;
}

/** An empty date is stored as null, not as the epoch. */
const date = (value?: string): string | null => value || null;
const iso = (value: Timestamp): string => (value ? new Date(value).toISOString() : '');

/**
 * Resources minus the ones that name one machine.
 *
 * A `local_path` or `local_dir` is a folder on one developer's disk. Shared,
 * it is a path the web app draws for people who do not have it, and one a
 * daemon on another machine could be pointed at.
 */
const MACHINE_LOCAL = new Set<ProjectResource['type']>(['local_path', 'local_dir']);

function shareable(resources: ProjectResource[] = []): ProjectResource[] {
  return resources.filter(resource => !MACHINE_LOCAL.has(resource.type));
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    description: row.description ?? '',
    color: row.color ?? '',
    icon: row.icon ?? '',
    status: (row.status ?? 'in_progress') as Project['status'],
    priority: (row.priority ?? 'medium') as Project['priority'],
    startDate: iso(row.start_date),
    targetDate: iso(row.target_date),
    leadType: (row.lead_type ?? 'agent') as Project['leadType'],
    leadName: row.lead_name ?? '',
    leadAgentId: row.lead_agent_id ?? undefined,
    // `jsonb` arrives parsed from `pg` and from PGlite alike.
    resources: row.resources ?? [],
    githubOrg: row.github_org ?? undefined,
    createdAt: iso(row.created_at),
    // Machine-local, and never stored here; see the class comment.
    envVars: []
  };
}
