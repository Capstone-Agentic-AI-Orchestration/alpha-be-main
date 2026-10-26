import { Request, Response, Router } from 'express';

import { IS_CLOUD } from '../config/env.js';
import {
  BUILTIN_SERVERS,
  readCatalog,
  builtinServerNames,
  isHttpSpec,
  upsertCatalogServer,
  removeCatalogServer
} from '../services/mcpConfigService.js';
import { sqliteService } from '../services/sqliteService.js';
import { agentStore } from '../store/stores.js';
import { database } from '../store/database.js';
import { PostgresWorkspaceMcpCatalogStore } from '../store/workspaceMcpCatalogStore.js';
import { mcpNameError, mcpServerError, toServerSpec } from './mcpValidation.js';
import { logInfo } from '../utils/logger.js';
import { requireWorkspaceCapability } from './workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { supabaseService } from '../services/supabaseService.js';

export const mcpRouter = Router();

interface McpServerView {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  /** Key names only; credential values stay server-side and on the run machine. */
  envKeys?: string[];
  url?: string;
  headerKeys?: string[];
  builtin: boolean;
  overridden: boolean;
  grantedTo: string[];
}

function cloudCatalogStore(): PostgresWorkspaceMcpCatalogStore {
  return new PostgresWorkspaceMcpCatalogStore(database());
}

async function buildServerViews(
  workspaceId: string,
  sharedCatalog: Record<string, import('../services/mcpConfigService.js').McpServerSpec>,
  localCatalog: Record<string, import('../services/mcpConfigService.js').McpServerSpec> = {}
): Promise<McpServerView[]> {
  const catalog = { ...localCatalog, ...sharedCatalog };
  const all = { ...BUILTIN_SERVERS, ...catalog };
  const builtins = new Set(builtinServerNames());

  const agents = IS_CLOUD
    ? await agentStore().list(workspaceId)
    : workspaceRegistry.scope('agents', sqliteService.getAgents(), workspaceId);

  return Object.entries(all).map(([name, spec]) => {
    const shared = {
      name,
      builtin: builtins.has(name),
      overridden: builtins.has(name) && name in catalog,
      grantedTo: agents.filter(agent => (agent.mcpServers ?? []).includes(name)).map(agent => agent.id)
    };

    return isHttpSpec(spec)
      ? {
          ...shared,
          transport: spec.type,
          url: spec.url,
          headerKeys: Object.keys(spec.headers ?? {})
        }
      : {
          ...shared,
          transport: 'stdio' as const,
          command: spec.command,
          args: spec.args ?? [],
          envKeys: Object.keys(spec.env ?? {})
        };
  });
}

/** A workspace catalog takes precedence over the machine's optional local fallback. */
async function serverViews(workspaceId: string): Promise<McpServerView[]> {
  if (IS_CLOUD) return buildServerViews(workspaceId, await cloudCatalogStore().list(workspaceId));
  const sharedViews = await supabaseService.workspaceMcpServerViews(workspaceId);
  if (sharedViews) return sharedViews;
  return buildServerViews(workspaceId, {}, readCatalog());
}

mcpRouter.get('/mcp/servers/catalog', async (req: Request, res: Response) => {
  if (!IS_CLOUD) return res.status(404).json({ error: 'Workspace MCP sync is available through Alpha Cloud.' });
  const session = req.session;
  if (!session || session.ticketAuthentication.kind !== 'verified_github_bearer') {
    return res.status(401).json({ error: 'This endpoint is for a signed-in Alpha desktop.' });
  }

  try {
    const context = await workspaceRegistry.resolve(
      session.login,
      req.header('X-Workspace-Id') || undefined,
      session.role
    );
    if (!context) return res.status(403).json({ error: 'You do not have access to the requested workspace.' });
    if (!workspaceRegistry.can(context.role, 'mcp.read')) {
      return res.status(403).json({ error: 'Your workspace role cannot read the MCP catalog.' });
    }

    const catalog = await cloudCatalogStore().list(context.workspaceId);
    return res.json({ servers: await buildServerViews(context.workspaceId, catalog) });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Could not load the workspace MCP catalog.' });
  }
});

