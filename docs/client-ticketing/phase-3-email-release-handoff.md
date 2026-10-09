# Phase 3 of 9: inquiry acknowledgment email

## What this adds

Resend's HTTPS transactional API sends a generic inquiry receipt after the
existing PostgreSQL inquiry transaction commits. The public response stays
`{ received: true }`: it does not reveal private ticket identifiers, create a
client account, or claim that work has been approved.

The implementation is in the existing `src/services` and `src/store` folders.
No desktop source, frontend screen, GitHub App, database connection credentials,
runner, session logic, package dependency, or database schema is changed.
Automated tests reuse the existing PostgreSQL/Vitest harness. No new localhost
server, local-only adapter, checkout folder, or preservation folder is needed.

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
- The event UUID is the stable provider idempotency key. A persisted dispatch
  timestamp and identity fingerprint survive deployment/restarts. Changed sender
  content or recipient stops automatic delivery rather than mutating a retry.
- Retries are automatic and controlled: maximum five dispatch attempts, backoff
  of 30/60/120/240 seconds, and a conservative ten-minute first-dispatch window.
  Expired leases are recoverable only within that window. Permanent rejections,
  exhausted attempts and uncertain deliveries outside the window become `dead`.
- A stale worker cannot overwrite a newer lease. An unknown claim COMMIT never
  initiates a provider call. Lost post-send confirmation is recovered with the
  same key, never a freshly generated delivery key.
- Existing schema status `delivered` means **accepted by the selected provider**,
  including confirmed idempotent responses. It does NOT prove inbox delivery. Bounces,
  webhook delivery tracking and account-invitation email are not this phase.
- An email outage does not undo the saved inquiry or stop Alpha's server. Queue
  work is bounded and polling cannot overlap within a process. Shared instances
  coordinate through database leases. No provider request runs inside a DB
  transaction. Hosting sleep can delay receipts until the service wakes.

## Hosted configuration, not desktop configuration

Keep the existing live Agentic-Orchestration connection and all original keys.
Do not use the staging project, reset schema, or replay prior sample inquiries.
Phase 2's real Turnstile configuration and public intake must already be ready.

1. Create a Resend account. For delivery to real clients, verify an owned sending
   domain and use a sender address on that domain. The desktop app and a Vercel
   hosting URL are not owned sending domains. Quotas are controlled by Resend.
   If no domain is available yet, follow the restricted account-only path below;
   it is NOT a release-ready email service for arbitrary clients.
2. Generate a sending API key in Resend. Do not share it in chat or commit it.
3. Configure only the hosted backend secret/environment settings:
   - `RESEND_API_KEY`: secret API key, stored only on the hosted backend.
   - `RESEND_SENDER_EMAIL`: sender address on the verified domain.
   - `RESEND_SENDER_NAME`: sender display name, such as Alpha.
   - `RESEND_TEST_RECIPIENT`: optional approved recipient restriction for a pilot;
     mandatory when using the default `onboarding@resend.dev` sender.
   - `ALPHA_TICKETING_ACK_EMAIL_ENABLED=0` while preparing deployment.
   - `TICKET_ACK_EMAIL_PROVIDER=resend`: selected adapter; defaults to Resend when
     unset. Empty/unsupported values disable delivery
     rather than silently switching providers.
4. Deploy the reviewed Phase 3 backend branch after the user merges/approves it.
   Keep the existing `ALPHA_TICKETING_TRIAGE_ENABLED` setting and Phase 2 intake
   switches; this phase does not silently change them.
5. Once configuration is verified, explicitly enable
   `ALPHA_TICKETING_ACK_EMAIL_ENABLED=1` on the hosted backend. Do not add these
   settings to Vite, the Electron settings allowlist, or any desktop artifact.
6. Submit one NEW inquiry through the approved hosted client page using the
   recipient already approved by the user (do not hardcode their address).
   Confirm the PM queue contains
   one ticket, reload/retry the same submission, and verify only one receipt.
   A manual localhost acceptance test is not required or planned.
7. Confirm actual inbox receipt with the recipient and check Resend activity.
   Do not mark this phase complete just because automated tests passed.

### Without an owned domain

Use `RESEND_SENDER_EMAIL=onboarding@resend.dev` and set
`RESEND_TEST_RECIPIENT` to the email address associated with the Resend account,
only if that address is the approved real-test recipient. Resend enforces this
restriction; Alpha's allowlist does not itself verify account ownership.
Missing/invalid allowlist configuration disables this sender. A receipt for a
different recipient is rejected before any provider call, never redirected to
the account owner. The inquiry remains saved. Nonmatching enrolled receipts can
become `dead`, so do not enable this restricted setup for a general client launch.

Keep sending disabled until the hosted configuration and approved test are
ready. To enable arbitrary client delivery later, verify an owned domain, change
the sender, and remove the restriction only after reconciling attempted rows.
Switching senders changes the identity guard; it does not replay earlier failed
or uncertain receipts automatically.

## Future provider changes

The delivery worker accepts the common `TicketAcknowledgmentEmailProvider`
contract through a factory. Provider selection/credentials remain in cloud
composition, separate from queue processing and ticket submission. Resend is the
default adapter. Brevo remains an explicitly selected alternative using
`TICKET_ACK_EMAIL_PROVIDER=brevo` and its existing `BREVO_API_KEY`,
`BREVO_SENDER_EMAIL`, and `BREVO_SENDER_NAME` settings. Neither adapter falls back
to the other when credentials or delivery fail. Other names are unsupported.

To add another provider, implement its adapter, error classification and verified
idempotency guarantees, register it in `createTicketAcknowledgmentEmailProvider`,
and run adapter/queue regression tests. Then configure its hosted credentials
and change the selector. No ticket tables, PM interface or desktop logic need
to change merely to replace this acknowledgment sender. Other email features
such as Supabase Auth invitations have their own configuration and are not
automatically switched by this selector.

Stop sending before switching. Reconcile attempted/uncertain deliveries with the
old provider first; deduplication keys are not shared between providers. The
existing identity guard blocks replay of attempted rows through a changed
provider or sender. New/unattempted enrolled inquiries can use the new adapter.
Never clear dispatch metadata to force a migration and never enable automatic
cross-provider failover: an uncertain response could otherwise send two emails.

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

## Verification status (2026-10-09)

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

## Provider documentation

- [Resend send email API](https://resend.com/docs/api-reference/emails/send-email)
- [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Resend default sender restrictions](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)
- [Brevo transactional email API](https://developers.brevo.com/reference/send-transac-email)
- [Brevo idempotency](https://developers.brevo.com/docs/heterogenous-versions-batch-emails)
- [Create and manage API keys](https://help.brevo.com/hc/en-us/articles/209467485-Create-and-manage-your-API-keys)

Resend retains idempotency keys for 24 hours. Brevo's current guidance documents
a 30-minute TTL; older guidance documented 15 minutes. Alpha deliberately keeps
the same conservative ten-minute retry window for both adapters rather than assuming
unlimited exactly-once email delivery. Provider acceptance and recipient delivery
must be checked separately before team release.

Resend uses the HTTP `Idempotency-Key` header. Concurrent-idempotency conflicts
can retry with the same key; a changed-payload conflict is permanent. Successful
responses must contain an email ID before being marked accepted. Authentication,
permission and validation errors are permanent; rate limiting and server/network
errors use the existing bounded retry policy. No provider response bodies or keys
are exposed to clients or logs.
