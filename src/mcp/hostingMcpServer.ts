/**
 * Alpha's hosting tools for agents, as a stdio MCP server.
 *
 * Entry point only -- nothing imports this. It is spawned by the per-run
 * config `mcpConfigService` writes, as a grandchild of the daemon (daemon ->
 * agent CLI -> this). It holds no Render, Vercel or GitHub credential and
 * has no sign-in: every tool is a call back to the daemon's agent bridge,
 * carrying the run token the daemon minted for this run. The bridge decides
 * what the token may reach -- only this run's project repositories -- and the
 * cloud acts as the person who started the run, recording the agent.
 *
 * Values an agent sets are never echoed back, and the run log masks them
 * (see `toolInputRedaction`). Changing production (`main`) does not happen
 * here at all: it is queued for a person to approve in the run view.
 */
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

/** Set by the daemon; see `runBridge`. Never logged. */
const DAEMON_URL = process.env.ALPHA_DAEMON_URL ?? '';
const RUN_TOKEN = process.env.ALPHA_RUN_TOKEN ?? '';
/** Anything other than an explicit 'write' is read -- an absent value must not widen access. */
const ACCESS: 'read' | 'write' = process.env.ALPHA_MCP_ACCESS === 'write' ? 'write' : 'read';

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>) => Promise<unknown>;
  access?: 'write';
}

const permitted = (t: ToolDef) => t.access !== 'write' || ACCESS === 'write';

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const REPO = str('The repository as owner/name -- one of this run\'s project repositories.');
const ENVIRONMENT = str('main (production), uat or dev. A backend has main and uat only.', { enum: ['main', 'uat', 'dev'] });

async function bridge(op: string, body: Record<string, unknown>): Promise<unknown> {
  if (!DAEMON_URL || !RUN_TOKEN) {
    throw new Error('Hosting tools are not connected to Alpha for this run. Ask a person to start it again.');
  }
  let res: Response;
  try {
    res = await fetch(`${DAEMON_URL}/agent-bridge/hosting/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Alpha-Run-Token': RUN_TOKEN },
      body: JSON.stringify(body),
      // Setting variables redeploys; a cold cloud can take a while.
      signal: AbortSignal.timeout(200_000)
    });
  } catch (err) {
    const timedOut = (err as Error)?.name === 'TimeoutError';
    throw new Error(
      timedOut
        ? 'Alpha did not answer in time. The change may still be applying; check hosting_status before trying again.'
        : 'Could not reach the Alpha app for this run. It may have been closed; ask the user to check it is running.'
    );
  }
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) throw new Error(parsed?.error ?? `Alpha answered ${res.status}.`);
  return parsed;
}

const TOOLS: Record<string, ToolDef> = {
  hosting_status: {
    description:
      'Where a repository is hosted (Render for a backend, Vercel for a frontend), each environment\'s live URL and latest deploy, and its pair.',
    inputSchema: schema({ repo: REPO }, ['repo']),
    run: args => bridge('status', { repo: args.repo })
  },
  hosting_logs: {
    description:
      'Recent logs of one hosted environment, oldest first, with secrets already redacted. Use to diagnose a failing deploy or a runtime error.',
    inputSchema: schema(
      {
        repo: REPO,
        branch: ENVIRONMENT,
        type: str('build or app (runtime). Omit for both.', { enum: ['build', 'app'] }),
        errors_only: { type: 'boolean', description: 'Only error lines.' },
        text: str('Only lines containing this text.'),
        minutes: { type: 'integer', description: 'How far back to read, in minutes. Default 60.', minimum: 1, maximum: 1440 }
      },
      ['repo', 'branch']
    ),
    run: args =>
      bridge('logs', {
        repo: args.repo,
        branch: args.branch,
        ...(args.type ? { type: args.type } : {}),
        ...(args.errors_only ? { level: 'error' } : {}),
        ...(args.text ? { text: args.text } : {}),
        minutes: args.minutes ?? 60
      })
  },
  hosting_env_list: {
    description:
      'The environment variables set on each hosted environment, by name. Values are never shown -- they are write-only -- except the URLs Alpha sets itself.',
    inputSchema: schema({ repo: REPO }, ['repo']),
    run: args => bridge('env/list', { repo: args.repo })
  },
  hosting_env_set: {
    description:
      'Set or replace environment variables on one hosted environment, then redeploy it. uat and dev apply at once. main (production) is queued for a project manager to approve in the run view; say so to the user rather than retrying.',
    inputSchema: schema(
      {
        repo: REPO,
        environment: ENVIRONMENT,
        vars: {
          type: 'array',
          description: 'The variables to set.',
          minItems: 1,
          items: schema({ key: str('UPPER_SNAKE_CASE name.'), value: str('The value. Stored as a secret; never shown again.') }, ['key', 'value'])
        },
        redeploy: { type: 'boolean', description: 'Redeploy so the change takes effect now. Default true.' }
      },
      ['repo', 'environment', 'vars']
    ),
    access: 'write',
    run: args => bridge('env/set', { repo: args.repo, environment: args.environment, vars: args.vars, redeploy: args.redeploy !== false })
  },
  hosting_env_delete: {
    description: 'Remove one environment variable from one hosted environment (not main -- ask a person for production).',
    inputSchema: schema(
      {
        repo: REPO,
        environment: str('uat or dev.', { enum: ['uat', 'dev'] }),
        key: str('The variable to remove.'),
        redeploy: { type: 'boolean', description: 'Redeploy so the change takes effect now. Default true.' }
      },
      ['repo', 'environment', 'key']
    ),
    access: 'write',
    run: args => bridge('env/delete', { repo: args.repo, environment: args.environment, key: args.key, redeploy: args.redeploy !== false })
  }
};

type Id = string | number | null;

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
        serverInfo: { name: 'alpha-hosting', version: '1.0.0' }
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: Object.entries(TOOLS)
          .filter(([, t]) => permitted(t))
          .map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }))
      });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) return reply(id, toolResult(`Unknown tool: ${name}`, true));
      if (!permitted(tool)) {
        return reply(
          id,
          toolResult(`"${name}" changes hosting, and this turn has read-only access. Describe the change for a person to make.`, true)
        );
      }
      try {
        const value = await tool.run(params?.arguments ?? {});
        return reply(id, toolResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
      } catch (err: any) {
        return reply(id, toolResult(err?.message ?? String(err), true));
      }
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
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
