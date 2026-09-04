import { Request, Response, Router } from 'express';

import {
  availableServers,
  readCatalog,
  builtinServerNames,
  isHttpSpec,
  upsertCatalogServer,
  removeCatalogServer
} from '../services/mcpConfigService.js';
import { sqliteService } from '../services/sqliteService.js';
import { mcpNameError, mcpServerError, toServerSpec } from './mcpValidation.js';
import { logInfo } from '../utils/logger.js';

export const mcpRouter = Router();

/**
 * The MCP catalog, as the UI needs to render it.
 *
 * Alpha's own registry is the only source an agent can be granted from — the
 * runner passes `--strict-mcp-config` unconditionally, so nothing the operator
 * has configured for their personal CLI is reachable. This endpoint is
 * therefore the complete list, not a subset of a larger one.
 */
interface McpServerView {
  name: string;
  /** Which shape the rest of this object takes. */
  transport: "stdio" | "http" | "sse";

  /** stdio only — the command Alpha spawns, and its argv. */
  command?: string;
  args?: string[];
  /**
   * Key names only, never values.
   *
   * A catalog entry can legitimately carry an API token. Returning the values
   * would put them in every render of the settings panel and in the browser's
   * memory, for a field the UI only ever needs to *count* and *replace*.
   */
  envKeys?: string[];

  /** http/sse only — the endpoint the CLI connects to. */
  url?: string;
  /** Header names only, for the same reason envKeys omits values. */
  headerKeys?: string[];
  /** Ships with Alpha, lives in code rather than the catalog file. */
  builtin: boolean;
  /** A catalog entry is shadowing a built-in of the same name. */
  overridden: boolean;
  /** Agent ids currently granting this server, so a delete can warn first. */
  grantedTo: string[];
}

function serverViews(): McpServerView[] {
  const all = availableServers();
  const catalog = readCatalog();
  const builtins = new Set(builtinServerNames());

  // Read once for the whole list rather than once per server.
  const agents = sqliteService.getAgents();

  return Object.entries(all).map(([name, spec]) => {
    const shared = {
      name,
      builtin: builtins.has(name),
      overridden: builtins.has(name) && name in catalog,
      grantedTo: agents.filter(a => (a.mcpServers ?? []).includes(name)).map(a => a.id)
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
          transport: "stdio" as const,
          command: spec.command,
          args: spec.args ?? [],
          envKeys: Object.keys(spec.env ?? {})
        };
  });
}

mcpRouter.get('/mcp/servers', (req: Request, res: Response) => {
  try {
    res.json(serverViews());
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not read the MCP catalog' });
  }
});

mcpRouter.put('/mcp/servers/:name', (req: Request, res: Response) => {
  const { name } = req.params;

  const nameError = mcpNameError(name);
  if (nameError) return res.status(400).json({ error: nameError });

  const specError = mcpServerError(req.body);
  if (specError) return res.status(400).json({ error: specError });

  try {
    upsertCatalogServer(name, toServerSpec(req.body));
    logInfo(`MCP catalog: wrote "${name}"`);
    // The whole list back, not just the one written: saving can change another
    // row's `overridden` flag, and the panel would otherwise show it stale.
    res.json(serverViews());
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not write the MCP catalog' });
  }
});

mcpRouter.delete('/mcp/servers/:name', (req: Request, res: Response) => {
  const { name } = req.params;

  try {
    const removed = removeCatalogServer(name);
    if (!removed) {
      /**
       * A built-in that was never shadowed is the likely case here, and it is
       * not a server the catalog can delete — it lives in Alpha's code. Saying
       * so is more useful than a bare 404, because the panel shows built-ins in
       * the same list as everything else.
       */
      return res.status(404).json({
        error: builtinServerNames().includes(name)
          ? `"${name}" ships with Alpha and cannot be removed. Add a catalog entry of the same name to override it.`
          : `No MCP server named "${name}" in the catalog.`
      });
    }

    logInfo(`MCP catalog: removed "${name}"`);
    res.json(serverViews());
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not write the MCP catalog' });
  }
});
