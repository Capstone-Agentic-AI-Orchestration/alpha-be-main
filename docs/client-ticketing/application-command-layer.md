# Plan 3 — local application command layer

Checkpoint: 8 October 2026. Supabase integration remains deferred by user direction.
This implements a reusable service boundary, not a working hosted ticket API.

## Existing structure followed

```text
src/
  ticketing/
    workflow.ts                    # one source for lifecycle decisions
    workflow.test.ts
  services/
    ticketCommandService.ts        # authorization, retries, atomic command handling
    ticketCommandService.test.ts   # test-only transactional fixture, colocated
    ticketAccess.ts                # shared authorization used by reads and commands
  store/
    ticketCommandStore.ts          # persistence interface, no runtime database
    transactionOutcome.ts          # provider-neutral uncertain-commit contract
    database.ts                    # existing single-connection transaction support
docs/client-ticketing/
  application-command-layer.md
```

The command service does not import application environment, provider clients,
SQLite, GitHub, the runner or mail services. Invitation, activation and public
intake services recognize uncertain commits through the neutral transaction
outcome contract, not by loading the concrete database module. No controller or
startup module mounts the command service. Do not create a separate ticketing
app, runner or desktop ticket authority.

## Implemented behavior

1. Start one store transaction and load the scoped ticket with fresh identity
   binding, membership/grant, permission and server-owned feature gate. Clients
   require their dedicated persisted session. Internal callers retain the existing
   GitHub web-session or verified desktop-bearer path; request verification is
   resolved from trusted server context, never caller-supplied role/identity fields.
2. Refuse unauthorized access before parsing or revealing saved operation details.
3. Strictly validate the existing workflow command envelope. Actor, facts, status
   and feature mode cannot be supplied in that envelope.
4. Look up a durable operation scoped by workspace, ticket, actor kind, actor ID
   and operation ID, shared across commands, replies and private notes. Category
   and validated content are fingerprinted. Identical content returns its original receipt;
   changed content under that ID fails with a conflict. Object property order and
   validated reason whitespace do not change content identity. Array order does.
5. For a new operation, load authoritative evidence and use the existing workflow
   rules. First-time work authorization accepts only freshly read Issues in
   `backlog` or `todo`; already-started, review, and done Issues are refused.
   Initial authorization inserts immutable private links to the existing Issues
   through `insertWorkBindings`, in the same transaction as the decision. Each
   link pins workspace, ticket, project, agreed scope, revision and authorizing PM.
   Compare-and-swap the expected ticket version and reopen only explicitly
   affected existing Issues when the decision requires it.
   Corrections append a fresh server-generated revision and the PM's explicit
   developer instructions with the reopen. Only review/done affected Issues
   without active work can be returned; already queued/running work is not reset.
6. Save private decision audit, a minimal durable change signal and the original
   outcome in the same transaction. Any failed step rolls back all of them.
7. Return only ticket ID, operation ID, version and status. Internal project,
   Issue, note, actor and asset information is excluded from the receipt.

Replay returns the original operation outcome, **not the current ticket detail**.
The UI will refetch authorized current detail after a command/reconciliation.
Saved decisions still require current access. Reconciliation lookup is allowed
when writes are disabled; executing/replaying a command obeys the current write
gate. Maintenance permits only the existing safe PM cancellation decision.
No automatic retry follows an unknown COMMIT outcome. The caller must retain its
operation ID and reconcile, not mint another ID and repeat external work.

Agreement, PM authorization, technical review, PM assessment/sharing, client
acceptance and closure remain separate. Neither closure nor the change signal
completes a project, authorizes a release, sends email or starts execution.

## Required adapter obligations — not yet implemented

- **Existing Project/Issue integration is a hard gate, not a UI detail.** The
  current `Issue` model and `IssueStore` do not persist a ticket, approved scope
  version, or execution revision link, and the existing Project/Issue CRUD
  stores do not provide one transaction spanning those records and ticket
  authorization. Do not infer this relationship from labels, comments, or
  descriptions; do not create a second task system or authorize after a series
  of independent writes. The future adapter must bind the existing project and
  Issues to the ticket, preserve the existing agent/squad assignment and run
  lifecycle, and commit the binding plus authorization evidence atomically.
  The application service now explicitly inserts these links: `loadFacts`
  prepares locked candidates for first-time authorization and `insertWorkBindings`
  persists only that exact validated manifest. The adapter must enforce unique
  `(workspaceId, issueId)` ownership across tickets, insert-only records and full
  rollback; no upsert, partial insert, reassignment or inferred text linkage.
  This transaction interface is not yet a durable implementation.
  Load each Issue's current status as trusted evidence; initial authorization
  requires `backlog`/`todo`. The adapter must also check active runs under the
  same serialization boundary and set `hasActiveRun` from authoritative run
  state. The runner's start/retry paths must still enforce the ticket gate too;
  this preflight fact alone cannot close a concurrent-start race.
  Until that adapter and the execution-path checks exist, keep `authorize_work`
  unavailable in the running system and do not enable ticket-backed runs,
  retries, squad runs, approvals, merges, or dispatches.
- One actual database connection/transaction for every callback; full rollback,
  insert-only operation uniqueness and compare-and-swap under concurrency.
