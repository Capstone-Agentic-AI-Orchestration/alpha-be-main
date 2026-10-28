import type { TicketClientIdentityProvider } from '../services/ticketClientIdentityProvider.js';
import type { TicketClientSessionPolicy } from '../services/ticketClientSessionService.js';
import { createTicketClientSessionService } from '../services/ticketClientSessionService.js';
import { createTicketClientActivationService } from '../services/ticketClientActivationService.js';
import { createTicketClientWorkspaceService } from '../services/ticketClientWorkspaceService.js';
import { createTicketClientIntakeContextService } from '../services/ticketClientIntakeContextService.js';
import { createTicketCreationService } from '../services/ticketCreationService.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import type { TicketClientActivationStore } from '../store/ticketClientActivationStore.js';
import type { TicketClientSessionStore } from '../store/ticketClientSessionStore.js';
import type { TicketClientWorkspaceStore } from '../store/ticketClientWorkspaceStore.js';
import type { TicketClientIntakeContextStore } from '../store/ticketClientIntakeContextStore.js';
import type { TicketCreationStore } from '../store/ticketCreationStore.js';
import type { TicketQueueStore } from '../store/ticketQueueStore.js';
import type { TicketReadStore } from '../store/ticketReadStore.js';
import type { TicketClientSessionAdmission, TicketClientSessionCookiePolicy } from './ticketClientSessionController.js';
import { createTicketClientApiRouter, type TicketClientApiApplication } from './ticketClientApiController.js';
import { createTicketClientSessionRouter } from './ticketClientSessionController.js';
import { createTicketClientActivationRouter } from './ticketClientActivationController.js';
import { createTicketClientRouter } from './ticketClientRouter.js';
import type { TicketInvitationContentEmailProvider } from '../services/ticketInvitationEmailProvider.js';
import type { PostgresTicketClientSignInStore } from '../store/ticketClientSignInPostgresStore.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketMessageReceipt, TicketOperationReceipt } from '../store/ticketCommandStore.js';
import type { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketWorkflowError as WorkflowError } from '../ticketing/workflow.js';
import type { TicketDocumentsApplication } from './ticketDocumentController.js';
import { createTicketClientAccountService } from '../services/ticketClientAccountService.js';
import { createTicketClientAccountRouter } from './ticketClientAccountController.js';
import type { PostgresTicketClientAccountStore } from '../store/ticketClientAccountPostgresStore.js';
import type { TicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';
import type { PostgresClientProjectPortal } from '../services/clientProjectPortal.js';
import type { ProjectUat } from '../services/projectUat.js';

export interface TicketClientPortalRouteDependencies {
  projectPortal?: PostgresClientProjectPortal;
  projectUat?: ProjectUat;
  sessionStore: TicketClientSessionStore;
  activationStore: TicketClientActivationStore;
  workspaceStore: TicketClientWorkspaceStore;
  intakeContextStore: TicketClientIntakeContextStore;
  creationStore: TicketCreationStore;
  queueStore: TicketQueueStore;
  readStore: TicketReadStore;
  identityProvider: TicketClientIdentityProvider;
  signInStore: PostgresTicketClientSignInStore;
  messages: {
    reply(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketMessageReceipt>;
    lookup(target: TicketTarget, subject: TicketSubject, operationId: string): Promise<TicketOperationReceipt | null>;
  };
  documents?: TicketDocumentsApplication;
  emailProvider: TicketInvitationContentEmailProvider | null;
  webOrigin: string;
  sessionPolicy: TicketClientSessionPolicy;
  cookiePolicy: TicketClientSessionCookiePolicy;
  activationAdmission: TicketClientSessionAdmission;
  onSignInDeliveryUnavailable?: () => void;
  accountStore?: PostgresTicketClientAccountStore;
  accountSecret?: string;
  workflow?: TicketLifecycleRuntime;
}

function workflowActionUnavailable(): TicketWorkflowError {
  return new WorkflowError(503, 'client_ticket_action_unavailable', 'This client ticket action is not enabled.');
}

/** Exposes client identity and ticket-scoped communication while keeping unsupported workflow actions closed. */
export function createTicketClientPortalRouteBoundary(dependencies: TicketClientPortalRouteDependencies) {
  const sessions = createTicketClientSessionService(
    dependencies.sessionStore, dependencies.identityProvider, dependencies.sessionPolicy,
  );
  const activation = createTicketClientActivationService(
    dependencies.activationStore, dependencies.identityProvider,
  );
  const workspaces = createTicketClientWorkspaceService(dependencies.workspaceStore);
  const intakeContext = createTicketClientIntakeContextService(dependencies.intakeContextStore);
  const creation = createTicketCreationService(dependencies.creationStore);
  const queue = createTicketQueueService(dependencies.queueStore);
  const reads = createTicketReadService(dependencies.readStore);

  const sessionApplication = { authenticate: sessions.authenticate, revoke: sessions.revoke, emailFor: sessions.emailFor };
  const activationApplication = {
    async activate(input: unknown) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new WorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
      }
      const body = input as Record<string, unknown>;
      if (typeof body.invitationToken !== 'string' || typeof body.providerTokenHash !== 'string'
        || (body.providerTokenType !== 'invite' && body.providerTokenType !== 'magiclink')) {
        throw new WorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
      }
      const verified = await dependencies.identityProvider.verifyEmailLink(body.providerTokenHash, body.providerTokenType);
      if (!verified) throw new WorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
      await activation.activate({ invitationToken: body.invitationToken, providerCredential: verified.credential });
      const session = await sessions.exchange(verified.credential);
      if (!session) throw new WorkflowError(503, 'client_activation_unavailable', 'Client activation is unavailable right now.');
      return { activated: true as const, session };
    },
  };

  const clientApi: TicketClientApiApplication = {
    projectPortal: dependencies.projectPortal,
    projectUat: dependencies.projectUat,
    authenticate: sessions.authenticate,
    listWorkspaces: workspaces.list,
    getIntakeContext: intakeContext.get,
    list: queue.list,
    detail: reads.detail,
    async deliveryManifest(target: TicketTarget, subject: TicketSubject, deliveryId: string) {
      if (!dependencies.workflow?.enabled) throw workflowActionUnavailable();
      return dependencies.workflow.deliveries.manifest(target, subject, deliveryId);
    },
    async deliveryContent(target: TicketTarget, subject: TicketSubject, deliveryId: string, fileId: string) {
      if (!dependencies.workflow?.enabled) throw workflowActionUnavailable();
      return dependencies.workflow.deliveries.content(target, subject, deliveryId, fileId);
    },
    conversation: reads.conversation,
    reply: dependencies.messages.reply,
    ...(dependencies.documents ? { documents: dependencies.documents } : {}),
    async execute(target: TicketTarget, subject: TicketSubject, input: unknown) {
      if (!dependencies.workflow?.enabled) throw workflowActionUnavailable();
      return dependencies.workflow.commands.execute(target, subject, input);
    },
    workflowCapabilities() { return { phaseWorkflowEnabled: dependencies.workflow?.enabled === true }; },
    lookup: dependencies.messages.lookup,
    create: creation.create,
    lookupCreation: creation.lookup,
  };

  return createTicketClientRouter({
    ...(dependencies.accountStore && dependencies.accountSecret ? {
      account: createTicketClientAccountRouter(createTicketClientAccountService({
        store: dependencies.accountStore, signInStore: dependencies.signInStore,
        activationStore: dependencies.activationStore, provider: dependencies.identityProvider,
        sessions, activate: activation.activate, emailProvider: dependencies.emailProvider,
        webOrigin: dependencies.webOrigin, secret: dependencies.accountSecret,
        onDeliveryUnavailable: dependencies.onSignInDeliveryUnavailable,
      }), dependencies.cookiePolicy, dependencies.activationAdmission),
    } : {}),
    session: createTicketClientSessionRouter(sessionApplication, dependencies.cookiePolicy),
    activation: createTicketClientActivationRouter(activationApplication, dependencies.cookiePolicy, dependencies.activationAdmission),
    api: createTicketClientApiRouter(clientApi, dependencies.cookiePolicy),
  });
}
