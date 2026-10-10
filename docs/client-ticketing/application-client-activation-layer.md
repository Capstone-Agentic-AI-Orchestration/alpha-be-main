# Plan 3 — client invitation activation boundary

The contract notes below describe the original application-layer checkpoint. The
current Phase 4 composition is mounted by `src/index.ts` and uses the shared
Postgres database, Supabase Auth, and the existing Resend sender.

## Current hosted invitation setup

- Set `ALPHA_TICKETING_TRIAGE_ENABLED=1` and keep the existing Supabase and
  Resend server settings. `SUPABASE_SERVICE_ROLE_KEY` is required only on the
  hosted backend; it must never be put in desktop build inputs or browser code.
- `CORS_ORIGIN` must contain one exact HTTPS browser origin, such as
  `https://alpha-fe-main.vercel.app`. Wildcards, paths, credentials, and request
  headers cannot select the activation-link destination. A separate API origin
  may also be listed when `ALPHA_CLOUD_API` identifies it unambiguously.
- The hosted backend does not need the desktop-only `ALPHA_CLOUD_API` setting
  to resolve a single exact browser origin. The website and its `/api` proxy may
  share the same origin; that must not disable client activation.
- When `RESEND_TEST_RECIPIENT` restricts delivery, the PM invitation action checks
  the original inquiry contact after authorizing the PM, but before storing an
  invitation. It returns `ticket_invitation_recipient_restricted` without
  changing the ticket or queuing an email. Do not change a client's submitted
  email or bypass this restriction to make a test pass.
- Missing server settings leave client access closed without disabling GitHub
  login, Projects, Issues, or PM triage. Backend startup logs identify missing
  setting names without logging credentials; the PM sees a specific setup
  message instead of a generic service failure.
- Merging or deploying the backend fix is separate from publishing a desktop
  update. A successful build/regression run does not prove that hosted settings,
  invitation delivery, and client activation have passed a real release test.

## Original contract checkpoint

This follows the existing
`src/ticketing`, `src/services`, `src/store`, and `docs/client-ticketing`
structure. It does not contact Supabase, send email, or create an Auth user.

## Rule implemented

`src/ticketing/clientActivation.ts` contains the provider-neutral eligibility
check. `src/services/ticketClientActivationService.ts` and
`src/store/ticketClientActivationStore.ts` now define the corresponding
application transaction boundary. A server-side identity verifier is injected;
the provider credential is never treated as identity until that verifier checks
it. The service hashes the one-time invitation token, resolves its candidate
ticket, then in one transaction ensures/locks the workspace client-service
grant first, locks the ticket and invitation in the shared order, and re-reads
the original private inquiry contact. Activation is allowed only when all of
these are true:

- The server-side identity-provider verifier supplied a non-empty user ID and
  explicitly verified the user's email. Request fields and editable profile
  metadata are not identity evidence.
- The invitation is pending, unexpired, and bound to the same ticket and
  workspace as the locked ticket.
- The activation transaction re-reads the private contact referenced by the
  invitation from the original inquiry, confirms that contact binding still
  matches, then canonicalizes and compares its email with the verified email.
  The invitation record itself does not store the email.
- The ticket is the original `public_inquiry`, still `under_review`, and has no
  client identity bound yet.

The service ensures a client-service grant without reactivating a revoked one,
consumes the invitation, binds the verified provider user to the same ticket,
creates only that ticket's grant, and writes audit/outbox records atomically.
Binding increments the ticket workflow version but leaves its status under
review. It never creates workspace membership, project/repository access, a
second ticket, or work authorization. Expired, revoked, consumed, mismatched,
and otherwise unavailable invitations return the same non-enumerating 404.

The service deliberately does not create the separate Alpha client session.
After activation, a later provider-authenticated session exchange must create
that revocable HttpOnly cookie; if a response is lost, the client can sign in
again without reusing the one-time invitation as a login credential.

## Pre-activation communication

An unverified inquiry contact must not receive private ticket messages or gain
ticket lookup through an email address alone. PM triage notes remain internal.
The simplest safe sequence is: PM approves suitability and sends an invitation;
the recipient verifies the invited email and activates the same inquiry ticket;
only then can the PM request clarification in the ticket conversation. The
invitation is not scope agreement or work authorization.

## Historical limitations at the original checkpoint

- A production activation-store adapter. PM invitation issuance now creates the
  matching one-time-token hash and encrypted outbox envelope; delivery is still
  not connected.
- A real provider-verifier adapter, Alpha client-session exchange, CSRF/origin
  boundary, returning-client sign-in without open signup, mail/outbox delivery,
  recovery and revocation. Unmounted transport boundaries now exist in
  `application-client-api-layer.md`; they are not yet connected to a provider or
  persistent store.
- Provider-specific callback/OTP behavior and SMTP readiness must be verified
  against the isolated staging Auth configuration in the deferred Supabase
  phase. No client-auth route is mounted.

No tests were added or run for this checkpoint; typecheck is the available
verification. These contracts do not prove provider identity, transaction
atomicity, hosted authorization, or delivery.
