import type { Agent, Squad } from '../models/index.js';
import { agentFromOfficialTemplate, OFFICIAL_AGENT_TEMPLATES } from '../services/officialAgentTemplates.js';
import type { Sql } from './database.js';
import { withoutMachineConfig, type AgentStore, type SquadStore } from './agentStore.js';

/**
 * The roster in the cloud.
 *
 * Shared, and stable across deploys -- which is the point. Agents were seeded
 * into the container's SQLite at boot, so every deploy minted a fresh roster:
 * an issue assigned to an agent pointed at an id that no longer existed, and
 * "who is this card with" could not survive a restart.
 *
 * What is not written here: `customCliArgs` and `envVars`. `0003` dropped both
 * columns for the reason it gives -- an argument list is a command, and the
 * environment holds credentials, on whichever machine ends up running them.
 * They stay on that machine.
 *
 * The persona file and memory scaffold a desktop agent gets are also absent:
 * both are directories on a developer's disk, and the cloud has no disk worth
 * writing to.
 */
export class PostgresAgentStore implements AgentStore {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string): Promise<Agent[]> {
    const { rows } = await this.sql.query<AgentRow>(
      'select * from agents where workspace_id = $1 order by created_at asc',
      [workspaceId]
    );
    return rows.map(toAgent);
  }

  async get(workspaceId: string, id: string): Promise<Agent | null> {
    const { rows } = await this.sql.query<AgentRow>(
      'select * from agents where workspace_id = $1 and id = $2',
      [workspaceId, id]
    );
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async create(workspaceId: string, input: Agent): Promise<Agent> {
    const agent = withoutMachineConfig(input);
    const { rows } = await this.sql.query<AgentRow>(
      `insert into agents
         (id, workspace_id, name, role, avatar, color, description, owner, is_mine,
          model_provider, model_name, reasoning_effort, system_prompt, autonomy_level, temperature,
          skills, mcp_servers, concurrency_limit, is_archived, allowed_users,
          template_key, template_version, phase, is_seeded, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       returning *`,
      [
        agent.id,
        workspaceId,
        agent.name,
        agent.role,
        agent.avatar,
        agent.color,
        agent.description,
        agent.owner,
        agent.isMine ?? true,
        agent.modelProvider,
        agent.modelName,
        agent.reasoningEffort ?? null,
        agent.systemPrompt ?? '',
        agent.autonomyLevel,
        agent.temperature ?? 0.7,
        JSON.stringify(agent.skills ?? []),
        JSON.stringify(agent.mcpServers ?? []),
        agent.concurrencyLimit ?? 2,
        agent.isArchived ?? false,
        agent.allowedUsers ?? null,
        agent.templateKey ?? null,
        agent.templateVersion ?? null,
        agent.phase ?? null,
        agent.isSeeded ?? false,
        agent.createdAt || new Date().toISOString()
      ]
    );
    return toAgent(rows[0]);
  }

  async update(workspaceId: string, id: string, updates: Partial<Agent>): Promise<Agent | null> {
    const existing = await this.get(workspaceId, id);
    if (!existing) return null;

    const merged = withoutMachineConfig({ ...existing, ...updates });
    const { rows } = await this.sql.query<AgentRow>(
      `update agents set
         name = $3, role = $4, avatar = $5, color = $6, description = $7, owner = $8, is_mine = $9,
         model_provider = $10, model_name = $11, reasoning_effort = $12, system_prompt = $13,
         autonomy_level = $14, temperature = $15, skills = $16, mcp_servers = $17,
         concurrency_limit = $18, is_archived = $19, allowed_users = $20,
         template_key = $21, template_version = $22, phase = $23, is_seeded = $24
       where workspace_id = $1 and id = $2
       returning *`,
      [
        workspaceId,
        id,
        merged.name,
        merged.role,
        merged.avatar,
        merged.color,
        merged.description,
        merged.owner,
        merged.isMine ?? true,
        merged.modelProvider,
        merged.modelName,
        merged.reasoningEffort ?? null,
        merged.systemPrompt ?? '',
        merged.autonomyLevel,
        merged.temperature ?? 0.7,
        JSON.stringify(merged.skills ?? []),
        JSON.stringify(merged.mcpServers ?? []),
        merged.concurrencyLimit ?? 2,
        merged.isArchived ?? false,
        merged.allowedUsers ?? null,
        merged.templateKey ?? null,
        merged.templateVersion ?? null,
        merged.phase ?? null,
        merged.isSeeded ?? false
      ]
    );
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const { rows } = await this.sql.query('delete from agents where workspace_id = $1 and id = $2 returning id', [
      workspaceId,
      id
    ]);
    return rows.length > 0;
  }

  /**
   * Alpha's official roles, once per workspace.
   *
   * `on conflict do nothing` against the partial unique index on
   * `(workspace_id, template_key)`, so this can run on every workspace create
   * and every boot: an existing role is left exactly as its owner has since
   * edited it, and a missing one is added.
   */
  async ensureOfficial(workspaceId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const template of OFFICIAL_AGENT_TEMPLATES) {
      const agent = withoutMachineConfig(agentFromOfficialTemplate(template, now));
      await this.sql.query(
        `insert into agents
           (id, workspace_id, name, role, avatar, color, description, owner, is_mine,
            model_provider, model_name, reasoning_effort, system_prompt, autonomy_level, temperature,
            skills, mcp_servers, concurrency_limit, is_archived, allowed_users,
            template_key, template_version, phase, is_seeded, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22, $23, true, $24)
         on conflict do nothing`,
        [
          agent.id,
          workspaceId,
          agent.name,
          agent.role,
          agent.avatar,
          agent.color,
          agent.description,
          agent.owner,
          agent.isMine ?? true,
          agent.modelProvider,
          agent.modelName,
          agent.reasoningEffort ?? null,
          agent.systemPrompt ?? '',
          agent.autonomyLevel,
          agent.temperature ?? 0.7,
          JSON.stringify(agent.skills ?? []),
          JSON.stringify(agent.mcpServers ?? []),
          agent.concurrencyLimit ?? 2,
          agent.isArchived ?? false,
          agent.allowedUsers ?? null,
          agent.templateKey ?? null,
          agent.templateVersion ?? null,
          agent.phase ?? null,
          now
        ]
      );
    }
  }
}

