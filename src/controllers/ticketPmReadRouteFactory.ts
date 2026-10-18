import { Router, type Response } from 'express';
import { createHmac } from 'node:crypto';

import { ALPHA_ORG, ALPHA_SESSION_SECRET, isAllowedOrigin } from '../config/env.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { PostgresTicketQueueStore } from '../store/ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from '../store/ticketReadPostgresStore.js';
import type { TransactionalSql } from '../store/database.js';
import { createTicketCentralIntakeService } from '../services/ticketCentralIntakeService.js';
import { createTicketIntakeOriginRateGuard } from '../services/ticketIntakeOriginRateGuard.js';
import { PostgresTicketCentralIntakeStore } from '../store/ticketCentralIntakePostgresStore.js';
import { createTicketCentralIntakeRouter } from './ticketCentralIntakeController.js';
import { createTicketQueueRouter } from './ticketQueueController.js';
import { createTicketReadRouter } from './ticketReadController.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import { PostgresTicketAuthorization } from '../store/ticketPostgresAuthorization.js';
import { PostgresTicketTriageStore } from '../store/ticketTriagePostgresStore.js';
import { PostgresTicketProjectManagementStore } from '../store/ticketProjectManagementPostgresStore.js';
import { createTicketProjectManagementService } from '../services/ticketProjectManagementService.js';
import { createTicketProjectManagementRouter } from './ticketProjectManagementController.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { createTicketCommandRouter } from './ticketCommandController.js';
import { createTicketMessageRouter } from './ticketMessageController.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { route } from './asyncRoute.js';
import { createTicketInvitationEmailRouter } from './ticketInvitationEmailController.js';
import { PostgresTicketInvitationEmailStore } from '../store/ticketInvitationEmailPostgresStore.js';
import { createTicketInvitationService, type TicketInvitationPolicy } from '../services/ticketInvitationService.js';
import { PostgresTicketInvitationStore } from '../store/ticketInvitationPostgresStore.js';
import { createTicketInvitationRouter } from './ticketInvitationController.js';
import type { TicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';
import { createTicketPmDocumentRouter } from './ticketPmDocumentController.js';
import type { TicketDocumentsApplication } from './ticketDocumentController.js';
import type { TicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';
import { createTicketScopeRouter } from './ticketScopeController.js';
import { createTicketPmDeliveryCandidatesRouter } from './ticketPmDeliveryCandidatesController.js';
import { createTicketPmResultRouter } from './ticketPmResultController.js';

/**
 * Production composition for the existing PM Tickets page.
 * Queue/detail and ticket actions use the cloud's durable Postgres authority.
 * PM-issued client invitations are delivered by the cloud; desktop processes
 * relay to cloud and never construct a local ticket store.
 */
export function createTicketPmReadRouteBoundary(
  db: TransactionalSql,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
  triageEnabled = false,
  invitationEmailDeliveryConfigured = false,
  clientActivation?: { enabled: boolean; policy: TicketInvitationPolicy; secretProtector?: TicketInvitationSecretProtector },
  communicationEnabled = false,
  documents?: TicketDocumentsApplication,
  lifecycle?: TicketLifecycleRuntime,
): Router {
  const router = Router({ caseSensitive: true, strict: true });
  const queue = createTicketQueueService(new PostgresTicketQueueStore(db));
  const reads = createTicketReadService(new PostgresTicketReadStore(db));

  // The client entry page requires an explicit workspace code. Give PMs that
  // code from the published database entry rather than assuming it matches a
  // workspace slug or hardcoding a client URL in the desktop app.
  router.get('/inquiry-code', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayRequest(req, res)) return;
    const workspace = req.workspace;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    if (!workspace || !opaqueTicketRequestValue(workspace.workspaceId)) throw new TicketReadInvariantError();

    const result = await db.transaction(async sql => {
      const scope = await new PostgresTicketAuthorization(sql).lockQueueScope(workspace.workspaceId, subject);
      if (!scope || scope.principal.kind !== 'pm') {
        throw new TicketWorkflowError(404, 'ticket_intake_code_unavailable', 'No published inquiry code is available in this workspace.');
      }
      const { rows } = await sql.query<{
        slug: string; entry_write_mode: string; workspace_write_mode: string | null;
      }>(
        `select e.slug, e.write_mode as entry_write_mode,
                w.settings_json->>'ticketing_write_mode' as workspace_write_mode
           from alpha_private.ticket_intake_entries e
           join public.workspaces w on w.id=e.workspace_id and w.status='active'
          where e.workspace_id=$1 and e.published
          order by e.created_at,e.id
          limit 2`,
        [workspace.workspaceId],
      );
      if (rows.length === 0) {
        throw new TicketWorkflowError(404, 'ticket_intake_code_unavailable', 'No published inquiry code is available in this workspace.');
      }
      if (rows.length !== 1) {
        throw new TicketWorkflowError(409, 'ticket_intake_code_ambiguous', 'This workspace has multiple published inquiry codes. Ask an administrator to review the intake configuration.');
      }
      const row = rows[0];
      if (!row || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(row.slug)) throw new TicketReadInvariantError();
      return {
        code: row.slug,
        submissionEnabled: row.entry_write_mode === 'enabled' && row.workspace_write_mode === 'enabled',
      };
    });
    return res.json(result);
  }));

  // Register this exact collection route before `/:ticketId`; otherwise the
  // existing detail reader can consume "intakes" as a ticket ID.
  if (triageEnabled) {
    router.get('/workflow-capabilities', route(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (await relayRequest(req, res)) return;
      const subject = pmTicketSubject(req, res);
      if (!subject) return;
      return res.json({ phaseWorkflowEnabled: lifecycle?.enabled === true });
    }));
    const centralKey = (domain: string) => createHmac('sha256', ALPHA_SESSION_SECRET).update(domain).digest();
    const centralIntake = createTicketCentralIntakeService({
      store: new PostgresTicketCentralIntakeStore(db), organizationKey: ALPHA_ORG,
      guard: createTicketIntakeOriginRateGuard({ rateKey: centralKey('alpha-ticket-central-intake-rate-v1'), originAllowed: isAllowedOrigin }),
      fingerprintKeys: [{ id: 'central-session-derived-v1', secret: centralKey('alpha-ticket-central-intake-dedupe-v1') }],
      maxRequestAgeMs: 300_000,
    });
    router.use(createTicketCentralIntakeRouter(centralIntake, relayRequest));
  }

  router.use(createTicketQueueRouter(queue, relayRequest));
  router.use(createTicketReadRouter({ ...reads,
    async detail(target, subject) {
      const detail = await reads.detail(target, subject);
      return triageEnabled ? detail : { ...detail, writesAvailable: false };
    },
  }, relayRequest));
  if (triageEnabled) {
    router.use(createTicketProjectManagementRouter(
      createTicketProjectManagementService(new PostgresTicketProjectManagementStore(db)), relayRequest,
    ));
    const store = lifecycle?.enabled ? lifecycle.store : new PostgresTicketTriageStore(db, { communicationEnabled });
    const commands = lifecycle?.enabled ? lifecycle.commands : createTicketCommandService(store);
    const messages = lifecycle?.enabled ? lifecycle.messages : createTicketMessageService(store);
    router.use(createTicketCommandRouter(commands, relayRequest));
    router.use(createTicketMessageRouter({ note: messages.note,
      reply: communicationEnabled ? messages.reply
        : async () => { throw new TicketWorkflowError(503, 'ticket_action_unavailable', 'Client conversations are not enabled yet.'); },
    }, relayRequest));
    if (lifecycle?.enabled) {
      router.use(createTicketScopeRouter(lifecycle.scopes));
      router.use(createTicketPmDeliveryCandidatesRouter(lifecycle.candidates));
      router.use(createTicketPmResultRouter(lifecycle));
    }
    if (communicationEnabled && documents) router.use(createTicketPmDocumentRouter(documents, relayRequest));
    if (clientActivation) {
      const invitationApp = clientActivation.enabled && clientActivation.secretProtector
        ? createTicketInvitationService(new PostgresTicketInvitationStore(db), clientActivation.policy, clientActivation.secretProtector)
        : { async issue() { throw new TicketWorkflowError(503, 'client_invitation_unavailable', 'Client invitations are not configured in this environment.'); } };
      router.use(createTicketInvitationRouter(invitationApp));
    } else if (invitationEmailDeliveryConfigured) {
      // Retained for callers still on the Phase 3 email-only boundary. The cloud
      // composition supplies `clientActivation` and never falls back to this.
      router.use(createTicketInvitationEmailRouter(new PostgresTicketInvitationEmailStore(db), true));
    }
  }
  router.use((_req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(503).json({ error: 'Ticket changes are not enabled yet.' });
  });
  return router;
}
