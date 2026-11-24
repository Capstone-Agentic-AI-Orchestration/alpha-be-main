import { ALPHA_ORG } from '../config/env.js';
import { ClientProjectProposals } from '../services/clientProjectProposals.js';
import type { Router } from 'express';
import { PostgresClientProjectPortal } from '../services/clientProjectPortal.js';
import { ClientProjectConversation } from '../services/clientProjectConversation.js';
import { ClientProjectStages } from '../services/clientProjectStages.js';
import { ProjectUat } from '../services/projectUat.js';
import { createProjectUatBuilds } from '../services/projectUatBuilds.js';

import type { TransactionalSql } from '../store/database.js';
import type { TicketInvitationContentEmailProvider } from '../services/ticketInvitationEmailProvider.js';
import { TicketClientIdentityProvider } from '../services/ticketClientIdentityProvider.js';
import { createTicketClientInvitationDeliveryService } from '../services/ticketClientInvitationDeliveryService.js';
import { startTicketClientInvitationDeliveryWorker } from '../services/ticketClientInvitationDeliveryWorker.js';
import { createTicketClientAuthAdmission } from '../services/ticketClientAuthAdmission.js';
import { createTicketClientPortalRouteBoundary } from './ticketClientPortalRouteFactory.js';
import { PostgresTicketTriageStore } from '../store/ticketTriagePostgresStore.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { PostgresTicketClientActivationStore } from '../store/ticketClientActivationPostgresStore.js';
import { PostgresTicketClientAuthRateLimitStore } from '../store/ticketClientAuthRateLimitPostgresStore.js';
import { PostgresTicketClientInvitationDeliveryStore } from '../store/ticketClientInvitationDeliveryStore.js';
import { PostgresTicketClientSessionStore } from '../store/ticketClientSessionPostgresStore.js';
import { PostgresTicketClientSignInStore } from '../store/ticketClientSignInPostgresStore.js';
import { PostgresTicketClientAccountStore } from '../store/ticketClientAccountPostgresStore.js';
import { PostgresTicketClientWorkspaceStore } from '../store/ticketClientWorkspacePostgresStore.js';
import { PostgresTicketClientIntakeContextStore } from '../store/ticketClientIntakeContextPostgresStore.js';
import { PostgresTicketCreationStore } from '../store/ticketCreationPostgresStore.js';
import { PostgresTicketQueueStore } from '../store/ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from '../store/ticketReadPostgresStore.js';
import { createClientTicketInvitationSecretProtector } from '../ticketing/clientTicketSecrets.js';
import type { TicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';
import type { TicketInvitationPolicy } from '../services/ticketInvitationService.js';
import { createTicketDocumentService } from '../services/ticketDocumentService.js';
import { SupabaseTicketDocumentObjectStore } from '../services/supabaseTicketDocumentObjectStore.js';
import { PostgresTicketDocumentStore } from '../store/ticketDocumentPostgresStore.js';
import type { TicketDocumentsApplication } from './ticketDocumentController.js';
import { PostgresTicketCommunicationNotificationStore } from '../store/ticketCommunicationNotificationStore.js';
import { createTicketCommunicationNotificationService } from '../services/ticketCommunicationNotificationService.js';
import { startTicketCommunicationNotificationWorker } from '../services/ticketCommunicationNotificationWorker.js';
import type { TicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';

/**
 * How long a PM invitation stays valid. A client often opens the email the next day, so this is
 * days, not an hour. The one-time sign-in link inside it has its own, shorter lifetime set in
 * Supabase Auth (Email OTP expiration); keep that at its maximum (24 hours) to match.
 */
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const CLIENT_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

export interface TicketClientComposition {
  router: Router;
  pmInvitation: {
    enabled: boolean;
    policy: TicketInvitationPolicy;
    secretProtector: TicketInvitationSecretProtector;
  };
  documents: TicketDocumentsApplication;
  startDeliveryWorker(onUnavailable: () => void, onActionNoticesUnavailable?: () => void): () => void;
}

/**
 * Compose client-only auth/read routes from the same Postgres pool and the
 * server-only Supabase Auth and email-provider credentials. Call only after validating the
 * rollout gates and exact HTTPS web origin; no browser receives service keys.
 */
export function createTicketClientComposition(input: {
  database: TransactionalSql;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  sessionSecret: string;
  webOrigin: string;
  /** Resend: PM invitations, client activation, and password recovery. */
  emailProvider: TicketInvitationContentEmailProvider | null;
  /** Optional Resend route for PM/client conversation notices. */
  notificationEmailProvider?: TicketInvitationContentEmailProvider | null;
  onSignInDeliveryUnavailable?: () => void;
  workflow?: TicketLifecycleRuntime;
}): TicketClientComposition {
  const identityProvider = new TicketClientIdentityProvider(
    input.supabaseUrl, input.supabaseAnonKey, input.supabaseServiceRoleKey,
  );
  const secrets = createClientTicketInvitationSecretProtector(input.sessionSecret);
  const invitationPolicy: TicketInvitationPolicy = {
    lifetimeMs: INVITATION_LIFETIME_MS,
    ...(input.emailProvider?.canSendTo ? { recipientAllowed: input.emailProvider.canSendTo } : {}),
  };
  const rateStore = new PostgresTicketClientAuthRateLimitStore(input.database);
  const activationAdmission = createTicketClientAuthAdmission({
    store: rateStore, secret: input.sessionSecret, bucket: 'client_activation', maximumPerMinute: 8,
  });
  const documents = createTicketDocumentService(
    new PostgresTicketDocumentStore(input.database),
    new SupabaseTicketDocumentObjectStore(input.supabaseUrl, input.supabaseServiceRoleKey),
  );
  const communicationDelivery = input.notificationEmailProvider
    ? createTicketCommunicationNotificationService(
      new PostgresTicketCommunicationNotificationStore(input.database), input.notificationEmailProvider, input.webOrigin,
    )
    : null;
  const messages = createTicketMessageService(new PostgresTicketTriageStore(input.database, { communicationEnabled: true }));

  const router = createTicketClientPortalRouteBoundary({
    projectProposals: new ClientProjectProposals(input.database, ALPHA_ORG),
    projectPortal: new PostgresClientProjectPortal(input.database),
    projectConversation: new ClientProjectConversation(input.database, new PostgresClientProjectPortal(input.database)),
    projectStages: new ClientProjectStages(input.database, new PostgresClientProjectPortal(input.database)),
    projectUat: new ProjectUat(input.database,new PostgresClientProjectPortal(input.database),createProjectUatBuilds(input.database),
      new SupabaseTicketDocumentObjectStore(input.supabaseUrl,input.supabaseServiceRoleKey)),
    sessionStore: new PostgresTicketClientSessionStore(input.database),
    activationStore: new PostgresTicketClientActivationStore(input.database),
    workspaceStore: new PostgresTicketClientWorkspaceStore(input.database),
    intakeContextStore: new PostgresTicketClientIntakeContextStore(input.database),
    creationStore: new PostgresTicketCreationStore(input.database),
    queueStore: new PostgresTicketQueueStore(input.database),
    readStore: new PostgresTicketReadStore(input.database),
    identityProvider,
    signInStore: new PostgresTicketClientSignInStore(input.database),
    accountStore: new PostgresTicketClientAccountStore(input.database),
    accountSecret: input.sessionSecret,
    messages,
    documents,
    emailProvider: input.emailProvider,
    onSignInDeliveryUnavailable: input.onSignInDeliveryUnavailable,
    webOrigin: input.webOrigin,
    sessionPolicy: { lifetimeMs: CLIENT_SESSION_LIFETIME_MS },
    cookiePolicy: { secure: true, allowedOrigins: [input.webOrigin] },
    activationAdmission,
    workflow: input.workflow,
  });

  const delivery = input.emailProvider ? createTicketClientInvitationDeliveryService(
    new PostgresTicketClientInvitationDeliveryStore(input.database), identityProvider, input.emailProvider,
    secrets.invitation, secrets.providerLink,
    { webOrigin: input.webOrigin, leaseDurationMs: 60_000, retryBaseDelayMs: 30_000,
      retryMaxDelayMs: 5 * 60_000, maxAttempts: 5 },
  ) : null;

  return {
    router, documents,
    pmInvitation: { enabled: Boolean(input.emailProvider), policy: invitationPolicy, secretProtector: secrets.invitation },
    startDeliveryWorker(onUnavailable, onActionNoticesUnavailable) {
      const stopInvitations = delivery ? startTicketClientInvitationDeliveryWorker({
        isCloud: true, enabled: true, delivery, onUnavailable,
      }) : () => undefined;
      const stopCommunications = communicationDelivery ? startTicketCommunicationNotificationWorker({
        isCloud: true, enabled: true, delivery: communicationDelivery, onUnavailable, onActionNoticesUnavailable,
      }) : () => undefined;
      return () => { stopInvitations(); stopCommunications(); };
    },
  };
}