export class PostgresSquadStore implements SquadStore {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string): Promise<Squad[]> {
    const { rows } = await this.sql.query<SquadRow>('select * from squads where workspace_id = $1', [workspaceId]);
    return rows.map(toSquad);
  }

  async get(workspaceId: string, id: string): Promise<Squad | null> {
    const { rows } = await this.sql.query<SquadRow>(
      'select * from squads where workspace_id = $1 and id = $2',
      [workspaceId, id]
    );
    return rows[0] ? toSquad(rows[0]) : null;
  }

  async create(workspaceId: string, squad: Squad): Promise<Squad> {
    const { rows } = await this.sql.query<SquadRow>(
      `insert into squads
         (id, workspace_id, name, description, avatar, color, topology, leader_agent_id,
          member_agent_ids, mission, active_runs_count, completed_runs_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning *`,
      [
        squad.id,
        workspaceId,
        squad.name,
        squad.description ?? '',
        squad.avatar ?? '',
        squad.color ?? '',
        squad.topology,
        squad.leaderAgentId ?? null,
        JSON.stringify(squad.memberAgentIds ?? []),
        squad.mission ?? '',
        squad.activeRunsCount ?? 0,
        squad.completedRunsCount ?? 0
      ]
    );
    return toSquad(rows[0]);
  }

  async update(workspaceId: string, id: string, updates: Partial<Squad>): Promise<Squad | null> {
    const existing = await this.get(workspaceId, id);
    if (!existing) return null;

    const merged = { ...existing, ...updates };
    const { rows } = await this.sql.query<SquadRow>(
      `update squads set
         name = $3, description = $4, avatar = $5, color = $6, topology = $7, leader_agent_id = $8,
         member_agent_ids = $9, mission = $10, active_runs_count = $11, completed_runs_count = $12
       where workspace_id = $1 and id = $2
       returning *`,
      [
        workspaceId,
        id,
        merged.name,
        merged.description ?? '',
        merged.avatar ?? '',
        merged.color ?? '',
        merged.topology,
        merged.leaderAgentId ?? null,
        JSON.stringify(merged.memberAgentIds ?? []),
        merged.mission ?? '',
        merged.activeRunsCount ?? 0,
        merged.completedRunsCount ?? 0
      ]
    );
    return rows[0] ? toSquad(rows[0]) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const { rows } = await this.sql.query('delete from squads where workspace_id = $1 and id = $2 returning id', [
      workspaceId,
      id
    ]);
    return rows.length > 0;
  }
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  avatar: string | null;
  color: string | null;
  description: string | null;
  owner: string | null;
  is_mine: boolean | null;
  model_provider: string;
  model_name: string;
  reasoning_effort: string | null;
  system_prompt: string | null;
  autonomy_level: string;
  temperature: number | null;
  skills: string[] | null;
  mcp_servers: string[] | null;
  concurrency_limit: number | null;
  is_archived: boolean | null;
  allowed_users: string | null;
  template_key: string | null;
  template_version: number | null;
  phase: string | null;
  is_seeded: boolean | null;
  created_at: Date | string;
}

