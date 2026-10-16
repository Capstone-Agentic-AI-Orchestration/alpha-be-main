import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { TicketClientIdentityProvider } from './ticketClientIdentityProvider.js';
import type { TicketClientActivationStore } from '../store/ticketClientActivationStore.js';
import type { PostgresTicketClientSignInStore } from '../store/ticketClientSignInPostgresStore.js';
import type { PostgresTicketClientAccountStore, ClientAccountSetup } from '../store/ticketClientAccountPostgresStore.js';
import type { createTicketClientSessionService } from './ticketClientSessionService.js';
import type { TicketInvitationContentEmailProvider } from './ticketInvitationEmailProvider.js';
import type { VerifiedClientIdentity } from '../ticketing/clientActivation.js';
import { authorizeTicketInvitationActivation } from '../ticketing/clientActivation.js';
import { clientAccountProof } from '../ticketing/clientAccountProof.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const hash = (purpose: string, value: string) => createHash('sha256').update(`alpha-client-account:${purpose}:${value}`).digest('hex');
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(1).max(128);
const link = z.object({ invitationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  providerTokenHash: z.string().regex(/^[A-Za-z0-9_-]{20,256}$/),
  providerTokenType: z.enum(['invite', 'magiclink', 'recovery']) }).strict();
const proofSchema = z.object({ credential: z.string().min(1).max(8192), invitationToken: z.string().nullable(),
  target: z.object({ workspaceId: z.string(), ticketId: z.string() }).nullable() });
type AccountProof = z.infer<typeof proofSchema>;
const unavailable = () => new TicketWorkflowError(404, 'client_setup_unavailable', 'This setup link has expired or is unavailable. Request a fresh link.');
const invalidPassword = () => new TicketWorkflowError(401, 'client_credentials_invalid', 'The email or password is incorrect, or client access is not active.');
const safeView = (setup: ClientAccountSetup) => ({ email: setup.email, action: setup.action, expiresAt: setup.expiresAt });
const context = (setup: ClientAccountSetup) => JSON.stringify([setup.idHash, setup.userId, setup.action, setup.expiresAt]);

