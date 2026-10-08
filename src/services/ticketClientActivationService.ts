import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { TicketClientActivationStore } from '../store/ticketClientActivationStore.js';
import type { TicketTarget } from '../store/ticketCommandStore.js';
import { isTransactionOutcomeUnknown } from '../store/transactionOutcome.js';
import { authorizeTicketInvitationActivation, type VerifiedClientIdentity } from '../ticketing/clientActivation.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const secretBytes = 32;
const activationInputSchema = z.object({
  /** 32 random bytes encoded as canonical, unpadded base64url. */
  invitationToken: z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/),
  /** A short-lived provider credential; verifier validates it server-side. Never log or persist it. */
  providerCredential: z.string().min(1).max(8192).regex(/^\S+$/),
}).strict();

export interface TicketClientIdentityVerifier {
  /** Verify signature, issuer, audience, expiry and email_verified with the configured provider. */
  verifyCredential(credential: string): Promise<VerifiedClientIdentity | null>;
}

export interface TicketClientActivationReceipt {
  activated: true;
}

/**
 * Provider-neutral activation application service. Provider verification is
 * injected; Alpha persists only the provider user ID and ticket grant. This
 * transaction does not mint the separate Alpha client session cookie.
 */
export function createTicketClientActivationService(
  store: TicketClientActivationStore,
  identityVerifier: TicketClientIdentityVerifier,
  now: () => Date = () => new Date(),
) {
  async function activate(input: unknown): Promise<TicketClientActivationReceipt> {
    const parsed = activationInputSchema.safeParse(input);
    if (!parsed.success) throw new TicketWorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');

    try {
      const identity = await identityVerifier.verifyCredential(parsed.data.providerCredential);
      if (!identity || typeof identity.userId !== 'string' || !identity.userId.trim()
        || identity.userId.length > 200 || identity.userId.trim() !== identity.userId
        || identity.emailVerified !== true || typeof identity.email !== 'string') {
        throw new TicketWorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
      }

      const token = Buffer.from(parsed.data.invitationToken, 'base64url');
      if (token.byteLength !== secretBytes || token.toString('base64url') !== parsed.data.invitationToken) {
        throw new TicketWorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
      }
      const secretHash = createHash('sha256').update(token).digest('hex');
      const target = await store.resolveTargetBySecretHash(secretHash);
      if (!target || !opaque(target.workspaceId) || !opaque(target.ticketId)) {
        throw new TicketWorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
      }

      return await store.transaction(async tx => {
        // Match the shared authorization-first lock order. If anything after
        // this point fails, the transaction rolls back a newly created grant.
        const grantTime = now();
        const grantTimestamp = grantTime instanceof Date && Number.isFinite(grantTime.getTime())
          ? grantTime.toISOString() : null;
        if (!grantTimestamp) throw new TicketReadInvariantError();
        if (!await tx.ensureClientServiceGrant(target.workspaceId, identity.userId, grantTimestamp)) {
          throw new TicketWorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
        }

        // Then lock the ticket and invitation in the same order as PM issuance.
        const ticket = await tx.lockInquiryTicket(target);
        const invitation = await tx.lockInvitationBySecretHash(target, secretHash);
        if (!ticket || ticket.id !== target.ticketId || ticket.workspaceId !== target.workspaceId) {
          throw new TicketWorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
        }
        const contact = invitation
          ? await tx.loadOriginalContact(target, invitation.contactBindingId)
          : null;
        // Evaluate expiry after lock acquisition so waiting on a row cannot
        // make an already-expired invitation appear valid.
        const decisionTime = now();
        const timestamp = decisionTime instanceof Date && Number.isFinite(decisionTime.getTime())
          ? decisionTime.toISOString() : null;
        if (!timestamp) throw new TicketReadInvariantError();
        const binding = authorizeTicketInvitationActivation(invitation, ticket, contact, identity, decisionTime);
        if (!await tx.consumeInvitation(target, binding.invitationId, timestamp)
          || !await tx.bindTicketClient(target, ticket.version, binding.clientUserId)) {
          throw new TicketWorkflowError(409, 'client_activation_conflict', 'This invitation could not be activated. Refresh and try again.');
        }
        await tx.insertTicketGrant(binding, timestamp);
        await tx.appendActivationAudit({ binding, type: 'client_invitation_activated', occurredAt: timestamp });
        await tx.enqueueActivationSignal({ target, type: 'ticket_client_activated', occurredAt: timestamp });
        return { activated: true };
      });
    } catch (error) {
      if (error instanceof TicketWorkflowError || error instanceof TicketReadInvariantError) throw error;
      if (isTransactionOutcomeUnknown(error)) {
        throw new TicketWorkflowError(409, 'client_activation_outcome_unknown', 'Activation may have completed. Sign in again to continue.');
      }
      throw new TicketWorkflowError(503, 'client_activation_unavailable', 'Client activation is unavailable right now.');
    }
  }

  return { activate };
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}