export interface SquadRow {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  color: string | null;
  topology: string;
  leader_agent_id: string | null;
  member_agent_ids: string[] | null;
  mission: string | null;
  active_runs_count: number | null;
  completed_runs_count: number | null;
}

export function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    role: row.role as Agent['role'],
    avatar: row.avatar ?? '',
    color: row.color ?? '',
    description: row.description ?? '',
    owner: row.owner ?? 'You',
    isMine: row.is_mine ?? true,
    modelProvider: row.model_provider as Agent['modelProvider'],
    modelName: row.model_name,
    reasoningEffort: (row.reasoning_effort ?? undefined) as Agent['reasoningEffort'],
    systemPrompt: row.system_prompt ?? '',
    autonomyLevel: row.autonomy_level as Agent['autonomyLevel'],
    temperature: row.temperature ?? 0.7,
    skills: row.skills ?? [],
    mcpServers: row.mcp_servers ?? [],
    concurrencyLimit: row.concurrency_limit ?? 2,
    isArchived: row.is_archived ?? false,
    /*
     * Defaulted on read, as the desktop does: a row written before the column
     * existed behaves like the form's own default, while the column stays
     * nullable so "never set" is still distinguishable from "set to team".
     */
    allowedUsers: (row.allowed_users ?? 'team') as Agent['allowedUsers'],
    templateKey: row.template_key ?? undefined,
    templateVersion: row.template_version ?? undefined,
    phase: (row.phase ?? undefined) as Agent['phase'],
    isSeeded: row.is_seeded ?? false,
    // Machine-local, and never stored here; see the class comment.
    customCliArgs: '',
    envVars: [],
    createdAt: new Date(row.created_at).toISOString()
  };
}

/**
 * An agent as a row of `agents`, for writers that are not this store.
 *
 * The desktop publishes its own agents through the Data API and has to send
 * the same columns. `withoutMachineConfig` again here, not as a courtesy: the
 * CLI arguments and environment of an agent are input to a process on the
 * machine that runs it, and `0003` dropped the columns for them.
 */
export function agentRow(workspaceId: string, agent: Agent): Record<string, unknown> {
  const shared = withoutMachineConfig(agent);
  return {
    id: shared.id,
    workspace_id: workspaceId,
    name: shared.name,
    role: shared.role,
    avatar: shared.avatar ?? '',
    color: shared.color ?? '',
    description: shared.description ?? '',
    owner: shared.owner ?? null,
    is_mine: shared.isMine ?? true,
    model_provider: shared.modelProvider,
    model_name: shared.modelName,
    reasoning_effort: shared.reasoningEffort ?? null,
    system_prompt: shared.systemPrompt ?? '',
    autonomy_level: shared.autonomyLevel,
    temperature: shared.temperature ?? 0.7,
    skills: shared.skills ?? [],
    mcp_servers: shared.mcpServers ?? [],
    concurrency_limit: shared.concurrencyLimit ?? 2,
    is_archived: shared.isArchived ?? false,
    allowed_users: shared.allowedUsers ?? null,
    template_key: shared.templateKey ?? null,
    template_version: shared.templateVersion ?? null,
    phase: shared.phase ?? null,
    is_seeded: shared.isSeeded ?? false,
    created_at: shared.createdAt || new Date().toISOString()
  };
}

/** A squad as a row of `squads`; see `agentRow`. */
export function squadRow(workspaceId: string, squad: Squad): Record<string, unknown> {
  return {
    id: squad.id,
    workspace_id: workspaceId,
    name: squad.name,
    description: squad.description ?? '',
    avatar: squad.avatar ?? '',
    color: squad.color ?? '',
    topology: squad.topology,
    leader_agent_id: squad.leaderAgentId ?? null,
    member_agent_ids: squad.memberAgentIds ?? [],
    mission: squad.mission ?? '',
    active_runs_count: squad.activeRunsCount ?? 0,
    completed_runs_count: squad.completedRunsCount ?? 0
  };
}

export function toSquad(row: SquadRow): Squad {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    avatar: row.avatar ?? '',
    color: row.color ?? '',
    topology: row.topology as Squad['topology'],
    leaderAgentId: row.leader_agent_id ?? undefined,
    memberAgentIds: row.member_agent_ids ?? [],
    mission: row.mission ?? '',
    activeRunsCount: row.active_runs_count ?? 0,
    completedRunsCount: row.completed_runs_count ?? 0
  } as Squad;
}
