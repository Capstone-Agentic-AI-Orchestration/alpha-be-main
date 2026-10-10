import type { Router } from 'express';

import type { TransactionalSql } from '../store/database.js';
import type { TicketInvitationContentEmailProvider } from '../services/ticketInvitationEmailProvider.js';
import { TicketClientIdentityProvider } from '../services/ticketClientIdentityProvider.js';
import { createTicketClientInvitationDeliveryService } from '../services/ticketClientInvitationDeliveryService.js';
import { startTicketClientInvitationDeliveryWorker } from '../services/ticketClientInvitationDeliveryWorker.js';
import { createTicketClientAuthAdmission } from '../services/ticketClientAuthAdmission.js';
import { createTicketClientPhaseFourRouteBoundary } from './ticketClientPhaseFourRouteFactory.js';
import { PostgresTicketClientActivationStore } from '../store/ticketClientActivationPostgresStore.js';
import { PostgresTicketClientAuthRateLimitStore } from '../store/ticketClientAuthRateLimitPostgresStore.js';
import { PostgresTicketClientInvitationDeliveryStore } from '../store/ticketClientInvitationDeliveryStore.js';
import { PostgresTicketClientSessionStore } from '../store/ticketClientSessionPostgresStore.js';
import { PostgresTicketClientSignInStore } from '../store/ticketClientSignInPostgresStore.js';
import { PostgresTicketClientWorkspaceStore } from '../store/ticketClientWorkspacePostgresStore.js';
import { PostgresTicketQueueStore } from '../store/ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from '../store/ticketReadPostgresStore.js';
import { createClientTicketInvitationSecretProtector } from '../ticketing/clientTicketSecrets.js';
import type { TicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';
import type { TicketInvitationPolicy } from '../services/ticketInvitationService.js';

const INVITATION_LIFETIME_MS = 60 * 60 * 1000;
const CLIENT_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

export interface TicketClientPhaseFourComposition {
  router: Router;
  pmInvitation: {
    enabled: true;
    policy: TicketInvitationPolicy;
    secretProtector: TicketInvitationSecretProtector;
  };
  startDeliveryWorker(onUnavailable: () => void): () => void;
}

/**
 * Compose client-only auth/read routes from the same Postgres pool and the
 * server-only Supabase Auth/Resend credentials. Call only after validating the
 * rollout gates and exact HTTPS web origin; no browser receives service keys.
 */
export function createTicketClientPhaseFourComposition(input: {
  database: TransactionalSql;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  sessionSecret: string;
  webOrigin: string;
  emailProvider: TicketInvitationContentEmailProvider;
  onSignInDeliveryUnavailable?: () => void;
}): TicketClientPhaseFourComposition {
  if (typeof input.emailProvider.sendContent !== 'function') {
    throw new Error('Client email delivery is not configured.');
  }

  const identityProvider = new TicketClientIdentityProvider(
    input.supabaseUrl, input.supabaseAnonKey, input.supabaseServiceRoleKey,
  );
  const secrets = createClientTicketInvitationSecretProtector(input.sessionSecret);
  const invitationPolicy: TicketInvitationPolicy = { lifetimeMs: INVITATION_LIFETIME_MS };
  const rateStore = new PostgresTicketClientAuthRateLimitStore(input.database);
  const sessionAdmission = createTicketClientAuthAdmission({
    store: rateStore, secret: input.sessionSecret, bucket: 'client_sign_in', maximumPerMinute: 8,
  });
  const activationAdmission = createTicketClientAuthAdmission({
    store: rateStore, secret: input.sessionSecret, bucket: 'client_activation', maximumPerMinute: 8,
  });

  const router = createTicketClientPhaseFourRouteBoundary({
    sessionStore: new PostgresTicketClientSessionStore(input.database),
    activationStore: new PostgresTicketClientActivationStore(input.database),
    workspaceStore: new PostgresTicketClientWorkspaceStore(input.database),
    queueStore: new PostgresTicketQueueStore(input.database),
    readStore: new PostgresTicketReadStore(input.database),
    identityProvider,
    signInStore: new PostgresTicketClientSignInStore(input.database),
    emailProvider: input.emailProvider,
    onSignInDeliveryUnavailable: input.onSignInDeliveryUnavailable,
    webOrigin: input.webOrigin,
    sessionPolicy: { lifetimeMs: CLIENT_SESSION_LIFETIME_MS },
    cookiePolicy: { secure: true, allowedOrigins: [input.webOrigin] },
    sessionAdmission,
    activationAdmission,
  });

  const delivery = createTicketClientInvitationDeliveryService(
    new PostgresTicketClientInvitationDeliveryStore(input.database), identityProvider, input.emailProvider,
    secrets.invitation, secrets.providerLink,
    { webOrigin: input.webOrigin, leaseDurationMs: 60_000, retryBaseDelayMs: 30_000,
      retryMaxDelayMs: 5 * 60_000, maxAttempts: 5 },
  );

  return {
    router,
    pmInvitation: { enabled: true, policy: invitationPolicy, secretProtector: secrets.invitation },
    startDeliveryWorker(onUnavailable) {
      return startTicketClientInvitationDeliveryWorker({
        isCloud: true, enabled: true, delivery, onUnavailable,
      });
    },
  };
}
