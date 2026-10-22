# Phase 3 of 9: inquiry acknowledgment email

## What this adds

Gmail's HTTPS API, authenticated with server-side OAuth, sends a generic inquiry receipt after the
existing PostgreSQL inquiry transaction commits. The public response stays
`{ received: true }`: it does not reveal private ticket identifiers, create a
client account, or claim that work has been approved.

The same Gmail sender also delivers PM-issued client invitations and password
recovery links through their existing, separate account-access queue. Conversation
message notices are not sent through Gmail; the existing optional Resend route
remains separate for those notices.

The Gmail transport is in the existing backend `src/services` structure. The
client UI removes the separate passwordless sign-in-link option; invitation
verification, password setup, password recovery and password sign-in remain.
No desktop source, GitHub App, runner, package dependency, or database schema is
changed. Automated tests reuse the existing test harness; no new dependency or
Supabase migration is needed.

## Durable delivery and safety

- The existing private `ticket_outbox_events` table is the queue. A new version
  marker is added atomically with new inquiries only when the email switch is
  enabled. Historical/sample events without the marker are never drained.
- Only matching public inquiries, contacts, requests and saved intake operations
  in active, write-enabled workspaces qualify. Recipient addresses are loaded
  from private contact records; no addresses or inquiry contents enter outbox
  payloads or error logs.
- Workers claim one row using `FOR UPDATE SKIP LOCKED`, persist a two-minute
  lease and commit before calling the provider. Requests are time-limited to ten seconds.
- The event UUID is Alpha's stable delivery key. Gmail has no send-idempotency
  API; a stable RFC Message-ID helps correlate retries but does not prevent a
  duplicate after an ambiguous timeout. A persisted dispatch timestamp and
  identity fingerprint prevent replay through a changed provider or recipient.
- Retries are automatic and controlled: maximum five dispatch attempts, backoff
  of 30/60/120/240 seconds, and a conservative ten-minute first-dispatch window.
  Expired leases are recoverable only within that window. Permanent rejections,
  exhausted attempts and uncertain deliveries outside the window become `dead`.
- A stale worker cannot overwrite a newer lease. An unknown claim COMMIT never
  initiates a provider call. Lost post-send confirmation is recovered with the
  same key, never a freshly generated delivery key.
- Existing schema status `delivered` means **accepted by Gmail**, not proven inbox
  delivery. Bounces and webhook tracking are not implemented. Account invitations
  use a separate queue, even though they share the Gmail OAuth sender.
- An email outage does not undo the saved inquiry or stop Alpha's server. Queue
  work is bounded and polling cannot overlap within a process. Shared instances
  coordinate through database leases. No provider request runs inside a DB
  transaction. Hosting sleep can delay receipts until the service wakes.

## Hosted configuration, not desktop configuration

Keep the existing live Agentic-Orchestration connection and all original keys.
Do not use the staging project, reset schema, or replay prior sample inquiries.
Phase 2's allowed-origin configuration, published intake entry and public intake
must already be ready. No Turnstile configuration is required.

1. In Google Cloud, enable the Gmail API and configure Alphaexplora's OAuth
   consent screen. Use the Google account that will send Alpha's messages.
2. Create an OAuth client and grant only
   `https://www.googleapis.com/auth/gmail.send`, with offline access so the
   backend can send while nobody is signed in. Do not request Gmail read,
   mailbox, or full-access scopes.
3. Configure the consent screen's app name, support contact, home page, privacy
   policy and authorized domains. `gmail.send` is a sensitive scope. Google
   requires verification for public external production use unless an exception
   applies. Testing mode is limited to listed test users, shows an unverified-app
   warning, and refresh tokens expire after seven days.
4. Configure these values only in the hosted backend's secret environment:
   - `GMAIL_OAUTH_CLIENT_ID`
   - `GMAIL_OAUTH_CLIENT_SECRET`
   - `GMAIL_OAUTH_REFRESH_TOKEN`
   - `GMAIL_SENDER_EMAIL`: the authorized Gmail account or its verified send-as
     address.
   - `GMAIL_SENDER_NAME`: for example, `Alphaexplora`.
   Keep all OAuth credentials out of Vite, the desktop app, source control and
   chat. `RESEND_*` remains only for the separately configured optional
   conversation-notice route; Gmail does not send those notices.
5. Keep `ALPHA_TICKETING_ACK_EMAIL_ENABLED=0` while setting up and checking the
   provider. The cloud code selects Gmail directly; the old
   `TICKET_ACK_EMAIL_PROVIDER` selector does not switch it back to Resend.
   Client-access routes also require a configured Gmail provider.
