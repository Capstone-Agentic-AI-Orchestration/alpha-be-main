import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creating a conversation, and the race that made it fail.
 *
 * The browser mints the thread id and writes optimistically, so `POST
 * /chat/threads` is not awaited before the first message can be sent — and
 * `chatService.sendMessage` creates a thread it does not recognise. Both orders
 * are reachable, and against a plain INSERT the second one threw `UNIQUE
 * constraint failed`: a 500 about a thread that exists and works.
 *
 * Before any of that, the browser did not post at all. A new conversation lived
 * in one tab until its first message, so setting its project answered 404
 * "Thread not found" (surfaced as "Project not set"), deleting it answered 404
 * and — because a failed delete restores the row — left it unremovable, and a
 * reload dropped it entirely. These pin the fix from both ends: the thread is
 * created up front, and creating it twice is not an error.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startApi() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  // The daemon resolves this from `gh`; a test must not depend on a signed-in
  // machine.
  vi.doMock('../services/identityService.js', () => ({
    currentIdentity: async () => ({ login: 'octocat', source: 'github' }),
    warmIdentity: () => {},
    knownIdentity: () => ({ login: 'octocat', source: 'github' })
  }));

  const sql = await import('../services/sqliteService.js');
  const { chatRouter } = await import('./chatController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  opened.push(sql.sqliteService);

  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', chatRouter);
  return { svc: sql.sqliteService as any, app };
}

async function call(
  app: express.Express,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown
) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

/** What the browser sends: its own id, and fields SQLite has no column for. */
const threadPayload = (over: Record<string, unknown> = {}) => ({
  id: `th-${Date.now()}`,
  title: 'New Conversation',
  lastMessageSnippet: 'Ready for instructions...',
  lastMessageAt: new Date().toISOString(),
  agentIds: [],
  ...over
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-threadcreate-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('../services/identityService.js');
});

describe('POST /chat/threads', () => {
  it('creates the thread under the id the browser chose', async () => {
    const { app } = await startApi();
    const payload = threadPayload();

    const res = await call(app, 'POST', '/api/chat/threads', payload);

    expect(res.status).toBe(201);
    // The id has to survive: the browser has already routed to it, and posts
    // its first message to whatever it minted.
    expect(res.body.id).toBe(payload.id);
  });

  it('answers 200 with the existing thread rather than throwing on a repeat', async () => {
    // The race: sendMessage created it lazily, and this POST arrived second.
    const { app } = await startApi();
    const payload = threadPayload();

    const first = await call(app, 'POST', '/api/chat/threads', payload);
    const second = await call(app, 'POST', '/api/chat/threads', payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(payload.id);
  });

  it('does not duplicate the row when posted twice', async () => {
    const { app, svc } = await startApi();
    const payload = threadPayload();

    await call(app, 'POST', '/api/chat/threads', payload);
    await call(app, 'POST', '/api/chat/threads', payload);

    expect(svc.getChatThreads().filter((t: any) => t.id === payload.id)).toHaveLength(1);
  });

  it('keeps the first thread intact when the second post differs', async () => {
    // Idempotent on the id, not an update. A POST is not how a thread is
    // edited, and silently rewriting one here would be a write nobody asked for.
    const { app } = await startApi();
    const payload = threadPayload({ title: 'Original' });

    await call(app, 'POST', '/api/chat/threads', payload);
    const second = await call(app, 'POST', '/api/chat/threads', { ...payload, title: 'Changed' });

    expect(second.status).toBe(200);
    expect(second.body.title).toBe('Original');
  });

  it('still mints an id when the browser sends none', async () => {
    const { app } = await startApi();

    const res = await call(app, 'POST', '/api/chat/threads', { title: 'No id here' });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^th-/);
  });
});

describe('a thread that has been created', () => {
  it('accepts a project, where an unposted one answered 404', async () => {
    // The reported bug: "Project not set — API Error [404]: Thread not found",
    // on a conversation that had never been spoken in.
    const { app } = await startApi();
    const payload = threadPayload();
    await call(app, 'POST', '/api/chat/threads', payload);

    const res = await call(app, 'PUT', `/api/chat/threads/${payload.id}`, { projectId: null });

    expect(res.status).toBe(200);
  });

  it('can be deleted, where an unposted one came back', async () => {
    // deleteThread rolls a failure back by restoring the row, so a 404 here
    // made the conversation unremovable.
    const { app } = await startApi();
    const payload = threadPayload();
    await call(app, 'POST', '/api/chat/threads', payload);

    const res = await call(app, 'DELETE', `/api/chat/threads/${payload.id}`);

    expect(res.status).toBe(200);
  });

  it('persists the selected agent target and can return to Automatic Alpha', async () => {
    const { app, svc } = await startApi();
    const payload = threadPayload();
    await call(app, 'POST', '/api/chat/threads', payload);
    const agent = svc.getAgents()[0];

    const selected = await call(
      app,
      'PUT',
      `/api/chat/threads/${payload.id}/target`,
      { targetAgentId: agent.id, targetSquadId: null }
    );

    expect(selected.status).toBe(200);
    expect(selected.body.targetAgentId).toBe(agent.id);
    expect(selected.body.targetSquadId).toBeUndefined();

    const cleared = await call(
      app,
      'PUT',
      `/api/chat/threads/${payload.id}/target`,
      { targetAgentId: null, targetSquadId: null }
    );

    expect(cleared.status).toBe(200);
    expect(cleared.body.targetAgentId).toBeUndefined();
    expect(cleared.body.targetSquadId).toBeUndefined();
  });
});

describe('an id the daemon has never seen', () => {
  /**
   * The 404 that stays.
   *
   * Making POST idempotent is not the same move as letting PUT create what it
   * cannot find. A POST asks for the thread to exist; a PUT asserts a property
   * of one presumed to, so its 404 carries information — the id is wrong — and
   * manufacturing a row there would fabricate the very thing the caller got
   * wrong.
   */
  it('still refuses to set a project on it', async () => {
    const { app } = await startApi();

    const res = await call(app, 'PUT', '/api/chat/threads/th-never-existed', { projectId: null });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('creates nothing as a side effect of that refusal', async () => {
    const { app, svc } = await startApi();

    await call(app, 'PUT', '/api/chat/threads/th-never-existed', { projectId: null });

    expect(svc.getChatThreads()).toHaveLength(0);
  });
});
