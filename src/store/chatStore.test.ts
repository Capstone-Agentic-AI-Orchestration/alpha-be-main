import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresChatStore, messageRow, threadRow, toMessage, toThread } from './postgresChatStore.js';
import type { ChatMessage, ChatThread } from '../models/index.js';

/**
 * A person's own conversations in the cloud.
 *
 * The desktop has the conversation and publishes it; this is what the web
 * reads back. Owner scoping is the whole point, so it is stated in the
 * statement rather than filtered afterwards -- and checked here against the
 * real migration, where a mistyped column also fails.
 */

let pg: PGlite;
let store: PostgresChatStore;

const WS = 'ws-default';
const now = '2026-09-22T10:00:00.000Z';

beforeAll(async () => {
  pg = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec('truncate chat_messages, chat_threads, workspaces cascade');
  await pg.exec(`insert into workspaces (id, name, slug) values ('${WS}', 'Alpha', 'alpha')`);
  store = new PostgresChatStore(sqlFor(pg));
});

const aThread = (over: Partial<ChatThread> = {}): ChatThread =>
  ({
    id: 't1',
    title: 'About the cart',
    lastMessageSnippet: 'my prompt',
    lastMessageAt: now,
    agentIds: ['agent-architect'],
    projectId: undefined,
    targetAgentId: 'agent-architect',
    createdAt: now,
    ...over
  }) as ChatThread;

const aMessage = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  threadId: 't1',
  senderType: 'user',
  senderName: 'Lloyd1020',
  content: 'my prompt',
  toolsExecuted: [],
  messageType: 'user',
  timestamp: now,
  ...over
});

/** As the desktop publishes them: the same rows, through the same mappers. */
async function publish(ownerId: string, thread: ChatThread, messages: ChatMessage[] = []) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    await pg.query(
      `insert into ${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map(column => {
        const value = row[column];
        return Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value) : value;
      })
    );
  };
  await insert('chat_threads', threadRow(WS, ownerId, thread));
  for (const message of messages) await insert('chat_messages', messageRow(message));
}

describe('the cloud chat store', () => {
  it('lists the threads of the person asking, and no one else’s', async () => {
    await publish('Lloyd1020', aThread());
    await publish('ZaneZamoraC1Cs', aThread({ id: 't2', title: 'Theirs' }));

    expect((await store.listThreads(WS, 'Lloyd1020')).map(t => t.id)).toEqual(['t1']);
    expect((await store.listThreads(WS, 'ZaneZamoraC1Cs')).map(t => t.id)).toEqual(['t2']);
  });

  it('reads a thread back as it was published', async () => {
    const thread = aThread();
    await publish('Lloyd1020', thread, [aMessage()]);

    const [read] = await store.listThreads(WS, 'Lloyd1020');
    expect(read).toMatchObject({
      id: 't1',
      title: 'About the cart',
      lastMessageSnippet: 'my prompt',
      agentIds: ['agent-architect'],
      targetAgentId: 'agent-architect'
    });

    const messages = await store.messages(WS, 't1', 'Lloyd1020');
    expect(messages).toEqual([expect.objectContaining({ id: 'm1', content: 'my prompt', senderType: 'user' })]);
  });

  /** A thread id is minted by a client, so knowing one must not be enough. */
  it('answers nothing for a thread that is not this person’s', async () => {
    await publish('ZaneZamoraC1Cs', aThread({ id: 't2' }), [aMessage({ id: 'm2', threadId: 't2', content: 'their prompt' })]);

    expect(await store.messages(WS, 't2', 'Lloyd1020')).toBeNull();
  });

  it('answers nothing for a thread that does not exist', async () => {
    expect(await store.messages(WS, 'nope', 'Lloyd1020')).toBeNull();
  });

  /** What a run's message carries, which is more than text. */
  it('keeps what an agent’s message carries', async () => {
    const rich = aMessage({
      id: 'm-agent',
      senderType: 'agent',
      senderName: 'Architect',
      agentId: 'agent-architect',
      messageType: 'agent_call',
      agentCallId: 'call-1',
      agentCallStatus: 'completed',
      operationMode: 'implement',
      thinkingProcess: 'weighing two options',
      toolsExecuted: [{ tool: 'read_file', detail: 'src/index.ts' } as never],
      revisionTarget: { type: 'file', id: 'src/index.ts', label: 'index' } as never
    });
    await publish('Lloyd1020', aThread(), [rich]);

    const [read] = (await store.messages(WS, 't1', 'Lloyd1020'))!;
    expect(read).toMatchObject({
      agentId: 'agent-architect',
      messageType: 'agent_call',
      agentCallId: 'call-1',
      agentCallStatus: 'completed',
      thinkingProcess: 'weighing two options',
      revisionTarget: { type: 'file', id: 'src/index.ts', label: 'index' }
    });
    expect(read.toolsExecuted).toHaveLength(1);
  });

  it('maps a row back to what was sent', async () => {
    const thread = aThread();
    await publish('Lloyd1020', thread, [aMessage()]);

    const { rows: threadRows } = await pg.query<any>('select * from chat_threads');
    const { rows: messageRows } = await pg.query<any>('select * from chat_messages');

    expect(toThread(threadRows[0])).toMatchObject({ id: thread.id, title: thread.title });
    expect(toMessage(messageRows[0])).toMatchObject({ id: 'm1', threadId: 't1', content: 'my prompt' });
  });
});
