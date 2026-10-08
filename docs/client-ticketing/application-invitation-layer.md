# Plan 3 — PM invitation issuance boundary

Local application-layer checkpoint. This follows the existing
`src/controllers`, `src/services`, `src/store`, `src/ticketing`, and
`docs/client-ticketing` folders. There is no database adapter, mounted API,
provider call, or email.

## Behavior defined

`ticketInvitationService.issue(target, subject)` requires a freshly authorized
PM and a ticket already moved to `Under review` through the existing ticket
command workflow. It then:

1. Refuses when ticket writes are disabled, the inquiry is not a public intake,
   its contact email is already verified/missing, a client is already bound, or
   scope/project/Issue authorization has begun.
2. Resolves the recipient only from the private original inquiry. The invitation
   stores an internal reference to that immutable contact record, not the email.
   No email, ticket description, or user-supplied recipient is accepted as input.
3. Serializes by ticket. A valid existing pending invitation is returned on
   retry; an expired one is marked expired before a replacement is created.
4. For a new invitation, creates a 32-byte random token, stores only its
   SHA-256 hash in the invitation record, and writes a locally encrypted
   AES-256-GCM token envelope into the outbox. The envelope is authenticated to
   the workspace, ticket, invitation ID and expiry, so it cannot be moved to a
   different invitation. The raw token is never returned to the PM or stored.
5. Writes invitation, minimal PM audit, and delivery signal in one transaction.
   The record/outbox contain no recipient email or message body; only the
   retryable encrypted token envelope is carried in the outbox.
6. Returns only the invitation ID, ticket ID, expiration, and whether it was
   already pending. This does not claim an email was sent or an account created.

`src/controllers/ticketInvitationController.ts` defines the matching PM-only
transport boundary for `POST /tickets/:ticketId/invitations`. It derives the
workspace and identity proof from the existing authenticated request, requires
the existing `ticket.manage` capability, accepts no recipient or workflow
fields from the body, and projects a minimal no-store response. The adjacent
`ticketCommandController.ts` exposes the existing PM command and operation
reconciliation services through equally scoped transport contracts; the
`review` command can therefore move the inquiry to `Under review` before the
separate invitation call. Desktop requests use the existing GitHub-authenticated
cloud relay; an unconfigured desktop cloud connection fails closed rather than
writing to local storage. Both routers are still unmounted because durable
ticket/invitation stores are not implemented.

The provider-neutral `ticketInvitationDeliveryService` and
`TicketInvitationDeliveryStore` contract now define that worker boundary. A
claim must load the invitation, eligible ticket state, and immutable original
contact together; the service checks the contact binding, decrypts the envelope,
and constant-time compares the token digest before sending plain text through
an injected provider outside the transaction. Retries reuse the same outbox
event and stable provider idempotency key. Delivery is at-least-once, so a
duplicate email is possible; the same one-time token remains safe to activate
only once. The worker sends no ticket description or project data.

Activation hashes the submitted token and matches it to the stored verifier,
then re-reads that original contact and compares its email with the verified
identity. A changed contact suppresses delivery; an inactive ticket or expired
invitation is also suppressed. The worker contract is not yet composed with a
durable outbox adapter or a real provider, and no email has been sent.

## Lifecycle boundary

PM review and invitation issuance are separate, recoverable actions: first mark
the received inquiry `Under review`, then issue the invitation. If issuance
fails, the ticket remains under review and no work is authorized. After the
recipient verifies the invited address, the activation gate in
`application-client-activation-layer.md` binds that identity to this same
inquiry ticket. Scope agreement, project linking, Issue creation, and developer
execution remain separate later decisions.

## Not implemented

- A production `TicketInvitationStore` adapter, schema, or database constraints.
- Protected-key configuration, rotation/retention operations, and the durable
  implementation/scheduling of `TicketInvitationDeliveryStore`.
- Invitation resend/revoke/supersede commands, client session creation, or
  returning-client sign-in.
- A runtime provider/Auth adapter, callback allowlist, SMTP, or delivery
  confirmation.
- A mounted route, connected PM UI action, or durable invitation/outbox store.
  The PM preview now presents separate disabled “Mark under review” and “Issue
  client invitation” steps; neither action is connected to the controllers.

The configured invitation lifetime is server-owned and bounded; no PM request
can select it. `src/ticketing/invitationSecret.ts` supplies the provider-neutral
authenticated-encryption primitive; it has no default key and cannot issue or
deliver invitations by itself. The web route now has a fail-closed activation
entry, but no identity/provider functionality is enabled.

The PM invitation route remains unmounted. Typechecks pass for the additional
queue/read controllers and secret-envelope contract; tests were not run for
this checkpoint.