- Explicit predicates on every workspace/ticket/identity query, even using a
  privileged connection. Lock/check a persisted session's exact identity binding
  where applicable and current grant/membership, not merely an unexpired provider
  token. Verify internal desktop bearers through existing internal authentication
  before entering the transaction; no GitHub network calls inside the transaction.
  Do not require a new persisted session for the current stateless desktop flow.
- Consistent ticket/authorization/gate/evidence lock order or equivalent
  serializable checks. Concurrent revocation and Issue revision edits must not
  race the decision. A ticket row lock alone does not prove this.
- Immutable scope/message/delivery evidence, full required-Issue manifest, exact
  revisions and active affected assignees. Preserve superseded history.
- Apply targeted Issue changes through compatible existing execution safeguards;
  append exact `TicketIssueCorrection` records and atomically CAS each previous
  revision to its new current revision, resetting only its pending review state.
  Preserve initial links and immutable old review/delivery history. Current work
  context must load the correction brief and revision pointer together.
  do not launch/restart runners in the database transaction. Existing runners,
  legacy approval paths and repository release gates are still an integration task.
- Durable private audit with restricted access and approved retention. Do not
  serialize audit reasons, command bodies or facts into general application logs
  or public conversations. Database timestamps/clock authority are server-owned.
- A deferred outbox worker must recheck authorized recipients and resolve the
  client-safe projection. The signal contains no email address/message body and
  is not a public broadcast channel or deployment instruction.
- Retain operation outcomes long enough for safe reconciliation; do not prune
  them in a way that silently makes an old operation ID executable again.

No production adapter, migration, hosted call, email, invitation, environment
switch or deployment is included in this checkpoint. The serialized in-memory
adapter exists only inside the test file, never in runtime application state.
Its concurrency tests prove service behavior under that adapter, **not** real
Postgres locking, RLS, SMTP, Auth or durable cross-machine persistence.

## Verification and next integration

Focused command/workflow tests cover retries, version conflicts, identity and
tenant boundaries, permission revocation, unknown commit reconciliation,
write gates, full lifecycle, private-message refusal, targeted corrections and
rollback at every mutation boundary. Typecheck/build and full backend regression
are required before handing off the checkpoint.

Verification on 8 October:

- Full two-worker backend regression: 118 files / 1,723 tests passed. That run
  collected the command-service file with 48 tests.
- Latest focused run after adding two desktop-bearer compatibility cases:
  50 command-service + 78 workflow tests passed (128 total).
- Typecheck and build both passed after the identity-contract refinement.
- The default-concurrency full run timed out in three existing API/database
  files (project binding, team board, baseline rehearsal); all three passed in
  the bounded run without changing timeout limits or production behavior.
- The initial sandboxed focused run was blocked by Vitest dependency realpath
  permissions; approved local runs passed. No hosted connection was used.

The compatibility refinement preserves the existing stateless desktop GitHub
bearer path while requiring a separate persisted client session. It changes the
store's TypeScript identity contract and test fixture, not existing login code.
No API/controller/startup import mounts the new service. Repository whitespace
checks passed; environment/lockfiles/historical migrations/desktop are unchanged.

Commands:

```text
npx vitest run src/services/ticketCommandService.test.ts src/ticketing/workflow.test.ts --silent
npm test -- --maxWorkers 2 --silent
npm run typecheck
npm run build
```

Latest domain checkpoint: `TicketIssueEvidence` now carries current Issue status
and whether the authoritative run store reports an active run. Initial
authorization rejects `in_progress`, `agent_running`, `review`, `done`, or an
active run; it accepts only unstarted `backlog`/`todo` Issues. The regression
suite preserves completed-issue delivery review/correction behavior. The runner
start/retry gate and durable binding adapter remain mandatory before enabling the command.

Latest application handoff checkpoint: initial Issue links now participate in
the command transaction rather than being an unspecified separate write. Tests
cover rollback after link insertion/CAS/audit/outbox/outcome failure, conflicting
ownership (including a conflict after the first tentative insert), concurrent
duplicates, invalid evidence and unknown-COMMIT reconciliation. These tests use
only the serialized test fixture; they do not prove distributed DB/runner locking.

Follow-up: the [authorized read layer](application-read-layer.md) now implements
safe detail/public conversation/PM-note reads and shares `ticketAccess.ts` with
commands. Ticket-specific API errors are recognized, but no ticket router or
production store is mounted. The subsequent
[communication checkpoint](application-communication-layer.md) adds atomic
message/note services and unified operation lookup; it also remains unmounted.
The subsequent [queue checkpoint](application-queue-layer.md) adds authorized
list/counter contracts, and the [creation checkpoint](application-creation-layer.md)
adds signed-in request creation and pre-ticket operation recovery, still unmounted.
Shared lookup can return a mapped message ID or creation reference where applicable;
ordinary command execution still returns only its four receipt fields.
Next: public intake, narrow client/internal API contracts, technical-readiness
integration and cloud/desktop fail-closed transport. Do not connect the UI-only
scene selector to production commands or expose these services using fake auth.
Real persistence, client Auth/grants, private file intake/scanning, mail delivery,
recovery and cross-persona staging tests remain mandatory deferred gates.
