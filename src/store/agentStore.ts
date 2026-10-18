import type { Agent, Squad } from '../models/index.js';

/**
 * The roster: agents and the squads they work in.
 *
 * Shared in the cloud, per-machine on a desktop. Both are behind one
 * interface, and both are workspace-scoped -- an agent belongs to exactly one
 * workspace, and a squad names agents from its own.
 */
export interface AgentStore {
  list(workspaceId: string): Promise<Agent[]>;
  get(workspaceId: string, id: string): Promise<Agent | null>;
  create(workspaceId: string, agent: Agent): Promise<Agent>;
  update(workspaceId: string, id: string, updates: Partial<Agent>): Promise<Agent | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  share(workspaceId: string, id: string, workspaceIds: string[]): Promise<Agent | null>;
  unshare(workspaceId: string, id: string): Promise<Agent | null>;
  syncShared(workspaceId: string, workspaceIds: string[]): Promise<void>;
  /**
   * Give a workspace Alpha's official roles, once.
   *
   * Idempotent on the template key, so it can run on every workspace create
   * and every boot without piling up copies.
   */
  ensureOfficial(workspaceId: string): Promise<void>;
}

export interface SquadStore {
  list(workspaceId: string): Promise<Squad[]>;
  get(workspaceId: string, id: string): Promise<Squad | null>;
  create(workspaceId: string, squad: Squad): Promise<Squad>;
  update(workspaceId: string, id: string, updates: Partial<Squad>): Promise<Squad | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

/**
 * What an agent row does not carry into a shared table.
 *
 * `customCliArgs` and `envVars` are the flags and environment an agent runs
 * with on somebody's machine -- an argument list is a command, and the
 * environment holds credentials. `0003` dropped both columns from the cloud
 * schema; this is the same rule for the value on its way there.
 */
export function withoutMachineConfig(agent: Agent): Agent {
  const { customCliArgs: _args, envVars: _env, ...rest } = agent;
  return { ...rest, customCliArgs: '', envVars: [] };
}
