/**
 * Alpha's GitHub MCP server.
 *
 * Runs as a short-lived stdio subprocess of whichever agent CLI is executing a
 * turn, and exposes `githubService` as MCP tools. Two consequences of building
 * on that service rather than shelling to `gh` directly:
 *
 *   * It works in both deployments. `githubService` dispatches on auth mode —
 *     `gh` on the desktop, REST/GitHub App on a hosted container — so the same
 *     tools resolve correctly in either, with no second credential path.
 *   * Alpha handles no token. On the desktop `gh` reads the OS keyring itself;
 *     nothing passes through this process, no config file, no env var.
 *
 * Nothing here mutates GitHub. `github_clone_repository` is the only tool that
 * writes at all, and it writes to this machine — into the managed workspace,
 * at a path Alpha computes. Pushing, opening PRs and merging stay out: those
 * change state other people can see, and they need an approval story this
 * layer does not have.
 *
 * The JSON-RPC is hand-rolled rather than taken from @modelcontextprotocol/sdk
 * because that package is ESM-only and this backend compiles to CommonJS. The
 * tools-only subset of MCP is four methods, so the dependency bought less than
 * the module-system mismatch cost.
 *
 * Entry point only — nothing imports this. It is spawned by the per-run config
 * that `mcpConfigService` writes.
 */
import { createInterface } from 'node:readline';

import { githubService } from '../services/githubService.js';
import { cloneToWorkspace } from '../services/repoCloneService.js';

/** Newest protocol version this server implements. */
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string, min: number, max: number) => ({
  type: 'integer',
  description,
  minimum: min,
  maximum: max
});

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const TOOLS: Record<string, ToolDef> = {
  github_check_access: {
    description:
      'Check whether the signed-in GitHub account can reach a repository. Returns its default branch, visibility, and whether it is empty. Use this first when asked whether a repo is reachable.',
    inputSchema: schema({ repo: str('Repository as owner/name, e.g. octocat/hello-world') }, ['repo']),
    run: async ({ repo }) => {
      const info = await githubService.getRepository(repo);
      return {
        reachable: true,
        ...info,
        ...(info.isEmpty ? { note: 'Repository exists but has no commits yet.' } : {})
      };
    }
  },

  github_list_branches: {
    description: 'List branches on a remote repository, with whether each is protected.',
    inputSchema: schema(
      { repo: str('Repository as owner/name'), limit: int('Max branches (default 50)', 1, 100) },
      ['repo']
    ),
    run: ({ repo, limit }) => githubService.listBranches(repo, limit)
  },

  github_read_file: {
    description: 'Read a single file from a remote repository without cloning it.',
    inputSchema: schema(
      {
        repo: str('Repository as owner/name'),
        path: str('File path inside the repository, e.g. .github/workflows/ci.yml'),
        ref: str('Branch, tag or commit SHA. Defaults to the default branch.')
      },
      ['repo', 'path']
    ),
    run: ({ repo, path, ref }) => githubService.getFileContents(repo, path, ref)
  },

  github_list_repositories: {
    description: 'List repositories the signed-in account can see.',
    inputSchema: schema({ limit: int('Max repositories (default 30)', 1, 100) }),
    run: ({ limit }) => githubService.listRepositories(limit)
  },

  github_list_organizations: {
    description:
      'List GitHub organizations the signed-in account belongs to, with the role held in each.',
    inputSchema: schema({}),
    run: () => githubService.listOrganizations()
  },

  github_workflow_runs: {
    description:
      'List recent GitHub Actions runs for a repository or local checkout, with status and conclusion.',
    inputSchema: schema({
      repo: str('Repository as owner/name, or a local path. Defaults to the current workspace.'),
      limit: int('Max runs (default 15)', 1, 50)
    }),
    run: ({ repo, limit }) => githubService.getWorkflowRuns(repo, limit)
  },

  github_failed_run_logs: {
    description:
      'Fetch log output of the failed steps in a workflow run. Use after github_workflow_runs identifies a failure.',
    inputSchema: schema(
      {
        repo: str('Repository as owner/name, or a local path'),
        runId: str('Workflow run id from github_workflow_runs')
      },
      ['repo', 'runId']
    ),
    run: ({ repo, runId }) => githubService.getFailedWorkflowLogs(repo, runId)
  },

  github_clone_repository: {
    description:
      'Clone a repository onto this machine so its files can be worked on locally. Alpha chooses the destination inside its managed workspace — do not ask for a path and do not run git yourself. Cloning a repository that is already checked out refreshes it instead. Returns the local path.',
    inputSchema: schema(
      {
        repo: str('Repository as owner/name'),
        ref: str('Branch to check out. Defaults to the repository default branch.')
      },
      ['repo']
    ),
    run: async ({ repo, ref }) => {
      const result = await cloneToWorkspace(repo, ref);
      return {
        ...result,
        note:
          result.action === 'refreshed'
            ? 'An existing checkout was reset to the remote state.'
            : 'Cloned fresh.'
      };
    }
  },

  github_auth_status: {
    description:
      'Report how Alpha is authenticated to GitHub and as whom. Use when a call fails and the cause may be sign-in rather than permissions.',
    inputSchema: schema({}),
    run: () => githubService.checkAuth()
  }
};

// ─── JSON-RPC plumbing ────────────────────────────────────────────────────────

type Id = string | number | null;

function send(message: Record<string, unknown>): void {
  realWrite(JSON.stringify(message) + '\n');
}

function reply(id: Id, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: Id, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * A failing tool answers with `isError` content rather than a JSON-RPC error.
 *
 * A protocol error is invisible to the model — the CLI reports "tool failed"
 * and the turn stalls. "Cannot reach owner/repo, it may be private" is exactly
 * what the agent should be relaying back, so it belongs in the content.
 */
function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg ?? {};

  // Notifications carry no id and must never be answered.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        // Echo the client's version when we speak it, so an older CLI is not
        // forced onto a newer one it may not parse.
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'alpha-github', version: '1.0.0' }
      });
    }

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      });

    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) {
        return reply(id, toolResult(`Unknown tool: ${name}`, true));
      }
      try {
        const value = await tool.run(params?.arguments ?? {});
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return reply(id, toolResult(text));
      } catch (err: any) {
        return reply(id, toolResult(err?.message ?? String(err), true));
      }
    }

    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * stdout is the transport. `githubService` logs through the shared logger,
 * which writes to stdout via console.log — one such line between two frames
 * corrupts the stream and the CLI drops the server. Route console output to
 * stderr, and keep a private handle to the real writer for frames.
 */
const realWrite = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;
console.debug = console.log;

const rl = createInterface({ input: process.stdin });

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // A frame we cannot parse has no id to answer against; the spec's parse
    // error uses a null id.
    return replyError(null, -32700, 'Parse error');
  }

  handle(msg).catch(err => {
    replyError(msg?.id ?? null, -32603, err?.message ?? String(err));
  });
});

rl.on('close', () => process.exit(0));
