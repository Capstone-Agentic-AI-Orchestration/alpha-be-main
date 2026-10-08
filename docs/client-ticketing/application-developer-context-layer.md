# Plan 3 — developer work-context boundary

Local application checkpoint: 8 October 2026. Files follow the backend's
existing ticketing domain, service, store, and documentation folders.

```text
src/ticketing/developerContext.ts                  # minimal safe projection and gate checks
src/services/ticketDeveloperContextService.ts      # assignment-scoped read service
src/store/ticketDeveloperContextStore.ts           # fresh read-snapshot contract
src/controllers/ticketDeveloperContextController.ts # no-store assigned-work route
src/controllers/ticketDeveloperContextRouteFactory.ts # injected route composition
docs/client-ticketing/application-developer-context-layer.md
```

The developer does not receive the client's whole ticket or conversation. The
service only projects a ticket reference/version, assigned Issue and revision,
approved scope version, the developer brief, and (for a corrected revision) the
PM's explicit current correction instructions and timestamp. It requires a fresh internal
identity, active workspace membership, exact active human assignment, matching
project/ticket/scope links, client-agreed and PM-authorized scope, an eligible
Issue status, and a project execution path currently marked non-production-safe.
No client email, public conversation, private PM note, unrelated Issue, or
unpublished delivery data appears in the DTO.

The snapshot includes the immutable initial revision ID and an exact correction
record when the current revision differs. Missing/mismatched/foreign/mutable
correction records fail closed. Original agreed scope remains separate from the
correction instructions. A pending client withdrawal also prevents work context.
See [review and correction lifecycle](application-review-corrections.md).

Reading the brief is not permission to run. The run start and retry paths must
independently enforce current ticket authority and release safety in their own
transaction; otherwise a cached/stale context could become a launch bypass.
The store interface requires a coherent fresh snapshot and does not authorize a
request from a body field or a UI role selector.

The new route contract is `GET /api/tickets/developer/issues/:issueId/work-context`
when mounted. It requires the existing `issue.read` capability and server-owned
internal session/bearer identity, then asks the store for the exact assigned
Issue. It returns an explicit no-store DTO and never starts or retries work.
Desktop requests use the existing cloud relay; local SQLite is not a ticket
authority.

The route factory is still unmounted. There is no runtime store, database adapter,
execution hook or desktop UI connection yet. The existing `Issue` model also
does not persist the ticket/scope/revision binding, so this read path cannot be
made live until the later atomic persistence and run-gate phase. Supabase work
remains deferred.
