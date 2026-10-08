# Plan 3 — authorized detail and conversation reads

Local checkpoint: 8 October 2026. Follows the application-first sequence; no
Supabase call, migration, hosted setting, email, environment switch or deployment.
This is an implemented service/projection boundary with test-only adapters,
not an enabled API or proof of hosted authentication/database isolation.

## Structure and reuse

```text
src/
  services/
    ticketAccess.ts                 # one shared transaction authorization check
    ticketCommandService.ts         # existing commands now reuse that check
    ticketReadService.ts            # detail, public conversation, PM-only notes
    ticketReadService.test.ts       # colocated, isolated read fixture
  store/
    ticketReadStore.ts              # explicitly scoped persistence interface
  ticketing/
    readModels.ts                   # allowlisted client/PM projections
    workflow.ts                    # existing actor and lifecycle authority
  controllers/
    errorHandler.ts                # recognize safe ticket errors
    ticketReadController.ts        # PM-only explicit DTO transport; opt-in read mount
    errorHandler.test.ts
```

No separate application, framework, runner, runtime mock database or repository
integration was introduced. Client/PM UI remains in its existing feature folder.

## What now works at the service boundary

- Detail resolves current identity, session/bearer context, membership/grant and
  ticket access before loading content. Unauthorized input cannot reveal record
  existence through pagination or schema errors.
- Client output includes only reference, original request, safe company label,
  status/version, public timestamps, requested action, authorized related-ticket
  reference and deliberately shared scope/project/result summaries.
- Internal project/Issue IDs, PM identities, pinned asset/revision IDs, notes,
  internal update clocks and arbitrary extra row fields are excluded from client
  responses. No raw repository record, storage URL or made-up preview URL appears.
- A project display name requires deliberate publication. A linked ticket needs
  its own matching client identity and current active grant; a stored relation
  alone does not make it visible. Inconsistent tenant/reference rows fail closed.
- Scope agreement displays the exact current immutable published version. Shared
  delivery evidence must match the current pinned scope/asset/revision manifest.
  An assessed but unshared result does not appear in the client view.
- PM detail adds explicitly mapped private work context, scope draft and delivery
  assessment metadata, including the internal developer brief, so PM can inspect
  it on Tickets. The store must omit that private row entirely for client actors;
  the client projection rejects an adapter that supplies it. Direct projection
  calls cannot use a client actor to obtain PM internals.
- Public replies use the same conversation read for PM/client. Private notes use
  a separate PM-only method and query audience. Historic PM replies remain useful
  without disclosing the internal member's ID to a client.
- Conversation pages are bounded (default 50, maximum 100), ordered by timestamp
  then binary/C ID, oldest-first. `after` resolves only in the authorized ticket
  and audience. Validate the lookahead as well as visible rows, so a foreign or
  private message cannot leak through a next-page cursor. The PM controller
  parses only single-valued numeric `limit` and scalar `after` fields; it does
  not forward arbitrary query objects.
- Terminal history and feature-off reads stay available to authorized users.
  Write availability/requested-action hints do not replace fresh command checks.
  Acceptance is displayed separately from ticket closure and project completion.
- Ticket workflow errors retain safe 400/403/404/409/503 status/code responses.
  Inconsistent view rows return a generic 500 without logging their contents.
  Other existing API behavior remains unchanged.

Private-note persistence must retain a separate internal update clock and must
not advance the client-visible update or shared workflow version merely because
a note changed. These read projections enforce separation of the clocks; actual
note writes are now implemented at the unmounted service boundary in the
[communication checkpoint](application-communication-layer.md). Its tests reuse
these projections to verify private-note writes leave client output unchanged.

## Deferred obligations and honest limits

- PM queue/detail/conversation/note reads now have concrete PostgreSQL adapters
  and a read-only route composition in the established controller folder. The
  cloud mounts it only when `ALPHA_TICKETING_READS_ENABLED=1`; the default is
  off. Desktop requests use the existing cloud relay and never construct a
  local ticket database. No real client login exists through this internal
  PM route.
- Replies and notes remain unavailable in the mounted read-only composition
  until durable write transactions are complete. Public intake, production
  invitation activation and new ticket creation remain unmounted; application-
  level contracts do not make them operational.
- The subsequent [queue checkpoint](application-queue-layer.md) implements list,
  filter and PM-four/client-two aggregate contracts in one authorized snapshot.
  The SQL adapter is now present, but staging-backed tenant, cursor and
  concurrent-revocation acceptance remains pending; never infer a count from
  one page.
- Scope/delivery history, private document versions, scanning, downloads and real
  preview delivery remain separate required integrations. Missing implementations
  are not represented as fake empty collections or successful downloads.
- Staging-backed acceptance must prove coherent snapshots, concurrent
  revocation behavior, query-level tenant/audience filtering, cursor scoping
  and identity binding.
  Read authorization/metadata/evidence must follow compatible lock/check order.
  The local fixture does not prove SQL locks, RLS or hosted persistence.
- Client API must still use its independent authentication/CSRF/error boundary
  before the existing internal chain and prevent fallthrough. Do not expose a
  router with fake identity or add a blanket public prefix to existing middleware.
- Real database/provider/transport failures must remain safely wrapped. The new
  rule-error handling is not proof that every future adapter error is redacted.

The PM read and queue transport boundaries were mounted on 8 October 2026 as an
opt-in, read-only cloud slice, after the existing internal session/workspace
middleware. The default remains disabled. Their explicit response mapping and
query validation do not prove hosted authorization or that the target database
has the ticket schema. Backend typechecks passed; no tests were run for the
mounting change.

## Verification

Focused verification passed: 70 read-service tests, 50 command-service tests,
78 workflow tests and 12 error-handler tests (210 total). Tests cover safe field
mapping, unpublished PM content, direct projection misuse, grant/role revocation,
wrong tenants, private cursors, hidden lookahead, bounds/order, read-only history,
feature-off reads, no private timestamp/count leakage and safe error handling.

Initial typecheck caught a union narrowing issue in the new test fixture; it was
corrected without changing runtime authentication. Final typecheck/build passed.
The fresh stable-source two-worker backend regression passed: **119 files /
1,802 tests**, including the final 70 read-service tests and 12 error-handler
tests. One preceding full run overlapped the final PM-detail edits and failed
three new expectations; the final unchanged-source run passed all three and the
entire suite. Read/service/test/error-handler source hashes were unchanged across
the final full run. Repository whitespace checks passed. No environment,
lockfile, historical migration or desktop-source changes were made.

Next after the communication/queue checkpoints: authorized create contracts, then
client/internal API and cloud/desktop transport with production identity still
gated. Keep the full Plan 3 persistence/Auth/files/email/execution/review/recovery
and real cross-persona staging acceptance requirements; do not call this release
ready based on local read tests.
