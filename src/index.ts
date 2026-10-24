import express from 'express';
import cors from 'cors';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT, HOST, ALPHA_MODE, ALPHA_ORG, ALPHA_SESSION_SECRET, ALPHA_TICKETING_READS_ENABLED, DATABASE_CA_CERT, DATABASE_URL, IS_CLOUD, IS_DESKTOP, CORS_ORIGIN, hostOverrideNote, isAllowedOrigin, unsafeOriginPatterns } from './config/env.js';
import { database, verifyDatabase } from './store/database.js';
import { dataRouter } from './controllers/dataController.js';
import { downloadRouter } from './controllers/downloadController.js';
import { seedDefaultWorkspace, workspaceRouter } from './controllers/workspaceController.js';
import { workspaceContext } from './controllers/workspaceContext.js';
import { sessionContext } from './controllers/sessionContext.js';
import { runRouter, setRunTicketLifecycleRuntime } from './controllers/runController.js';
import { runtimeRouter } from './controllers/runtimeController.js';
import { githubRouter } from './controllers/githubController.js';
import { chatRouter } from './controllers/chatController.js';
import { mcpRouter } from './controllers/mcpController.js';
import { liveBuildRoomRouter } from './controllers/liveBuildRoomController.js';
import { orchestrationRouter } from './controllers/orchestrationController.js';
import { projectRepoRouter } from './controllers/projectRepoController.js';
import { hostingRouter } from './controllers/hostingController.js';
import { agentBridgeRouter } from './controllers/agentBridgeController.js';
import { setDaemonAddress } from './services/daemonAddress.js';
import { agentCallRouter } from './controllers/agentCallController.js';
import { agentCallService } from './services/agentCallService.js';
import { runnerService } from './services/runnerService.js';
import { chatService } from './services/chatService.js';
import { flushChatSyncOutbox, startChatSyncRetryLoop } from './services/chatSyncService.js';
import { runtimeRefreshService } from './services/runtimeRefreshService.js';
import { ensureCatalogSeed } from './services/mcpConfigService.js';
import { reconcileOnStartup } from './services/startupReconcile.js';
import { currentIdentity, warmIdentity } from './services/identityService.js';
import { resumeRememberedSession } from './services/alphaGitHubToken.js';
import { jsonErrorHandler } from './controllers/errorHandler.js';
import { sqliteService } from './services/sqliteService.js';
import { ensureAgentFiles } from './services/agentFileService.js';
import { ensureMemoryScaffold } from './services/memoryService.js';
import { logInfo, logError } from './utils/logger.js';
import { codeFolder, ensureAllProjectFolders } from './services/projectFolders.js';
import { DEFAULT_WORKSPACE_ID, runWithWorkspace } from './services/workspaceContext.js';
import { createTicketPmReadRouteBoundary } from './controllers/ticketPmReadRouteFactory.js';
import { createTicketUnavailableRouter } from './controllers/ticketUnavailableRouter.js';
import { createTicketClientUnavailableRouter } from './controllers/ticketClientUnavailableRouter.js';
import { createTicketPublicIntakeUnavailableRouter } from './controllers/ticketPublicIntakeUnavailableRouter.js';
import { ALPHA_TICKETING_TRIAGE_ENABLED, ALPHA_TICKETING_WORKFLOW_ENABLED, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ALPHA_CLOUD_API } from './config/env.js';
import { createTicketPublicIntakeCloudRouter } from './controllers/ticketPublicIntakeCloudRouter.js';
import { ALPHA_TICKETING_ACK_EMAIL_ENABLED, BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME,
  GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN, GMAIL_SENDER_EMAIL, GMAIL_SENDER_NAME } from './config/env.js';
import { RESEND_API_KEY, RESEND_SENDER_EMAIL, RESEND_SENDER_NAME, RESEND_TEST_RECIPIENT } from './config/env.js';
import { startTicketAcknowledgmentDelivery } from './services/ticketAcknowledgmentDeliveryService.js';
import { createTicketAcknowledgmentEmailProvider } from './services/ticketAcknowledgmentEmailProvider.js';
import { createTicketInvitationEmailProvider } from './services/ticketInvitationEmailProvider.js';
import { startTicketInvitationEmailDelivery } from './services/ticketInvitationEmailDeliveryService.js';
import { createTicketClientComposition } from './controllers/ticketClientComposition.js';
import { clientAccessConfigurationProblems, resolveClientWebOrigin } from './ticketing/clientWebOrigin.js';
import { createTicketLifecycleRuntime } from './services/ticketLifecycleRuntime.js';
import { createTicketExecutionRouter } from './controllers/ticketExecutionController.js';
import { createTicketIssueCompletionRouter } from './controllers/ticketIssueCompletionController.js';