mcpRouter.get('/mcp/servers/runtime', async (req: Request, res: Response) => {
  if (!IS_CLOUD) return res.status(404).json({ error: 'Workspace MCP sync is available through Alpha Cloud.' });
  const session = req.session;
  if (!session || session.ticketAuthentication.kind !== 'verified_github_bearer') {
    return res.status(401).json({ error: 'This endpoint is for a signed-in Alpha desktop.' });
  }

  try {
    const context = await workspaceRegistry.resolve(
      session.login,
      req.header('X-Workspace-Id') || undefined,
      session.role
    );
    if (!context) return res.status(403).json({ error: 'You do not have access to the requested workspace.' });
    if (!workspaceRegistry.can(context.role, 'mcp.execute')) {
      return res.status(403).json({ error: 'Your workspace role cannot run workspace MCP servers.' });
    }
    if (!workspaceRegistry.can(context.role, 'agent.run')) {
      return res.status(403).json({ error: 'Your workspace role cannot run personas.' });
    }

    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
    if (!agentId) return res.status(400).json({ error: 'An agentId is required.' });
    if (!workspaceRegistry.inWorkspace(context, 'agents', agentId)) {
      return res.status(404).json({ error: 'Persona not found in the active workspace.' });
    }
    const agent = await agentStore().get(context.workspaceId, agentId);
    if (!agent || agent.isArchived) return res.status(404).json({ error: 'Persona not found in the active workspace.' });
    if (agent.allowedUsers === 'admins' && context.role !== 'admin') {
      return res.status(403).json({ error: 'You cannot run this persona.' });
    }
    if (agent.allowedUsers === 'private' && agent.owner !== context.userId) {
      return res.status(403).json({ error: 'You cannot run this persona.' });
    }

    // Only this persona's grants get executable specs. Browser sessions cannot call this endpoint.
    const catalog = await cloudCatalogStore().list(context.workspaceId);
    const mcpServers = agent.mcpServers ?? [];
    const servers = Object.fromEntries(mcpServers
      .filter(name => name in catalog)
      .map(name => [name, catalog[name]]));
    return res.json({ mcpServers, servers });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Could not load workspace MCP servers.' });
  }
});

mcpRouter.get('/mcp/servers', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'mcp.read')) return;
  try {
    res.json(await serverViews(req.workspace!.workspaceId));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not read the MCP catalog' });
  }
});

mcpRouter.put('/mcp/servers/:name', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'mcp.manage')) return;
  const { name } = req.params;

  const nameError = mcpNameError(name);
  if (nameError) return res.status(400).json({ error: nameError });

  const specError = mcpServerError(req.body);
  if (specError) return res.status(400).json({ error: specError });

  try {
    const spec = toServerSpec(req.body);
    if (IS_CLOUD) {
      await cloudCatalogStore().upsert(req.workspace!.workspaceId, name, spec, req.workspace!.userId);
    } else {
      // A connected team desktop publishes its edit before changing the local
      // fallback, so a failed shared write never looks like a saved workspace edit.
      await supabaseService.shareWorkspaceMcpServer(req.workspace!.workspaceId, name, spec, req.workspace!.userId);
      upsertCatalogServer(name, spec);
    }

    logInfo(`MCP catalog: wrote "${name}" in workspace ${req.workspace!.workspaceId}`);
    res.json(await serverViews(req.workspace!.workspaceId));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not write the MCP catalog' });
  }
});

mcpRouter.delete('/mcp/servers/:name', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'mcp.manage')) return;
  const { name } = req.params;

  try {
    const removed = IS_CLOUD
      ? await cloudCatalogStore().remove(req.workspace!.workspaceId, name)
      : (await supabaseService.unshareWorkspaceMcpServer(req.workspace!.workspaceId, name), removeCatalogServer(name));

    if (!removed) {
      return res.status(404).json({
        error: builtinServerNames().includes(name)
          ? `"${name}" ships with Alpha and cannot be removed. Add a catalog entry of the same name to override it.`
          : `No MCP server named "${name}" in the workspace catalog.`
      });
    }

    logInfo(`MCP catalog: removed "${name}" from workspace ${req.workspace!.workspaceId}`);
    res.json(await serverViews(req.workspace!.workspaceId));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not write the MCP catalog' });
  }
});
