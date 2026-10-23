/**
 * Alpha's project files tools, as a stdio MCP server.
 *
 * Gives a chat turn read-only access to the selected project's repositories
 * on this computer, and nothing else. The folders arrive in
 * ALPHA_PROJECT_ROOTS from the per-turn config mcpConfigService writes; every
 * path is checked against them in projectFiles. See that module for why the
 * agent CLI's own file tools are not used for this.
 *
 * Entry point only -- nothing imports this.
 */
import { createInterface } from 'node:readline';

import {
  listFiles,
  listRepositories,
  parseRoots,
  readFile,
  runGit,
  searchFiles
} from '../services/projectFiles.js';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

const ROOTS = parseRoots(process.env.ALPHA_PROJECT_ROOTS);

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>) => unknown | Promise<unknown>;
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});
const repository = str('Repository folder name or owner/repo. Optional when the project has one repository on this computer.');

const TOOLS: Record<string, ToolDef> = {
  project_list_repositories: {
    description: 'List the project repositories on this computer that you can read, with their folders.',
    inputSchema: schema({}),
    run: () => listRepositories(ROOTS)
  },
  project_list_files: {
    description: 'List files and folders in one of the project repositories. Dependencies and build output are named but not listed.',
    inputSchema: schema({
      repository,
      path: str('Folder inside the repository, relative to it. Empty for the top level.'),
      depth: int('How many levels to list, 1 to 4. Default 2.')
    }),
    run: args => listFiles(ROOTS, args)
  },
  project_read_file: {
    description: 'Read a text file in one of the project repositories, with line numbers. Secret files such as .env are not shown.',
    inputSchema: schema({
      repository,
      path: str('File path, relative to the repository or absolute inside it.'),
      start_line: int('First line to show. Default 1.'),
      max_lines: int('How many lines, up to 2000. Default 400.')
    }, ['path']),
    run: args => readFile(ROOTS, args)
  },
  project_search: {
    description: 'Search the text of the project repositories. Returns file:line: text for each match.',
    inputSchema: schema({
      query: str('Text to find, or a regular expression when regex is true.'),
      repository: str('Limit to one repository. Default: all of them.'),
      path: str('Limit to a folder or file inside the repository.'),
      regex: bool('Treat query as a regular expression.'),
      case_sensitive: bool('Match case. Default false.'),
      max_results: int('Up to 300. Default 100.')
    }, ['query']),
    run: args => searchFiles(ROOTS, args)
  },
  project_git: {
    description: 'Read git state of a project repository: status, log, diff (working tree, or against a ref), or branches. Read only.',
    inputSchema: schema({
      repository,
      command: str('status, log, diff or branches.', { enum: ['status', 'log', 'diff', 'branches'] }),
      ref: str('For log and diff: a branch, tag, commit or range such as main...HEAD.'),
      path: str('Limit to a file or folder inside the repository.'),
      max_count: int('For log: how many commits, up to 50. Default 20.')
    }, ['command']),
    run: args => runGit(ROOTS, args)
  }
};

type Id = string | number | null;

/** stdout is the transport; anything logged goes to stderr. */
const realWrite = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;
console.debug = console.log;

function send(message: Record<string, unknown>): void {
  realWrite(JSON.stringify(message) + '\n');
}
const reply = (id: Id, result: unknown) => send({ jsonrpc: '2.0', id, result });
const replyError = (id: Id, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });
const toolResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'alpha-project-files', version: '1.0.0' }
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
        }))
      });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) return reply(id, toolResult('Unknown tool: ' + name, true));
      try {
        const value = await tool.run(params?.arguments ?? {});
        return reply(id, toolResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
      } catch (err: any) {
        return reply(id, toolResult(err?.message ?? String(err), true));
      }
    }
    default:
      return replyError(id, -32601, 'Method not found: ' + method);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return replyError(null, -32700, 'Parse error');
  }
  handle(msg).catch(err => replyError(msg?.id ?? null, -32603, err?.message ?? String(err)));
});
rl.on('close', () => process.exit(0));