const resendTicketEmailProvider = createTicketInvitationEmailProvider({
  apiKey: RESEND_API_KEY, senderEmail: RESEND_SENDER_EMAIL, senderName: RESEND_SENDER_NAME,
  testRecipient: RESEND_TEST_RECIPIENT,
});

const clientWebOrigin = resolveClientWebOrigin(CORS_ORIGIN, ALPHA_CLOUD_API);
const ticketLifecycle = IS_CLOUD && ALPHA_TICKETING_TRIAGE_ENABLED
  ? createTicketLifecycleRuntime(database(), ALPHA_TICKETING_WORKFLOW_ENABLED) : null;
setRunTicketLifecycleRuntime(ticketLifecycle);
const ticketClient = (() => {
  if (!IS_CLOUD || !ALPHA_TICKETING_TRIAGE_ENABLED) return null;
  const missing = clientAccessConfigurationProblems({
    webOrigin: clientWebOrigin, originAllowed: Boolean(clientWebOrigin && isAllowedOrigin(clientWebOrigin)),
    supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY, sessionSecret: ALPHA_SESSION_SECRET,
    emailConfigured: typeof resendTicketEmailProvider?.sendContent === 'function',
  });
  if (missing.length || !clientWebOrigin || !resendTicketEmailProvider) {
    // Setting names only: never log credentials, client details or provider bodies.
    logError(`Client portal unavailable: configure ${missing.join(', ')}.`);
    return null;
  }
  try {
    return createTicketClientComposition({
      database: database(), supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY,
      supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY, sessionSecret: ALPHA_SESSION_SECRET,
      webOrigin: clientWebOrigin, emailProvider: resendTicketEmailProvider,
      notificationEmailProvider: resendTicketEmailProvider,
      workflow: ticketLifecycle ?? undefined,
      onSignInDeliveryUnavailable: () => logError('Client account-access email delivery failed. Check server-side Supabase Auth and Resend configuration.'),
    });
  } catch {
    // Missing or invalid optional auth configuration keeps all client routes
    // closed without preventing the existing cloud API from booting.
    logError('Client portal initialization failed. Check the server-only Supabase Auth and client-session configuration.');
    return null;
  }
})();

const unavailableClientInvitation = {
  enabled: false,
  policy: { lifetimeMs: 60 * 60 * 1000 },
} as const;

/**
 * Refuse to start rather than store credentials in the clear.
 *
 * Cloud mode keeps a `repo`-scoped GitHub token per session. Without
 * ALPHA_SESSION_SECRET those rows would be plaintext, which turns the database
 * into a credential store: one leaked backup is read/write access to every
 * private repository in the organisation.
 *
 * A hard exit, not a warning. A warning at boot is read once and then lives in
 * a log nobody opens, and the failure it precedes is silent and permanent.
 */
if (IS_CLOUD && !ALPHA_SESSION_SECRET) {
  logError(
    'ALPHA_SESSION_SECRET is not set. Cloud mode stores GitHub tokens for each ' +
      'signed-in user and will not run without a key to encrypt them. ' +
      'Set it to a long random value (openssl rand -base64 48).'
  );
  process.exit(1);
}

/**
 * Refuse to start without the organisation roles come from.
 *
 * It used to default to one particular org, which tied every deployment and
 * every teammate's desktop to it without anyone choosing that. Unset, no team
 * would map to a role and everyone would be refused one sign-in at a time --
 * a quiet failure that reads as a permissions problem. Both modes need it.
 */
if (!ALPHA_ORG) {
  logError(
    'ALPHA_ORG is not set. Roles come from team membership in this GitHub ' +
      'organisation, so without it nobody can be given one. Set it to the ' +
      'organisation login, e.g. ALPHA_ORG=my-org.'
  );
  process.exit(1);
}

