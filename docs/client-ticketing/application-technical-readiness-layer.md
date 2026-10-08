# Plan 3 — technical completion to PM assessment

8 October 2026. Application-first step 3, verified alongside step 4. This is a
local application service, not a mounted API or live runner integration.

## Purpose and implementation

`src/services/ticketTechnicalReadinessService.ts` records the existing pure
`technical_work_ready` decision through the transaction contract in
`src/store/ticketTechnicalReadinessStore.ts`. Both follow existing folder patterns.

1. A future existing-run completion integration supplies a server-verified
   execution-completion reference, not a browser-supplied run ID or identity.
2. The store rechecks that persisted authority and exact workspace/ticket/run/
   completion/Issue/revision binding before parsing or returning an operation.
3. A new decision independently loads the whole current approved Issue manifest,
   required technical reviews and all active queued/reserved/running claims.
   The triggering revision must still be current. Partial completion, failed
   reviews, stale revisions, inactive client access, hold/cancellation or pending
   withdrawal cannot mark the work ready.
4. Readiness advances the ticket version and assigns PM assessment. Workflow,
   exact private ready-manifest evidence, audit, change signal and operation
   outcome commit together or all roll back. No result is assessed or shared.
5. Stable operation lookup recovers an uncertain commit without a second write.
   Recovery still needs current verified authority; it can return the original
   outcome after later ticket changes and while new writes are disabled.

Ready-manifest identity includes tenant/ticket/project/scope and sorted exact
Issue/revision pairs. It prevents a second late completion from repeating the
same readiness notification, even when conversation has since changed the next
action. A separately authorized correction creates a new revision manifest and
can become ready again after fresh review. Operation keys have a separate
execution namespace, never the PM/client command-recovery namespace.

## Durable integration obligations

- Resolve the verification reference only from a trusted persisted completion
  boundary and current principal authority. There is no public endpoint for
  minting or accepting it. A TypeScript type or `authorized` flag alone is not
  evidence of a real completed run.
- Serialize membership/grant, ticket, revision, review and execution-claim
  changes with the same lock order used by commands and future runner gates.
  A ticket lock alone cannot protect independently mutable evidence.
- Enforce insert-only operation uniqueness and exact-manifest uniqueness using
  full canonical ownership/revisions, not an unchecked hash alone. No upsert,
  network/provider I/O in a transaction, or automatic ambiguous-commit retry.
- Retain/reconcile verified completion events when prerequisites are not yet
  satisfied. A partial-manifest refusal is not permission to fabricate reviews,
  discard later completion events or notify clients early. The real event
  dispatcher, durable scheduling and retry classification remain to be implemented.
- Persisted historical completion authority may recover an old receipt; new
  readiness independently requires current revisions/reviews. Revoked authority
  must not recover data. Test real concurrency and revocation in staging.

The service is not imported by `index.ts`, controllers, `runnerService.ts` or
`squadRunner.ts`. No existing runner behavior, Issue status, assignment, project,
GitHub login, desktop transport or deployment path was changed. It does not
register a deliverable, start/restart work, send email, expose client files,
close a ticket or release software. Durable adapters and the actual existing-run
integration remain deferred; process-memory fixtures must never become runtime stores.

## Verification

- 51 new service tests: complete/partial manifests, exact revisions, failed review,
  active runs, tenant/authority refusal, caller-fact rejection, defaults disabled,
  rollback/CAS, concurrent replay, unknown-COMMIT recovery, late-event manifest
  deduplication, correction readiness and response allowlisting.
- Backend full regression: **131 files / 2,330 tests passed**; typecheck passed.
- No frontend runtime changes this checkpoint. Previous frontend baseline remains
  20 files / 246 tests with passing typecheck/build; it was not rerun here.
- No Supabase/env/desktop changes, real invitations/email, deployment, branch,
  commit or push. Local tests do not prove hosted authentication or distributed locks.

The subsequent `application-delivery-registration-assessment.md` checkpoint adds
application-only immutable registration and PM assessment. Live artifact sources
and execution/release safeguards remain open. Persistence, provider identity, private
storage/scanning, email and full cross-persona staging acceptance remain required
before enabling ticketing. The twelve-phase plan is not complete.
