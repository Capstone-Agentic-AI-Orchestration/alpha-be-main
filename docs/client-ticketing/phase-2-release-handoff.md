# Phase 2 of 9: inquiry submission and PM queue

## Delivery boundary

Work is in the existing `alpha-be-main` and `alpha-fe-main` repositories on
`feat/client-ticketing-phase-2-release`. No extra worktree, localhost application,
development persistence adapter, deployment or desktop release is required for
the code review. The older six-phase documents are historical.

The original unfinished implementation remains recoverable in Git stashes named
`preserved-before-phase-2-worktree-correction-20261009`. Those stashes, `.env`
files and `local-preservation` are not part of this PR.

## Implemented

- Public inquiry requires name, email, title and details; company/date are optional.
- `/#/request?intake=alpha-workspace` resolves a published entry on the server.
  The client cannot supply its own workspace identifier or authenticated role.
- Cloudflare Turnstile is validated server-side for success, hostname, action,
  intake slug and age. Missing configuration and provider dummy keys fail closed.
- A generic submission receipt reveals no private ticket identifier or lookup.
- Existing cloud `database()`/`TransactionalSql` persists the inquiry, contact,
  request, audit, outbox and idempotency operation atomically in PostgreSQL.
- Retries reuse the operation ID. Changed content under that ID is rejected.
- Durable source/entry rate limits use a hashed socket address, not trusted input
  from arbitrary forwarded headers. No raw IP address is stored by this adapter.
- Authorized PMs see the workspace queue, open details, mark under review, save
  private notes and decline with a required reason retained in private history.
- Membership/session authorization is rechecked before reads, writes and retry
  recovery. Row locks and version checks prevent stale workflow updates.
- Private notes do not change client-visible clocks or send notifications.
- Desktop uses the existing authenticated cloud relay, not a new local database.
- Later workflow actions fail closed. No client invitations, email worker,
  document pipeline, Issue creation or orchestration is enabled by this phase.

## Database boundary

Use the existing **Agentic-Orchestration** connection and TLS certificate.
Do not rotate database, session or GitHub credentials as part of this release.
The Phase 2 tables are in `alpha_private`, not the older public ticket tables.
Their RLS and denied direct API-role SELECT privileges were checked read-only.
No live schema or data was changed during this release-readiness pass.

Four additive Phase 2 migrations are included for source/history review:

1. `20261009075644_ticketing_inquiry_pm_queue_core.sql`
2. `20261009075718_ticketing_inquiry_pm_queue_fk_indexes.sql`
3. `20261009090100_ticketing_pm_read_support_tables.sql`
4. `20261009110000_ticketing_triage_operation_receipts.sql`

The first three versions are recorded in live migration history. The operation
receipt table also exists, but version `20261009110000` was not returned by the
history check; its source/history must be reconciled by the database maintainer
before rollout. Do not blindly reapply the entire migration directory or use a
schema reset. Older 0016/0017 baseline differences
are not authorization to change unrelated live tables. Rollback disables the
feature/entry switches, leaving additive schema and ticket history intact.

## Rollout after the user approves publishing

1. User reviews/merges separate frontend and backend Phase 2 PRs. A push itself
   does not publish a desktop installer. Check any existing hosting auto-deploy
   settings before merging if hosted deployment must also remain deferred.
2. Release the hosted backend before the desktop build. The installed daemon
   forwards Tickets to this backend; updating the desktop alone is insufficient.
3. Keep all existing cloud, database, session, GitHub App and CORS settings.
   Enable `ALPHA_TICKETING_TRIAGE_ENABLED=1` only after verifying its schema.
   `ALPHA_TICKETING_READS_ENABLED` remains the existing independent read switch.
4. Public inquiry needs a real Turnstile widget for the client web hostname.
   Configure `TICKET_TURNSTILE_SECRET` only on the backend and
   `TICKET_TURNSTILE_SITE_KEY` there. Never place the secret in frontend variables.
   Without these, PM queue/triage can work, but public submissions stay disabled.
5. Web production uses `VITE_API_URL=/api` and the existing `API_ORIGIN` proxy.
   Keep the authorized web origin in the existing CORS allowlist. If a CSP exists,
   review only the directives needed for the Turnstile script/frame endpoint.
6. Build the next desktop iteration through the existing packaging process with
   its six established public settings. Do not package `.env`, database passwords,
   session/provider secrets, development flags or preserved source folders.
   No desktop source/version/configuration change is part of these Phase 2 PRs.
7. After explicit release approval, test PM login, queue, review, private note,
   decline/retry and refresh in the installed update, plus existing Projects,
   Issues, GitHub login and developer execution. Client inquiry remains browser
   functionality: its real submission check needs an approved hosted web page,
   not an internal desktop screen. No localhost acceptance test is planned.

## Verification and remaining release gates

On 9 October 2026, backend typecheck/build and all **151 files / 2,575 tests**
passed. The frontend typecheck/build and all **25 files / 287 tests** passed.
All **8 migration-audit tool tests** passed. `git diff --check` is clean.
These automated regressions use Alpha's existing isolated test harness, not live
user data. No manual localhost test was performed during this pass.

The separate `audit:migrations` command did **not** pass: its historical
7 October snapshot marks the four new files unreviewed, retains the existing
0016/0017 gaps, and records an older reviewed difference for 0012. This is not
a unit-test failure, and it must not be suppressed or described as deployment
approval. Read-only live inspection confirmed the receipt table's columns,
constraints, RLS and denied API-role data privileges match the intended boundary;
its missing migration-history version still needs reconciliation before rollout.

All 12 backend production dependencies are already declared by the desktop.
No package versions, lockfiles, runner, session or GitHub auth files changed.
The desktop working tree remains clean at version 2.0.21; a new installer has
not been built, tested or published in this pass.

Frontend PR CI now runs regressions as well as typecheck/build, with `/api`
configuration. Backend CI retains its existing typecheck/test/build workflow.

Production provider credentials and installed-update acceptance are release
gates, not completed by a passing unit test. No email has been sent by this phase.
Phase 3, acknowledgment email, starts only after Phase 2 review.
