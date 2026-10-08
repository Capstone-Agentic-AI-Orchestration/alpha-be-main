# Plan 3 — public inquiry application boundary

Local checkpoint: 8 October 2026. This follows the backend's existing
`src/ticketing`, `src/services`, `src/store`, and `docs/client-ticketing`
structure. It does not add another application, a desktop ticket authority, or
a process-local persistence substitute.

```text
src/ticketing/publicIntake.ts                  # fixed safe errors and generic acknowledgement
src/ticketing/intake.ts                        # strict public request contract
src/ticketing/readModels.ts                    # allowlisted PM/client request projections
src/services/ticketPublicIntakeService.ts      # proof, policy, rate-budget, retry and ticket rules
src/store/ticketPublicIntakeStore.ts           # durable guard/transaction contract
src/store/ticketPublicIntakePostgresStore.ts   # PostgreSQL adapter; local schema-backed tests
src/controllers/ticketPublicIntakeController.ts # dependency-injected HTTP boundary; not mounted
src/controllers/ticketPublicIntakeRouteFactory.ts # composes service + HTTP boundary; not mounted
src/store/ticketReadStore.ts                   # scoped request-detail read contract
src/controllers/errorHandler.ts                # fixed public error mapping; no route mounted
docs/client-ticketing/application-public-intake-layer.md
```

## Local behavior defined

The transport contract is `POST /api/public/ticket-intakes/:slug` with a
`proofToken` and a nested inquiry containing `schemaVersion: 1`, a UUID
`operationId`, required name/email/title/description, nullable company and
requested date. Success is HTTP 202 with exactly `{ "received": true }`.
The frontend rotates the operation ID when form content changes and retains it
for an unchanged retry. The matching DTO is in the frontend repository's
`alpha-fe-main/src/features/ticketing/publicIntakeContract.ts`. This documents
the boundary only; the route is not mounted and the preview does not call it.

1. Resolve a published, server-owned entry by slug. The caller cannot supply a
   workspace, client, project, identity, status, reference, or attachment.
2. Require configured server-side proof and exact allowed-origin/provider
   checks in the future guard. The route supplies server-observed origin and
   socket/trusted-proxy-resolved address separately from the JSON body; the
   guard HMACs the address before it can become a rate key. A proof token is not
   login or ticket access.
3. Require a valid UUID operation ID and strict bounded contact/title/description
   fields. The submitted email remains unverified and cannot authorize a read.
4. Commit both source and entry rate budgets before parsing or writing, so bad
   payloads and failed attempts still count. The store must be durable and
   atomic; no in-memory limiter or unlimited fallback is acceptable.
5. Recheck entry, workspace, feature mode, policy and proof expiry in the ticket
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

## Not implemented / required before enablement

- The frontend form still does not call a live endpoint. The controller factory
  defines `POST /:slug` for a future `/api/public/ticket-intakes` mount, but
  `index.ts` does not mount it and there is no callable intake endpoint.
- `PostgresTicketPublicIntakeStore` now implements the durable entry lookup,
  independently committed two-bucket limiter, reference allocation, private
  contact/request persistence, atomic audit/outbox/idempotency writes, and
  generic-retry lookup against the reviewed ticket schema. It deliberately
  accepts no provider token as identity and performs no email or runner action.
- Four PGlite tests run the store and intake service against the reviewed local
  schema. They verify generic acknowledgement, private unverified contact,
  idempotent retry/conflict, atomic rate budgets, and full inquiry rollback when
  an in-transaction write fails. The rollback test also proves the separately
  committed abuse budget remains charged.
- The PGlite rehearsal is not a hosted concurrency, deployment, RLS, Auth,
  Storage, anti-abuse-provider, or recovery test. The real proof/origin guard,
  isolated application configuration, staging concurrency checks, activation
  store, SMTP sender, and client login are still missing. Keep this route
  unmounted until the proof guard and staged acceptance are complete; do not use
  an allow-all/local fallback.
- When it is eventually mounted, mount only the narrow intake router—not a
  public `/client` or `/tickets` prefix. It must bypass GitHub/workspace identity
  only for this one proof-guarded POST, while retaining CORS, bounded JSON
  parsing, safe error handling, no-store response headers, and trusted-proxy
  address resolution. Do not trust arbitrary `X-Forwarded-For` input.
- The store methods specify required behavior; they do not prove SQL locking,
  uniqueness, rollback, RLS, cross-instance rate limits or hosted durability.
- The minimal notification signal is not an email and must not be displayed as
  one. Real delivery requires an approved, retryable outbox worker after commit.
- Account invitation must bind the verified client to this same inquiry ticket;
  do not duplicate it by calling signed-in ticket creation.

The backend typecheck and the four focused PGlite intake-store tests pass. The
controller is still unmounted; no hosted route/provider/database integration
is claimed. The shared/live database and staging project were not contacted by
this application-code checkpoint.
