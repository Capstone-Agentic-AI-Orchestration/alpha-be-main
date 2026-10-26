import type { Sql } from './database.js';
import type { McpServerSpec } from '../services/mcpConfigService.js';

export interface WorkspaceMcpServer {
  name: string;
  spec: McpServerSpec;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceMcpCatalogStore {
  list(workspaceId: string): Promise<Record<string, McpServerSpec>>;
  upsert(workspaceId: string, name: string, spec: McpServerSpec, actor: string): Promise<void>;
  remove(workspaceId: string, name: string): Promise<boolean>;
}

/** Workspace-shared MCP definitions. Credentials are never returned by the admin-facing API. */
export class PostgresWorkspaceMcpCatalogStore implements WorkspaceMcpCatalogStore {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string): Promise<Record<string, McpServerSpec>> {
    const { rows } = await this.sql.query<{ name: string; server_config: McpServerSpec }>(
      `select name, server_config from workspace_mcp_servers
       where workspace_id = $1 order by name asc`,
      [workspaceId]
    );
    return Object.fromEntries(rows.map(row => [row.name, row.server_config]));
  }

  async upsert(workspaceId: string, name: string, spec: McpServerSpec, actor: string): Promise<void> {
    await this.sql.query(
      `insert into workspace_mcp_servers (workspace_id, name, server_config, updated_by)
       values ($1, $2, $3::jsonb, $4)
       on conflict (workspace_id, name) do update
         set server_config = excluded.server_config,
             updated_by = excluded.updated_by,
             updated_at = now()`,
      [workspaceId, name, JSON.stringify(spec), actor]
    );
  }

  async remove(workspaceId: string, name: string): Promise<boolean> {
    const { rows } = await this.sql.query<{ name: string }>(
      `delete from workspace_mcp_servers where workspace_id = $1 and name = $2 returning name`,
      [workspaceId, name]
    );
    return rows.length > 0;
  }
}
