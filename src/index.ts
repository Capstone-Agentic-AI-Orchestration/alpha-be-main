import express from 'express';
import cors from 'cors';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT, HOST, ALPHA_MODE, IS_CLOUD, IS_DESKTOP, isAllowedOrigin, unsafeOriginPatterns } from './config/env.js';
import { dataRouter } from './controllers/dataController.js';
import { workspaceRouter } from './controllers/workspaceController.js';
import { workspaceContext } from './controllers/workspaceContext.js';
import { runRouter } from './controllers/runController.js';
import { runtimeRouter } from './controllers/runtimeController.js';
import { githubRouter } from './controllers/githubController.js';
import { chatRouter } from './controllers/chatController.js';
import { mcpRouter } from './controllers/mcpController.js';
import { liveBuildRoomRouter } from './controllers/liveBuildRoomController.js';
import { agentCallRouter } from './controllers/agentCallController.js';
import { agentCallService } from './services/agentCallService.js';
import { runnerService } from './services/runnerService.js';
import { chatService } from './services/chatService.js';
import { runtimeRefreshService } from './services/runtimeRefreshService.js';
import { ensureCatalogSeed } from './services/mcpConfigService.js';
import { reconcileOnStartup } from './services/startupReconcile.js';
import { warmIdentity } from './services/identityService.js';
import { jsonErrorHandler } from './controllers/errorHandler.js';
import { sqliteService } from './services/sqliteService.js';
import { ensureAgentFiles } from './services/agentFileService.js';
import { ensureMemoryScaffold } from './services/memoryService.js';
import { logInfo, logError } from './utils/logger.js';
import { DEFAULT_WORKSPACE_ID, runWithWorkspace } from './services/workspaceContext.js';

const app = express();

/**
 * CORS allowlist, not `*`.
 *
 * This API spawns agents that run shell commands. With `origin: '*'` any website
 * the user visited could call http://localhost:3001/api from page JavaScript and
 * start a run on their machine — no network access required, just an open tab.
 *
 * `CORS_ORIGIN` was already parsed in config/env.ts but ignored here.
 */