export function createTicketClientAccountService(input: {
  store: PostgresTicketClientAccountStore;
  signInStore: PostgresTicketClientSignInStore;
  activationStore: TicketClientActivationStore;
  provider: TicketClientIdentityProvider;
  sessions: ReturnType<typeof createTicketClientSessionService>;
  activate: (input: unknown) => Promise<unknown>;
  emailProvider: TicketInvitationContentEmailProvider;
  webOrigin: string;
  secret: string;
  onDeliveryUnavailable?: () => void;
}) {
  const protector = clientAccountProof(input.secret);

  async function checkInvitation(token: string, identity: VerifiedClientIdentity) {
    const secretHash = createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
    const target = await input.activationStore.resolveTargetBySecretHash(secretHash);
    if (!target) throw unavailable();
    await input.activationStore.transaction(async tx => {
      const ticket = await tx.lockInquiryTicket(target);
      const invitation = await tx.lockInvitationBySecretHash(target, secretHash);
      const contact = invitation ? await tx.loadOriginalContact(target, invitation.contactBindingId) : null;
      if (!ticket) throw unavailable();
      authorizeTicketInvitationActivation(invitation, ticket, contact, identity, new Date());
    });
    return target;
  }

  async function read(rawToken: unknown) {
    if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw unavailable();
    const setup = await input.store.get(hash('setup', rawToken));
    if (!setup) throw unavailable();
    return setup;
  }

  function assertIdentity(identity: VerifiedClientIdentity | null, setup: ClientAccountSetup): asserts identity is VerifiedClientIdentity {
    if (!identity || identity.userId !== setup.userId || !identity.emailVerified
      || identity.email?.toLowerCase() !== setup.email) throw unavailable();
  }

  async function authenticatePassword(setup: ClientAccountSetup, suppliedPassword: string) {
    const signedIn = await input.provider.signInWithPassword(setup.email, suppliedPassword);
    if (!signedIn) throw invalidPassword();
    assertIdentity(signedIn.identity, setup);
    return signedIn;
  }

  async function needsActivation(saved: AccountProof, setup: ClientAccountSetup) {
    return Boolean(saved.invitationToken && saved.target
      && !await input.store.ticketGranted(saved.target.workspaceId, saved.target.ticketId, setup.userId));
  }

  async function completeSetup(setup: ClientAccountSetup, suppliedPassword: string) {
    const saved = proofSchema.parse(protector.open(setup.protectedProof, context(setup)));
    let identity = await input.provider.verifyCredential(saved.credential);
    let passwordAlreadySet = false;
    if (!identity) {
      // A successful provider password update may invalidate the original proof
      // before its response arrives. Only the same account's password can resume.
      const refreshed = await authenticatePassword(setup, suppliedPassword);
      identity = refreshed.identity;
      saved.credential = refreshed.credential;
      passwordAlreadySet = setup.action !== 'sign_in';
    }
    assertIdentity(identity, setup);
    if (!saved.invitationToken && await input.signInStore.findActiveClientUserId(setup.email) !== setup.userId) throw unavailable();
    if (setup.action === 'sign_in') {
      saved.credential = (await authenticatePassword(setup, suppliedPassword)).credential;
    } else {
      if (await needsActivation(saved, setup)) await checkInvitation(saved.invitationToken!, identity);
      // Revoke Alpha's independent cookies too, not just provider sessions.
      await input.store.revokeSessions(setup.userId);
      if (!passwordAlreadySet) {
        await input.provider.setPassword(saved.credential, suppliedPassword);
        saved.credential = (await authenticatePassword(setup, suppliedPassword)).credential;
      }
      await input.store.markPasswordConfigured(setup.userId);
    }
    if (await needsActivation(saved, setup)) {
      await input.activate({ invitationToken: saved.invitationToken, providerCredential: saved.credential });
    }
    const session = await input.sessions.exchange(saved.credential);
    if (!session) throw unavailable();
    return session;
  }

  return {
    async signIn(body: unknown) {
      const parsed = z.object({ email, password }).strict().safeParse(body);
      if (!parsed.success) throw invalidPassword();
      const userId = await input.signInStore.findActiveClientUserId(parsed.data.email);
      if (!userId) throw invalidPassword();
      const verified = await input.provider.signInWithPassword(parsed.data.email, parsed.data.password);
      if (!verified || verified.identity.userId !== userId || !verified.identity.emailVerified
        || verified.identity.email?.toLowerCase() !== parsed.data.email) throw invalidPassword();
      const session = await input.sessions.exchange(verified.credential);
      if (!session) throw invalidPassword();
      return session;
    },

    async begin(body: unknown) {
      const parsed = link.safeParse(body);
      if (!parsed.success) throw unavailable();
      const proof = parsed.data;
      if (proof.invitationToken && proof.providerTokenType === 'recovery') throw unavailable();
      const verified = await input.provider.verifyEmailLink(proof.providerTokenHash, proof.providerTokenType);
      if (!verified?.identity.emailVerified) throw unavailable();
      const identity = verified.identity;
      const normalized = email.parse(identity.email);
      const target = proof.invitationToken ? await checkInvitation(proof.invitationToken, identity) : null;
      if (!target && (proof.providerTokenType === 'invite'
        || await input.signInStore.findActiveClientUserId(normalized) !== identity.userId)) throw unavailable();
      // Supabase's hash may be generated during invitation. Only Alpha's
      // private marker proves that this client completed password setup.
      const hasClientPassword = await input.store.hasPassword(identity.userId);
      const action: ClientAccountSetup['action'] = proof.providerTokenType === 'recovery' ? 'reset_password'
        : hasClientPassword ? 'sign_in' : 'set_password';
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      const setup: ClientAccountSetup = { idHash: hash('setup', token), csrfHash: hash('csrf', csrf),
        userId: identity.userId, email: normalized, action, protectedProof: '',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      setup.protectedProof = protector.seal({ credential: verified.credential,
        invitationToken: proof.invitationToken ?? null, target }, context(setup));
      await input.store.create(setup);
      return { ...safeView(setup), token, csrf };
    },

    async inspect(token: unknown) { return safeView(await read(token)); },

    async finish(token: unknown, csrf: unknown, body: unknown) {
      const setup = await read(token);
      const parsed = z.object({ password }).strict().safeParse(body);
      if (!parsed.success || (setup.action !== 'sign_in' && parsed.data.password.length < 8)) {
        throw new TicketWorkflowError(400, 'client_password_invalid', 'Use a password of 8–128 characters.');
      }
      if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf)
        || !timingSafeEqual(Buffer.from(hash('csrf', csrf)), Buffer.from(setup.csrfHash))) {
        throw new TicketWorkflowError(403, 'client_setup_csrf_invalid', 'Refresh the setup page and try again.');
      }
      const result = await input.store.finish(setup.idHash, locked => completeSetup(locked, parsed.data.password));
      if (!result) throw unavailable();
      return result;
    },

    async recover(body: unknown) {
      const parsed = z.object({ email }).strict().safeParse(body);
      if (!parsed.success) return { accepted: true as const };
      try {
        const userId = await input.signInStore.findActiveClientUserId(parsed.data.email);
        if (!userId || (input.emailProvider.canSendTo && !input.emailProvider.canSendTo(parsed.data.email))) return { accepted: true as const };
        const generated = await input.provider.generateRecoveryLink(parsed.data.email);
        if (generated.userId !== userId) throw unavailable();
        const url = new URL('/', input.webOrigin);
        url.hash = `/client/activate?${new URLSearchParams({ providerTokenHash: generated.tokenHash, providerTokenType: 'recovery' })}`;
        await input.emailProvider.sendContent(parsed.data.email, 'Set your Alpha client password',
          `Open this secure, one-time link to set or reset your Alpha client password:\n\n${url}\n\nIf you did not request this email, you can ignore it.`, `client-recovery:${randomUUID()}`);
      } catch { try { input.onDeliveryUnavailable?.(); } catch { /* no account details in the public response */ } }
      return { accepted: true as const };
    },
  };
}