6. Keep the existing Phase 2 intake settings unchanged. Once credentials and
   consent are verified, enable
   `ALPHA_TICKETING_ACK_EMAIL_ENABLED=1` on the hosted backend. Do not change
   Render as part of this source-code branch.
7. Verify the real workflow: client submits an inquiry → PM sees it in shared
   intake → PM accepts and invites that email → client verifies the invitation
   and chooses a password → client signs in and sees only shared tickets. Also
   test password recovery and confirm conversation notices remain separate.
   Automated tests cannot prove real inbox delivery; check the sender account
   and recipient inbox.

This Gmail approach does not require a custom sending domain, but the sender
must be the authorized Google account or a verified send-as address. Sending
limits still depend on that Google account. Keep sending disabled until hosted
secrets, OAuth consent and a real recipient test are ready. Switching providers
does not replay uncertain or previously attempted deliveries; reconcile those
first to avoid duplicates.

## Provider boundaries

The cloud composition uses Gmail for inquiry receipts and client-access email:
PM invitations, account activation and password recovery. It does not fall back
to Resend if Gmail credentials or delivery fail. Resend's optional conversation-
notice route is separate and is not used for inquiry or account-access email.
The client no longer has a standalone passwordless sign-in-link request; access
uses invitation/password setup, password sign-in or password recovery.

Gmail does not provide an idempotency key for sends. Alpha reuses its stable
delivery key in the RFC Message-ID for correlation, but an ambiguous timeout can
still cause a duplicate on retry. Do not clear dispatch metadata or automatically
fail over an uncertain delivery. The provider-identity guard blocks retrying an
attempted invitation through a different provider or sender; a PM can issue a
fresh invitation after checking the previous send status.

## Failures, recovery and rollback

Queue failures use the existing private failure-code fields; provider bodies,
API keys and recipient addresses are not logged. `retry` rows are retried only
under the bounds above. There is no public resend endpoint or unlimited resend
button. `dead` rows require operator review against the selected provider's activity, especially
when a network timeout may have hidden an accepted send. Do not reset them to
pending or clear dispatch metadata indiscriminately: that can duplicate email.
An operator-controlled reissue beyond these bounds is intentionally not added.

Disabling the hosted email flag stops enrollment and worker startup after the
configuration restart. It does not erase contacts, tickets, audit history or
outbox rows. Accepted emails cannot be recalled by toggling the flag.
No DROP, DELETE, new migration, or live data mutation is required by this phase.

## Historical Resend implementation verification (2026-10-09)

This section records the earlier Resend implementation, not the current Gmail
OAuth branch.

- Backend typecheck and production build passed.
- Phase 3-focused regression recheck: 4 test files, 74 tests passed.
- A fresh full-suite attempt was inconclusive in the Windows sandbox: 18 test
  files / 220 tests failed when unrelated test fixtures tried to create
  temporary Git repositories under the sandbox's AppData Temp path and received
  `Permission denied`. This is a test-runner filesystem restriction, not a
  demonstrated Phase 3 regression. An earlier full-suite run reported 153 test
  files and 2,640 tests passing.
- Frontend and desktop worktrees remain unchanged by this provider switch.
- No live database write, real email, localhost app test or deployment was
  performed. The Phase 3 source branch was pushed for review; hosted credentials
  and a confirmed real receipt remain outstanding, so Phase 3 is not yet complete.

## Current Gmail branch verification (2026-10-22)

- Backend typecheck and production build passed; focused Gmail, inquiry,
  invitation, account setup and portal regressions passed (6 files, 86 tests).
- Frontend typecheck and production build passed; frontend suite passed (40 files,
  418 tests). The build retains the existing large-chunk warning.
- The full backend suite reported 2,955 passed and 6 failed in
  `chatOrchestratorRouting.test.ts` (`Orchestration run not found`). The same six
  failures reproduce on the clean `origin/main` worktree; they are unrelated to
  the email/account changes.
- No real Gmail OAuth credentials, Google verification, inbox delivery, Render
  change or deployment was performed. Those remain external setup/acceptance
  steps before the new sender is live.

## Google provider documentation

- [Gmail send endpoint and required scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Gmail API scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail API error handling and rate limits](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Google OAuth sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [OAuth web-server flow and offline refresh tokens](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth refresh-token behavior](https://developers.google.com/identity/protocols/oauth2/)

The Gmail API accepts a base64url-encoded MIME message and returns a Gmail
message resource when accepted. A successful API response is not proof of inbox
delivery. The Gmail `send` scope is sensitive; verification, testing-user limits
and refresh-token lifetime depend on the OAuth project's publishing status and
Google's review. Gmail rate-limit responses are retried within Alpha's existing
bounded delivery policy; permission and consent errors are not.