/**
 * Refuse to start the cloud without its database.
 *
 * State the cloud keeps lives in Postgres. Falling back to a SQLite file
 * would look like it worked -- until the next deploy replaced Render's disk
 * and signed everybody out, which is exactly how it used to behave.
 *
 * The certificate authority is required alongside: the connection carries the
 * database password, and a connection that cannot verify the server would
 * hand it to anyone in the path. See DATABASE_CA_CERT.
 */
if (IS_CLOUD && (!DATABASE_URL || !DATABASE_CA_CERT)) {
  logError(
    `${DATABASE_URL ? 'DATABASE_CA_CERT' : 'DATABASE_URL'} is not set. Cloud mode keeps sessions in ` +
      "Postgres and connects only when it can verify the server. From Supabase's dashboard: " +
      'DATABASE_URL is Connect → Session pooler, with the database password; DATABASE_CA_CERT is ' +
      'Database settings → SSL Configuration → Download certificate, pasted in whole.'
  );
  process.exit(1);
}

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
  express.raw({ type: 'application/octet-stream', limit: '10mb' }),
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  })
);

// Mount the browser-only client surface only when the cloud, ticketing gate,
// exact web origin, server-side Supabase settings, and Resend API configuration are valid.
// Keep it ahead of internal token/workspace middleware; it never relays to desktop.
app.use('/api/client', ticketClient?.router ?? createTicketClientUnavailableRouter());

// Anonymous inquiry URLs terminate at a separate fail-closed boundary. Do not
// let a public request fall through to Alpha's internal token/session/workspace
// middleware while the origin/rate guard and published intake are not configured.
app.use('/api/public/ticket-intakes', IS_CLOUD && ALPHA_TICKETING_TRIAGE_ENABLED
  ? createTicketPublicIntakeCloudRouter(database(), { sessionSecret: ALPHA_SESSION_SECRET,
      organizationKey: ALPHA_ORG, originAllowed: isAllowedOrigin,
      acknowledgmentsEnabled: ALPHA_TICKETING_ACK_EMAIL_ENABLED })
  : createTicketPublicIntakeUnavailableRouter());

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
 *
 * Whether the workspace exists, and whether this caller belongs to it, is
 * `workspaceContext`'s answer a few lines below — it asks the directory,
 * which in the cloud is Postgres. This used to check the id against the local
 * SQLite file and 404 anything missing, which would refuse every workspace
 * that lives in Postgres, on a disk that is empty after each deploy.
 */
app.use('/api', (req, res, next) => {
  if (
    req.path === '/health' ||
    req.path === '/workspaces' ||
    req.path.startsWith('/workspaces/')
  ) return next();

  return runWithWorkspace(req.header('X-Workspace-Id') || DEFAULT_WORKSPACE_ID, next);
});

// API Routes
/**
 * Identity first, then authorization.
 *
 * `sessionContext` resolves who is calling and puts their GitHub token on the
 * request's async chain; `workspaceContext` decides what that person may do.
 * The order matters and is not interchangeable — the second reads what the
 * first sets. On the desktop `sessionContext` is a pass-through, because
 * identity there is the machine's `gh` login rather than a cookie.
 */
app.use('/api', sessionContext);
app.use('/api', workspaceContext);
app.use('/api', createTicketIssueCompletionRouter(ticketLifecycle));
app.use('/api/ticket-work', IS_CLOUD
  ? createTicketExecutionRouter(database(), ticketLifecycle)
  : createTicketUnavailableRouter());
// Tickets lives inside the existing PM portal. Optional Phase 2 triage uses
// durable cloud adapters; future features remain isolated. Desktop requests relay
// through the same path but never construct a local ticket database.
app.use('/api/tickets', IS_CLOUD && (ALPHA_TICKETING_READS_ENABLED || ALPHA_TICKETING_TRIAGE_ENABLED)
  ? createTicketPmReadRouteBoundary(database(), undefined, ALPHA_TICKETING_TRIAGE_ENABLED,
    false, ticketClient?.pmInvitation ?? unavailableClientInvitation, Boolean(ticketClient),
    ticketClient?.documents, ticketLifecycle ?? undefined)
  : createTicketUnavailableRouter());
