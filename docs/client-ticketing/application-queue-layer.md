# Plan 3 — authorized ticket queues and minimal counters

Local checkpoint: 8 October 2026. Application-first preparation only. No Supabase
call, hosted configuration, real email, environment change or deployment.
The read-only PM queue API is mounted behind a default-off environment gate;
ticket writes and client ingress remain unavailable.

## Existing folders followed

```text
src/services/ticketQueueService.ts       # one transaction, pagination, safe totals
src/services/ticketQueueService.test.ts  # colocated test-only query fixture
src/controllers/ticketQueueController.ts # PM-only, allowlisted HTTP boundary
src/services/ticketAccess.ts             # shared detail/collection access boundary
src/store/ticketQueueStore.ts            # scoped query contract, no runtime DB
src/ticketing/queueModels.ts              # explicit queue DTOs and metric rules
docs/client-ticketing/application-queue-layer.md
```

The existing detail, conversation, workflow, operation and message services remain
separate reusable boundaries. No new application, runner or desktop ticket store.

## Implemented rules

1. Resolve trusted credentials, the exact workspace service and current role/
   grant before input validation or data queries. Clients use a separate client
   service grant and individual ticket grants, not internal workspace membership.
   PMs require active membership and the PM-only `ticket.manage` capability. Developers
   and other unsupported internal roles do not receive this queue. Existing
   verified desktop GitHub bearer identities remain compatible.
2. Load a bounded, already-authorized page, then complete-scope counters in the
   same transaction/snapshot. Do not retrieve a global list and filter it in
   application code. Client-specific grants apply to both rows and aggregates.
3. Accept only bounded limit/cursor, plain reference/title search and role-specific
   filters. Unknown/server-owned fields, caller timezone/clock and the other
   audience's filters are rejected. The PM queue controller parses exact scalar
   query fields and explicitly allowlists PM queue rows/counters; it does not
   forward arbitrary Express query objects or a service/store object wholesale.
4. Sort client rows by public update descending, then binary/C ticket ID
   descending. PM sorting may use the internal clock. Private notes cannot
   reorder client rows or change their content/counters. Cursor resolution must
   use the same authorized filtered query; revoked/foreign/missing cursors fail
   non-enumeratingly rather than looking up a global ticket.
5. Validate the lookahead as well as returned rows: tenant/identity/grant,
   timestamps, requested filter/search, ordering, duplicates and page bound.
   Map explicit fields, never serialize a driver record. Client lists exclude
   internal IDs/clock, descriptions, draft content, notes, documents and Issue
   manifests. PM lists add only the mapped handoff context; details stay on Tickets.
6. Return exactly these counters across the entire currently authorized queue,
   independent of page size, search and selected filter:

| Audience | Counter | Rule |
| --- | --- | --- |
| Client | Open | Non-terminal tickets with current explicit access |
| Client | Needs your action | Open subset with a valid outstanding client action |
| PM | Needs PM action | Non-terminal, PM-owned recorded next action |
| PM | In progress | Recorded lifecycle is In progress |
| PM | Waiting on client | Active designated client, reply/agreement/result-review action; not hold/withdrawal |
| PM | Closed this month | Recorded accepted/answered/cancelled closure in the workspace-local month |

Counters are not additive totals. Client history includes Closed/Declined/
Cancelled without an extra metric. A decline alone is not a closed development
engagement. Month means the configured calendar year/month, including timezone,
year rollover and daylight-saving boundaries, not UTC, a browser preference,
recent private activity or a rolling 30-day interval.

Aggregate values must be safe nonnegative integers, with client action count no
larger than open count and no aggregate below matching verified page/lookahead
rows. Extra stored fields are dropped. Query/provider failure remains an error;
only successful empty scoped queries produce zero. These checks do not prove
that an adapter's SQL aggregates are correctly authorized; that remains a real
adapter/RLS acceptance obligation.

Feature-off/maintenance reads retain history and pending-action counts while
action hints are disabled. An accepted-but-not-closed delivery remains open and
requires PM closure, not another client acceptance or automatic project completion.

## Still pending

- PostgreSQL queue/detail adapters and their read-only route composition now
  exist. On cloud, they mount only with `ALPHA_TICKETING_READS_ENABLED=1`; the
  default is off. The PM Tickets page is wired to its typed API and supports
  cursor-based pagination. The PM-only queue projection also exposes the
  current client-access-active boolean so the page can avoid opening the client
  conversation before activation; this is a UI hint only and never replaces
  server-side authorization.
- Reads must be enabled only against a database where the ticket schema is
  installed. Mutation routes remain unavailable until their transactional
  stores are complete; staging-backed tenant isolation and concurrent-revocation
  checks are still required.
- The [creation checkpoint](application-creation-layer.md) subsequently implements
  signed-in request creation and recovery contracts. Public inquiry writes,
  safe entry/anti-abuse, email verification/invitation remain pending.
- Durable outstanding-action timestamps/elapsed-wait presentation, scope/document
  versions, protected file intake, work handoff, execution/review/release safeguards.
- Supabase/Auth/Storage/mail/recovery and cross-persona staging tests, deferred
  by the user's scheduling direction, not removed from the final requirements.

The test fixture lives only in the colocated test file. Its scoped filtering and
serialized service checks do not prove real SQL locking, concurrent revocation,
query plans, RLS, SMTP or durable cross-machine consistency. A production adapter
must independently prove coherent reads and fresh query-level authorization,
COUNT DISTINCT identity, workspace timezone configuration and protected cursors.
Do not connect UI-only scene controls to these business services using fake auth.

## Verification

Focused checks passed: 87 queue tests + 100 communication + 70 read + 50 command
+ 78 workflow tests (385 total). Typecheck and build passed. The final stable-source
two-worker backend regression passed: **121 files / 1,989 tests**, including all
87 queue tests. Tests exercise scoped counts vs page length,
private-note clock isolation, roles/session binding/revocation, safe lookahead,
clickable filters, exact DTO mapping, unavailable queries and calendar boundaries.
