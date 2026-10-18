import type { Agent, Squad } from '../models/index.js';
import { createHash, randomUUID } from 'node:crypto';
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
    if (existing.sharedKey) {
      const { rows: sharedRows } = await this.sql.query<{ shared_key: string | null }>(
        'select shared_key from agents where workspace_id = $1 and id = $2',
        [workspaceId, id]
      );
      const sharedKey = sharedRows[0]?.shared_key;
      if (sharedKey) {
        await this.sql.query(
          `update agents set
             name = $2, role = $3, avatar = $4, color = $5, description = $6,
             owner = $7, is_mine = $8, model_provider = $9, model_name = $10,
             reasoning_effort = $11, system_prompt = $12, autonomy_level = $13,
             temperature = $14, skills = $15, concurrency_limit = $16,
             is_archived = $17, allowed_users = $18, template_key = $19,
             template_version = $20, phase = $21, is_seeded = $22
           where shared_key = $1`,
          [
            sharedKey, merged.name, merged.role, merged.avatar, merged.color, merged.description,
            merged.owner, merged.isMine ?? true, merged.modelProvider, merged.modelName,
            merged.reasoningEffort ?? null, merged.systemPrompt ?? '', merged.autonomyLevel,
            merged.temperature ?? 0.7, JSON.stringify(merged.skills ?? []),
            merged.concurrencyLimit ?? 2, merged.isArchived ?? false, merged.allowedUsers ?? null,
            merged.templateKey ?? null, merged.templateVersion ?? null, merged.phase ?? null,
            merged.isSeeded ?? false
          ]
        );
      }
    }
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const { rows } = await this.sql.query('delete from agents where workspace_id = $1 and id = $2 returning id', [
      workspaceId,
      id
    ]);
    return rows.length > 0;
  }

  async share(workspaceId: string, id: string, workspaceIds: string[]): Promise<Agent | null> {
    const { rows } = await this.sql.query<AgentRow & { shared_key: string | null }>(
      'select * from agents where workspace_id = $1 and id = $2', [workspaceId, id]
    );
    const source = rows[0];
    if (!source) return null;
    const sharedKey = source.shared_key ?? `shared-${randomUUID()}`;
    await this.sql.query('update agents set shared_key = $3 where workspace_id = $1 and id = $2', [workspaceId, id, sharedKey]);
    for (const targetWorkspaceId of new Set([workspaceId, ...workspaceIds])) {
      if (targetWorkspaceId === workspaceId) continue;
      if (source.template_key) {
        const { rows: templateRows } = await this.sql.query<{ id: string }>(
          'select id from agents where workspace_id = $1 and template_key = $2',
          [targetWorkspaceId, source.template_key]
        );
        if (templateRows[0]) {
          await this.sql.query(
            'update agents set shared_key = $3 where workspace_id = $1 and id = $2',
            [targetWorkspaceId, templateRows[0].id, sharedKey]
          );
          continue;
        }
      }
      await this.copySharedAgent(source.id, targetWorkspaceId, sharedKey);
    }
    return this.get(workspaceId, id);
  }

  async unshare(workspaceId: string, id: string): Promise<Agent | null> {
    const { rows } = await this.sql.query<{ shared_key: string | null; template_key: string | null }>(
      'select shared_key, template_key from agents where workspace_id = $1 and id = $2', [workspaceId, id]
    );
    const key = rows[0]?.template_key ? null : rows[0]?.shared_key;
    if (key) {
      await this.sql.query('update agents set shared_key = null where workspace_id = $1 and id = $2', [workspaceId, id]);
    }
    return this.get(workspaceId, id);
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
      const sharedKey = `official:${template.key}`;
      const { rows: present } = await this.sql.query<{ id: string }>(
        'select id from agents where workspace_id = $1 and template_key = $2', [workspaceId, template.key]
      );
      if (present[0]) {
        await this.sql.query(
          'update agents set shared_key = $3 where workspace_id = $1 and id = $2',
          [workspaceId, present[0].id, sharedKey]
        );
        const { rows: sharedCopy } = await this.sql.query<{ id: string }>(
          'select id from agents where shared_key = $1 and workspace_id <> $2 order by created_at asc limit 1',
          [sharedKey, workspaceId]
        );
        if (sharedCopy[0]) await this.syncSharedProfile(sharedCopy[0].id, workspaceId, present[0].id);
        continue;
      }
      const { rows: sharedTemplate } = await this.sql.query<{ id: string }>(
        'select id from agents where shared_key = $1 order by created_at asc limit 1', [sharedKey]
      );
      if (sharedTemplate[0]) {
        await this.copySharedAgent(sharedTemplate[0].id, workspaceId, sharedKey);
        continue;
      }
      const { rows: idCollision } = await this.sql.query<{ id: string }>(
        'select id from agents where id = $1', [agent.id]
      );
      if (idCollision.length) {
        const digest = createHash('sha256').update(`${workspaceId}:${template.key}`).digest('hex').slice(0, 16);
        const baseId = `agent-${template.key}-${digest}`;
        agent.id = baseId;
        let suffix = 2;
        while ((await this.sql.query('select 1 from agents where id = $1', [agent.id])).rows.length) {
          agent.id = `${baseId}-${suffix++}`;
        }
      }
      await this.sql.query(
        `insert into agents
           (id, workspace_id, name, role, avatar, color, description, owner, is_mine,
            model_provider, model_name, reasoning_effort, system_prompt, autonomy_level, temperature,
            skills, mcp_servers, concurrency_limit, is_archived, allowed_users,
            template_key, template_version, phase, is_seeded, created_at, shared_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22, $23, true, $24, $25)
         on conflict (workspace_id, template_key) where template_key is not null do nothing`,
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
          now,
          sharedKey
        ]
      );
    }
  }

  async syncShared(workspaceId: string, workspaceIds: string[]): Promise<void> {
    if (!workspaceIds.includes(workspaceId)) return;
    const { rows: shared } = await this.sql.query<{ id: string; shared_key: string }>(
      `select distinct on (a.shared_key) a.id, a.shared_key
       from agents a
       where a.shared_key is not null and a.template_key is null and a.workspace_id = any($1::text[])
       order by a.shared_key, a.created_at asc`,
      [workspaceIds]
    );
    for (const agent of shared) await this.copySharedAgent(agent.id, workspaceId, agent.shared_key);
  }

  private async copySharedAgent(sourceId: string, workspaceId: string, sharedKey: string): Promise<void> {
    const id = `agent-shared-${randomUUID()}`;
    await this.sql.query(
      `insert into agents
         (id, workspace_id, name, role, avatar, color, description, owner, is_mine,
          model_provider, model_name, reasoning_effort, system_prompt, autonomy_level, temperature,
          skills, mcp_servers, concurrency_limit, is_archived, allowed_users,
          template_key, template_version, phase, is_seeded, created_at, shared_key)
       select $1, $2, name, role, avatar, color, description, owner, is_mine,
          model_provider, model_name, reasoning_effort, system_prompt, autonomy_level, temperature,
          skills, '[]'::jsonb, concurrency_limit, is_archived, allowed_users,
          template_key, template_version, phase, is_seeded, created_at, $3
       from agents where id = $4
       on conflict (workspace_id, shared_key) where shared_key is not null do nothing`,
      [id, workspaceId, sharedKey, sourceId]
    );
  }

  private async syncSharedProfile(sourceId: string, targetWorkspaceId: string, targetId: string): Promise<void> {
    const { rows } = await this.sql.query<AgentRow>('select * from agents where id = $1', [sourceId]);
    if (!rows[0]) return;
    const source = toAgent(rows[0]);
    const {
      mcpServers: _mcpServers,
      envVars: _envVars,
      customCliArgs: _customCliArgs,
      ...profile
    } = source;
    await this.update(targetWorkspaceId, targetId, profile);
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
  shared_key: string | null;
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
    owner: row.owner ?? 'Unassigned',
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
    sharedKey: row.shared_key ?? undefined,
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
    shared_key: shared.sharedKey ?? null,
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