app.use('/api', workspaceRouter);
app.use('/api', downloadRouter);
app.use('/api', dataRouter);
app.use('/api', liveBuildRoomRouter);
app.use('/api', orchestrationRouter);
app.use('/api', projectRepoRouter);
app.use('/api', hostingRouter);
app.use('/api', agentBridgeRouter);
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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '2.0.0',
    time: new Date().toISOString(),
    /**
     * Which process this is, for the desktop to recognise its own.
     *
     * The installed app waits for "a 200 on its port" before opening its
     * window, and a daemon run from source answers that just as well. A
     * developer with `npm run dev` going had the app open onto their source
     * daemon -- signed in as the terminal's `gh`, reading their own `.env`
     * with no team board -- and nothing said so. Set by the desktop's main
     * process; absent anywhere else.
     */
    instance: process.env.ALPHA_INSTANCE || null
  });
});

export const server = http.createServer(app);

/**
 * A port someone else holds is the whole story of a failed start, so say it.
 *
 * Unhandled, this surfaced as nothing at all inside the desktop: the process
 * that did hold the port kept answering, and the app used it.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logError(`Cannot listen on ${HOST}:${PORT}: another program is already using it.`);
  } else {
    logError(`Server error: ${err.message}`);
  }
});

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
    activity?: { sequence?: number };
  };
  // The local WebSocket is intentionally not an authorization boundary. Do
  // not broadcast instructions, patch contents, errors, project paths, or
  // workspace metadata; authorized clients re-read the call over HTTP.
  return {
    id: call.id,
    status: call.status,
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    resultMessageId: call.resultMessageId,
    activitySequence: call.activity?.sequence
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
agentCallService.on('agent_call.activity', (data) => broadcast({ type: 'agent_call.activity', payload: safeAgentCallEvent(data) }));

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
runnerService.on('squad_run_cancelled', (data) => broadcast({ type: 'squad_run_cancelled', payload: data }));

// Subscribe chat events to WebSocket broadcast
chatService.on('chat_message', (data) => broadcast({ type: 'chat_message', payload: data }));

/**
 * The cloud proves its database before taking traffic.
 *
 * A wrong password, an unverifiable certificate or a missing migration then
 * fails the deploy at boot -- and Render, seeing no healthy instance, keeps
 * the previous version serving -- instead of passing the health check and
 * failing every sign-in after it.
 */
const databaseReady = IS_CLOUD ? verifyDatabase() : Promise.resolve();

databaseReady.then(
  () => server.listen(PORT, HOST, onListening),
  (err: Error) => {
    logError(`Cannot start: ${err.message}`);
    process.exit(1);
  }
);