app.use(cors({
  origin(origin, callback) {
    // Same-origin / curl / Electron send no Origin header.
    if (!origin) return callback(null, true);
    // Exact entries, plus wildcard labels over an apex the operator controls.
    // A wildcard across a shared hosting apex is refused at parse time — see
    // isAllowedOrigin — because it would admit every tenant of that platform.
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} is not allowed`));
  },
  credentials: true
}));

/**
 * Keep the raw request bytes alongside the parsed body.
 *
 * GitHub signs webhook deliveries over the exact bytes it sent, so the HMAC has
 * to be computed on those. Re-serialising the parsed object does not reproduce
 * them (key order and escaping are not guaranteed), which would make every
 * genuine delivery fail verification. Only the webhook route reads this.
 */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  })
);

/**
 * Optional shared secret for local callers.
 *
 * Enforced only when ALPHA_LOCAL_TOKEN is set, so local development keeps
 * working unconfigured. Set it (and send `X-Alpha-Token`) whenever the daemon
 * might be reachable by another process or user on the machine.
 */
if (process.env.ALPHA_LOCAL_TOKEN) {
  const expected = process.env.ALPHA_LOCAL_TOKEN;
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    if (req.header('X-Alpha-Token') === expected) return next();
    return res.status(401).json({ error: 'Missing or invalid X-Alpha-Token' });
  });
  logInfo('Local token authentication is ENABLED');
}

/**
 * Every workspace-owned API request runs with one explicit data scope.
 * Existing callers that do not send a header remain on the migrated default
 * workspace, while the browser can switch scopes without another daemon.
 */
app.use('/api', (req, res, next) => {
  if (
    req.path === '/health' ||
    req.path === '/workspaces' ||
    req.path.startsWith('/workspaces/')
  ) return next();

  const workspaceId = req.header('X-Workspace-Id') || DEFAULT_WORKSPACE_ID;
  if (!sqliteService.getWorkspace(workspaceId)) {
    return res.status(404).json({ error: `Workspace not found: ${workspaceId}` });
  }
  return runWithWorkspace(workspaceId, next);
});

// API Routes
app.use('/api', workspaceContext);
app.use('/api', workspaceRouter);
app.use('/api', dataRouter);
app.use('/api', liveBuildRoomRouter);
app.use('/api', agentCallRouter);
app.use('/api', runRouter);
app.use('/api', runtimeRouter);
app.use('/api', githubRouter);
app.use('/api', chatRouter);
app.use('/api', mcpRouter);
app.use('/api', workspaceRouter);

/**
 * Last in the chain, so every route above answers failures as JSON.
 *
 * Without it Express returned an HTML page with a stack trace, and the browser
 * put the whole document into a toast.
 */
app.use(jsonErrorHandler);

app.get('/api/download/desktop', (req, res) => {
  const zipPath = path.resolve('..', 'Alpha-v2-FullPlatform.zip');
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, 'Alpha-Desktop-Windows-v2.0.0.zip');
  } else {
    res.status(404).json({ error: 'Desktop package bundle not found' });
  }
});

app.get('/api/download/exe', (req, res) => {
  const batPath = path.resolve('..', 'start-alpha.bat');
  if (fs.existsSync(batPath)) {
    res.download(batPath, 'Alpha-Launcher.bat');
  } else {
    res.status(404).json({ error: 'Launcher file not found' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', version: '2.0.0', time: new Date().toISOString() });
});

const server = http.createServer(app);

const clients = new Set<WebSocket>();

/**
 * Live run streaming, on the desktop only.
 *
 * This socket carries every run's stage updates to every client that connects,
 * with no token check on upgrade and no workspace filter — the comment on
 * `safeAgentCallEvent` says as much: it "is intentionally not an authorization
 * boundary". On a workstation that is fine, because HOST is loopback and the
 * only listener is this app's own renderer.
 *
 * In the cloud the same socket is published to the internet, where "not an
 * authorization boundary" means any browser can subscribe to the activity of
 * every developer in every workspace. Cloud clients get the same telemetry
 * through Supabase Realtime instead, where RLS applies, so there is nothing to
 * replace here — only something to stop exposing.
 */
if (IS_DESKTOP) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    logInfo('Client connected to WebSocket stream');

    ws.send(JSON.stringify({ type: 'connected', time: new Date().toISOString() }));

    ws.on('close', () => {
      clients.delete(ws);
      logInfo('Client disconnected from WebSocket stream');
    });

    ws.on('error', (err) => {
      logError('WebSocket client error:', err);
      clients.delete(ws);
    });
  });
}

function broadcast(payload: Record<string, any>) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function safeAgentCallEvent(data: unknown) {
  if (!data || typeof data !== 'object') return null;
  const call = data as {
    id?: string;
    status?: string;
    startedAt?: string;
    completedAt?: string;
    resultMessageId?: string;
  };
  // The local WebSocket is intentionally not an authorization boundary. Do
  // not broadcast instructions, patch contents, errors, project paths, or
  // workspace metadata; authorized clients re-read the call over HTTP.
  return {
    id: call.id,
    status: call.status,
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    resultMessageId: call.resultMessageId
  };
}

// Subscribe runner events to WebSocket broadcast
runnerService.on('stage_update', (data) => broadcast({ type: 'stage_update', payload: data }));
runnerService.on('log_chunk', (data) => broadcast({ type: 'log_chunk', payload: data }));
runnerService.on('run_activity', (data) => broadcast({ type: 'run_activity', payload: data }));
runnerService.on('run_completed', (data) => broadcast({ type: 'run_completed', payload: data }));
runnerService.on('run_failed', (data) => broadcast({ type: 'run_failed', payload: data }));
runnerService.on('run_cancelled', (data) => broadcast({ type: 'run_cancelled', payload: data }));
// A queued run reaching the front of its workspace queue.
runnerService.on('run_started', (data) => broadcast({ type: 'run_started', payload: data }));

// Project-scoped chat calls use the same realtime channel as runs. The payload
// contains identifiers and status only; model reasoning and local paths never
// leave the backend through this broadcast.
agentCallService.on('agent_call.created', (data) => broadcast({ type: 'agent_call.created', payload: safeAgentCallEvent(data) }));
agentCallService.on('agent_call.queued', (data) => broadcast({ type: 'agent_call.queued', payload: safeAgentCallEvent(data) }));
agentCallService.on('agent_call.started', (data) => broadcast({ type: 'agent_call.started', payload: safeAgentCallEvent(data) }));
agentCallService.on('agent_call.completed', (data) => broadcast({ type: 'agent_call.completed', payload: safeAgentCallEvent(data) }));
agentCallService.on('agent_call.failed', (data) => broadcast({ type: 'agent_call.failed', payload: safeAgentCallEvent(data) }));
agentCallService.on('agent_call.cancelled', (data) => broadcast({ type: 'agent_call.cancelled', payload: safeAgentCallEvent(data) }));

/**
 * Squad events, which were emitted and never forwarded.
 *
 * `squadRunner` raises these on runnerService's emitter, but only the five
 * run-level names above were subscribed — so a squad run reached the browser
 * only through its members' stage updates, with nothing saying which member was
 * working or how many were left.
 */
runnerService.on('squad_member_started', (data) => broadcast({ type: 'squad_member_started', payload: data }));
runnerService.on('squad_run_completed', (data) => broadcast({ type: 'squad_run_completed', payload: data }));
runnerService.on('squad_run_failed', (data) => broadcast({ type: 'squad_run_failed', payload: data }));

// Subscribe chat events to WebSocket broadcast
chatService.on('chat_message', (data) => broadcast({ type: 'chat_message', payload: data }));

server.listen(PORT, HOST, () => {
  logInfo(`Alpha v2 backend running in ${ALPHA_MODE.toUpperCase()} mode on http://${HOST}:${PORT}`);
  if (IS_DESKTOP) logInfo(`WebSocket Live Stream Server listening on ws://${HOST}:${PORT}`);

  /**
   * A dropped origin pattern is otherwise invisible.
   *
   * The operator sees a browser CORS error and nothing server-side pointing at
   * the cause, which is a bad way to learn that the entry was refused on
   * purpose.
   */
  for (const { pattern, reason } of unsafeOriginPatterns()) {
    logError(`CORS_ORIGIN entry "${pattern}" was ignored as unsafe: ${reason}.`);
  }

  /**
   * Everything below this point is execution-node work.
   *
   * The cloud process has no working copy to reconcile, no `~/.alpha` that
   * survives a deploy, no agent CLIs to discover and no local models to poll.
   * Running any of it there is not merely wasted — `runtimeRefreshService`
   * rescans the filesystem on a timer and would report "no runtimes found"
   * forever, which is indistinguishable from a real misconfiguration on a
   * developer's machine.
   */
  if (IS_CLOUD) {
    logInfo('Cloud mode: runner, runtime discovery and local scaffolding are disabled.');
    return;
  }

  /**
   * Close out anything the previous process was in the middle of.
   *
   * First, before any of the optional scaffolding: these rows are what the UI
   * loads on connect, and a card stuck in Agent Running with no process behind
   * it is the first thing a returning user sees.
   */
  reconcileOnStartup();

  // Resolve who is using this copy, so the first issue anyone creates does not
  // pay for a `gh` subprocess.
  warmIdentity();

  // Write a starter MCP catalog if the user has none, so the file is
  // discoverable rather than something you have to know to create.
  ensureCatalogSeed();

  /**
   * Grow the file layer for installs that predate it.
   *
   * Agents created from now on get a persona file at creation time
   * (sqliteService.createAgent), but an existing alpha.db has rows with no
   * file — and a user who deleted a file should get it back rather than
   * silently lose the override. Existing files are never overwritten.
   *
   * The global memory tier is scaffolded here too: templates only, and
   * template-only files contribute nothing to a prompt until someone writes
   * in them.
   */
  try {
    ensureMemoryScaffold();
    ensureAgentFiles(sqliteService.getAgents());
  } catch (err) {
    logError('Could not initialise the agent file layer:', err);
  }

  // Initial runtime scan plus periodic catalog refresh in background.
  runtimeRefreshService.start();
});
