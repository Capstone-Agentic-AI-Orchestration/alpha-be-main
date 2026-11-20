/**
 * Alpha's board tools for agents, as a stdio MCP server.
 *
 * Entry point only -- nothing imports this. Spawned from the per-turn config
 * mcpConfigService writes (daemon -> agent CLI -> this). It holds no
 * credential: every tool calls the daemon's board bridge with the turn's
 * board pass, and the bridge checks each call as the developer the agent acts
 * for (see boardGrant and boardAgentService). Archiving, bulk changes and
 * changes to someone else's card come back as held for that developer to
 * confirm; say so instead of retrying.
 */
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

const DAEMON_URL = process.env.ALPHA_DAEMON_URL ?? '';
const RUN_TOKEN = process.env.ALPHA_RUN_TOKEN ?? '';
/** Anything unexpected is read: an absent value must not widen access. */
const ACCESS: 'read' | 'comment' | 'write' =
  process.env.ALPHA_BOARD_ACCESS === 'write' ? 'write' : process.env.ALPHA_BOARD_ACCESS === 'comment' ? 'comment' : 'read';

type Level = 'read' | 'comment' | 'write';
interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  operation: string;
  level: Level;
  annotations?: Record<string, boolean>;
}

const RANK: Record<Level, number> = { read: 0, comment: 1, write: 2 };
export const permitted = (tool: Pick<ToolDef, 'level'>, access: Level = ACCESS) => RANK[access] >= RANK[tool.level];

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const CARD = str('The card, by its ID as shown on the board, for example CAP-104.');
const EXPECTED = str('The updated_at of the card as you last read it. A card changed since then is refused; read it again.');
const FIELDS = {
  title: str('New title.'),
  description: str('New description (replaces the old one).'),
  priority: str('Priority.', { enum: ['urgent', 'high', 'medium', 'low', 'none'] }),
  labels: { type: 'array', items: { type: 'string' }, description: 'Labels (replaces the list).' },
  checklist: {
    type: 'array',
    description: 'Acceptance checklist (replaces the list). Each item is one pass/fail statement. A build treats every item as a requirement.',
    items: { anyOf: [{ type: 'string' }, schema({ title: { type: 'string' }, done: { type: 'boolean' } }, ['title'])] }
  },
  assignee: str('GitHub login of the person responsible; empty to clear.'),
  due_date: str('Due date as YYYY-MM-DD; empty to clear.'),
  planned_start: str('Planned start as YYYY-MM-DD; empty to clear.'),
  planned_end: str('Planned end as YYYY-MM-DD; empty to clear.'),
  depends_on: { type: 'array', items: { type: 'string' }, description: 'Cards in this project that must be done first (replaces the list).' },
  parent: str('A top-level card in this project to group this card under; empty to clear.')
};

export const TOOLS: Record<string, ToolDef> = {
  board_list_cards: {
    description: 'List cards on this project\'s board: ID, title, column, priority, assignee, labels, due date, planned start and end, dependencies, checklist progress and updated_at. No comments. Use column or search to narrow a large board. The Gantt view is drawn from planned_start, planned_end and depends_on: you see that data, not the chart. A project with none of them has nothing scheduled.',
    inputSchema: schema({
      column: str('Only cards in this column.', { enum: ['backlog', 'todo', 'in_progress', 'agent_running', 'review', 'done'] }),
      search: str('Only cards whose ID, title or description contains this text.'),
      archived: { type: 'boolean', description: 'List archived cards instead.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }),
    operation: 'list',
    level: 'read',
    annotations: { readOnlyHint: true }
  },
  board_get_card: {
    description: 'Read one card in full: description, checklist, dependencies, dates and its ten latest comments. Read a card before changing it.',
    inputSchema: schema({ card: CARD }, ['card']),
    operation: 'get',
    level: 'read',
    annotations: { readOnlyHint: true }
  },
  board_create_card: {
    description: 'Create a card in Backlog or Todo. Write a checklist of pass/fail items when the developer wants it built: a build treats each item as a requirement.',
    inputSchema: schema({ ...FIELDS, column: str('Backlog or Todo (default).', { enum: ['backlog', 'todo'] }) }, ['title']),
    operation: 'create',
    level: 'write'
  },
  board_update_card: {
    description: 'Change a card\'s title, description, priority, labels, checklist, assignee, dates, dependencies or parent. Not its column: use board_move_card.',
    inputSchema: schema({ card: CARD, expected_updated_at: EXPECTED, ...FIELDS }, ['card', 'expected_updated_at']),
    operation: 'update',
    level: 'write'
  },
  board_move_card: {
    description: 'Move a card to Backlog, Todo, In progress or In review. Never to Building (a developer starts a build) or Done (a person marks it after review).',
    inputSchema: schema({
      card: CARD,
      column: str('The column to move to.', { enum: ['backlog', 'todo', 'in_progress', 'review'] }),
      expected_updated_at: EXPECTED
    }, ['card', 'column', 'expected_updated_at']),
    operation: 'move',
    level: 'write'
  },
  board_archive_card: {
    description: 'Ask to archive a card: it leaves the board but keeps its history and can be restored. Always waits for the developer to confirm. There is no delete.',
    inputSchema: schema({ card: CARD, expected_updated_at: EXPECTED, reason: str('Why, in one short sentence.') }, ['card', 'expected_updated_at']),
    operation: 'archive',
    level: 'write',
    annotations: { destructiveHint: true }
  },
  board_restore_card: {
    description: 'Put an archived card back on the board.',
    inputSchema: schema({ card: CARD }, ['card']),
    operation: 'restore',
    level: 'write'
  }
};

async function bridge(operation: string, body: Record<string, unknown>): Promise<unknown> {
  if (!DAEMON_URL || !RUN_TOKEN) throw new Error('Board tools are not connected to Alpha for this turn. Ask the developer to send the message again.');
  let res: Response;
  try {
    res = await fetch(DAEMON_URL + '/agent-bridge/board/' + operation, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Alpha-Run-Token': RUN_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    throw new Error('Could not reach the Alpha app for this turn. Ask the developer to check it is running.');
  }
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw new Error(parsed?.error ?? 'Alpha answered ' + res.status + '.');
  return parsed;
}

type Id = string | number | null;
const realWrite = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;
console.debug = console.log;
const send = (message: Record<string, unknown>) => { realWrite(JSON.stringify(message) + '\n'); };
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
        serverInfo: { name: 'alpha-board', version: '1.0.0' }
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: Object.entries(TOOLS)
          .filter(([, tool]) => permitted(tool))
          .map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}) }))
      });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) return reply(id, toolResult('Unknown tool: ' + name, true));
      if (!permitted(tool)) {
        return reply(id, toolResult('Only the Manager Agent changes cards. Describe the change so the developer can ask the Manager Agent to make it.', true));
      }
      try {
        const value = await bridge(tool.operation, params?.arguments ?? {});
        return reply(id, toolResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
      } catch (err: any) {
        return reply(id, toolResult(err?.message ?? String(err), true));
      }
    }
    default:
      return replyError(id, -32601, 'Method not found: ' + method);
  }
}

if (process.env.ALPHA_BOARD_MCP_NO_STDIO !== '1') {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { return replyError(null, -32700, 'Parse error'); }
    handle(msg).catch(err => replyError(msg?.id ?? null, -32603, err?.message ?? String(err)));
  });
  rl.on('close', () => process.exit(0));
}

