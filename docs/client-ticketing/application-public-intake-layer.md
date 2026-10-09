# Plan 3 — public inquiry application boundary

Local checkpoint: 8 October 2026. This follows the backend's existing
`src/ticketing`, `src/services`, `src/store`, and `docs/client-ticketing`
structure. It does not add another application, a desktop ticket authority, or
a process-local persistence substitute.

```text
src/ticketing/publicIntake.ts                  # fixed safe errors and generic acknowledgement
src/ticketing/intake.ts                        # strict public request contract
src/ticketing/readModels.ts                    # allowlisted PM/client request projections
src/services/ticketPublicIntakeService.ts      # origin admission, policy, rate-budget, retry and ticket rules
src/store/ticketPublicIntakeStore.ts           # durable guard/transaction contract
src/store/ticketPublicIntakePostgresStore.ts   # PostgreSQL adapter; local schema-backed tests
src/controllers/ticketPublicIntakeController.ts # dependency-injected HTTP boundary; not mounted
src/controllers/ticketPublicIntakeRouteFactory.ts # composes service + HTTP boundary; not mounted
src/store/ticketReadStore.ts                   # scoped request-detail read contract
src/controllers/errorHandler.ts                # fixed public error mapping; no route mounted
docs/client-ticketing/application-public-intake-layer.md
```

## Implemented behavior

The transport contract is `POST /api/public/ticket-intakes/:slug` with a
nested inquiry containing `schemaVersion: 1`, a UUID
`operationId`, required name/email/title/description, nullable company and
requested date. Success is HTTP 202 with exactly `{ "received": true }`.
The frontend rotates the operation ID when form content changes and retains it
for an unchanged retry. The matching DTO is in the frontend repository's
`alpha-fe-main/src/features/ticketing/publicIntakeContract.ts`. Cloud routes are
mounted only when `ALPHA_TICKETING_TRIAGE_ENABLED=1`.

1. Resolve a published, server-owned entry by slug. The caller cannot supply a
   workspace, client, project, identity, status, reference, or attachment.
2. Require an exact allowed HTTPS origin and a server-resolved source address.
   The route supplies both separately from the JSON body; the guard HMACs the
   address before it can become a rate key. Origin checks constrain normal
   browser submissions but are not authentication or strong bot protection:
   non-browser callers can forge an Origin header. Durable database-backed
   per-source and per-entry budgets remain the abuse limits. Never trust a
   caller-supplied forwarded address.
3. Require a valid UUID operation ID and strict bounded contact/title/description
   fields. The submitted email remains unverified and cannot authorize a read.
4. Commit both source and entry rate budgets before parsing or writing, so bad
   payloads and failed attempts still count. The store must be durable and
   atomic; no in-memory limiter or unlimited fallback is acceptable.
5. Recheck entry, workspace, feature mode, policy and admission expiry in the ticket
   transaction. Serialize even absent idempotency keys. HMAC fingerprints use
   retained server-only keys; same-ID/same-content retry returns only the generic
   acknowledgement, while same-ID/different-content returns a fixed conflict.
6. Create one `Received` inquiry ticket with `clientId: null`; persist the
   submitted contact privately and mark it unverified in the PM read model.
   Create no client grant/account, project, Issue, execution, or scope approval.
7. Commit ticket, reference, audit, minimal notification signal and deduplication
   record together. No email/network call occurs inside that transaction.
8. Return only `{ received: true }`. Do not expose a ticket ID, reference, status
   lookup, or account-existence signal to the anonymous submitter.

The read projection follows the established allowlist pattern: PMs may see the
source, project preference, requested date and unverified contact; client reads
may see only the safe project preference/label and requested date. Legacy rows
may omit request metadata. Neither projection turns preferences into approved
scope or project membership.

## Operational boundaries and verification limits

- The configuration route reports enabled only when the server HMAC secret is
  present and the published entry/workspace write mode is enabled. The POST
  additionally checks the request origin against the existing CORS allowlist.
  The UI cannot override either server decision.
- `PostgresTicketPublicIntakeStore` now implements the durable entry lookup,
  independently committed two-bucket limiter, reference allocation, private
  contact/request persistence, atomic audit/outbox/idempotency writes, and
  generic-retry lookup against the reviewed ticket schema. It uses no external
  CAPTCHA provider and performs no email or runner action as part of the write.
- Four PGlite tests run the store and intake service against the reviewed local
  schema. They verify generic acknowledgement, private unverified contact,
  idempotent retry/conflict, atomic rate budgets, and full inquiry rollback when
  an in-transaction write fails. The rollback test also proves the separately
  committed abuse budget remains charged.
- The PGlite rehearsal is not a hosted concurrency, deployment, RLS, Auth,
  Storage, or bot-mitigation test. Exact Origin validation and durable source /
  entry budgets reduce casual abuse but are not equivalent to CAPTCHA; callers
  outside browsers can forge Origin. Keep the route narrowly scoped to this
  public POST, retain CORS, bounded JSON parsing, safe error handling and
  no-store headers, and do not trust arbitrary `X-Forwarded-For` input.
- The store methods specify required behavior; they do not prove SQL locking,
  uniqueness, rollback, RLS, cross-instance rate limits or hosted durability.
- The minimal notification signal is not an email and must not be displayed as
  one. Real delivery requires an approved, retryable outbox worker after commit.
- Account invitation must bind the verified client to this same inquiry ticket;
  do not duplicate it by calling signed-in ticket creation.

The shared/live database is not changed by application code in this flow. The
live route remains controlled by the existing deployment feature switch and
persisted intake-entry state; test results and deployment status must be checked
separately for each release.