function onListening(): void {
  const address = server.address();
  const boundPort = address && typeof address !== 'string' ? address.port : PORT;
  setDaemonAddress(HOST, Number(boundPort));
  logInfo(`Alpha v2 backend running in ${ALPHA_MODE.toUpperCase()} mode on http://${HOST}:${boundPort}`);
  if (IS_DESKTOP) logInfo(`WebSocket Live Stream Server listening on ws://${HOST}:${boundPort}`);

  /**
   * The database password on a developer's machine is the thing the whole
   * token exchange exists to avoid. Unused here, but a copied `.env` is how it
   * ends up in a backup, a screen share or a bug report.
   */
  if (IS_DESKTOP && DATABASE_URL) {
    logError('DATABASE_URL is set on a desktop, which never uses it. Remove it: it is the database password.');
  }

  /**
   * A dropped origin pattern is otherwise invisible.
   *
   * The operator sees a browser CORS error and nothing server-side pointing at
   * the cause, which is a bad way to learn that the entry was refused on
   * purpose.
   */
  if (hostOverrideNote()) logError(hostOverrideNote());

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

    // The default workspace's row, roster and core squad; see seedDefaultWorkspace.
    seedDefaultWorkspace().catch(err => logError('Could not seed the default workspace:', err));
    const stopAcknowledgments = startTicketAcknowledgmentDelivery({
      isCloud: IS_CLOUD, enabled: ALPHA_TICKETING_ACK_EMAIL_ENABLED && ALPHA_TICKETING_TRIAGE_ENABLED,
      providerFactory: () => createTicketAcknowledgmentEmailProvider({
        // Gmail is retained for optional inquiry receipts; client access and
        // conversation notices use Resend.
        providerName: 'gmail',
        gmail: { clientId: GMAIL_OAUTH_CLIENT_ID, clientSecret: GMAIL_OAUTH_CLIENT_SECRET,
          refreshToken: GMAIL_OAUTH_REFRESH_TOKEN, senderEmail: GMAIL_SENDER_EMAIL, senderName: GMAIL_SENDER_NAME },
        resend: { apiKey: RESEND_API_KEY, senderEmail: RESEND_SENDER_EMAIL, senderName: RESEND_SENDER_NAME,
          testRecipient: RESEND_TEST_RECIPIENT },
        brevo: { apiKey: BREVO_API_KEY, senderEmail: BREVO_SENDER_EMAIL, senderName: BREVO_SENDER_NAME },
      }), database,
      onUnavailable: () => logError('Ticket acknowledgment email is unavailable; inquiries remain saved. Check hosted email configuration and outbox status.'),
    });
    server.once('close', stopAcknowledgments);
    const stopInvitationEmails = startTicketInvitationEmailDelivery({
      isCloud: IS_CLOUD, enabled: ALPHA_TICKETING_TRIAGE_ENABLED,
      providerFactory: () => resendTicketEmailProvider, database,
      onUnavailable: () => logError('Ticket invitation email delivery is unavailable. Check RESEND_API_KEY, RESEND_SENDER_EMAIL, RESEND_SENDER_NAME and provider delivery status.'),
    });
    server.once('close', stopInvitationEmails);
    const stopClientActivationEmails = ticketClient?.startDeliveryWorker(
      () => logError('Client activation email delivery is unavailable; no client access was granted. Check server-side Supabase Auth and Resend configuration.'),
      () => logError('Client action reminders are unavailable; messages and documents still send. Apply the latest database migration (ticket_client_action_notices).'),
    ) ?? (() => undefined);
    server.once('close', stopClientActivationEmails);
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
  // Attach task-run lifecycle listeners on every desktop boot, then reconcile
  // durable task attempts only after legacy runner rows have been closed.
  // Without this, a restarted daemon could leave a task marked running with no
  // process behind it, or miss a completed submission waiting for acceptance.
  if (!IS_CLOUD) {
    void import('./services/orchestrationRuntime.js')
      .then(({ reconcileInterruptedOrchestrations, startOrchestrationEventDelivery }) => {
        const stopEventDelivery = startOrchestrationEventDelivery(
          event => broadcast({ type: 'orchestration_event', payload: event }),
          error => logError('Could not publish a task workflow event:', error instanceof Error ? error.message : String(error))
        );
        server.once('close', stopEventDelivery);
        return reconcileInterruptedOrchestrations();
      })
      .catch(err => logError('Could not initialize task orchestration recovery:', err));
  }

  // Sign back in as the last account used, if it was used within the idle
  // limit; identity and the workspace gate wait for this.
  if (IS_DESKTOP) void resumeRememberedSession();

  // Resolve who is using this copy, so the first issue anyone creates does not
  // pay for a `gh` subprocess.
  warmIdentity();

  // Every project has a folder on this computer before anything is cloned:
  // Documents\AlphaProjects\<project>, unless the code folder was moved.
  if (IS_DESKTOP) {
    const created = ensureAllProjectFolders();
    if (created.length) logInfo(`Created ${created.length} project folder(s) under ${codeFolder()}`);
  }

  /**
   * Give legacy conversations an owner.
   *
   * `chat_threads.owner_id` landed nullable — ADD COLUMN cannot be NOT NULL
   * without a default — so every thread written before it has none, and the
   * read path does not treat unowned as public. Without this they would simply
   * disappear from the list.
   *
   * Desktop only, and correct there for the reason the whole mode split
   * exists: one process, one person at one keyboard, so every thread on this
   * machine is theirs. A cloud database has no legacy rows.
   *
   * After identity, because the login is not known until `gh` answers.
   */
  currentIdentity()
    .then(identity => {
      const claimed = sqliteService.claimUnownedThreads(identity.login);
      if (claimed > 0) logInfo(`Claimed ${claimed} conversation(s) for ${identity.login}.`);
      const stopChatSync = startChatSyncRetryLoop();
      server.once('close', stopChatSync);
      void flushChatSyncOutbox();
    })
    .catch(err => logError('Could not claim unowned conversations:', err));

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
}
