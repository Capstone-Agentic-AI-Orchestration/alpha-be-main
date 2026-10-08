# Plan 3 — execution reservation and queue-front checks

Subsequent runtime prerequisite: `application-runner-queue-lifetime.md` records
an actual runner queue-lifetime correction. It does not enable the isolated ticket
admission service or supersede the durable authorization/release gates below.

8 October 2026. Application-first step 3 with step 4 verification. Supabase stays
last. These new services are NOT connected to existing runner entry points yet.

## Fixed application logic

A client reply or PM request for details can change `actionOwner`/`nextAction`
without changing agreed scope or work permission. The developer-context projection
previously required `developer`/`execute_work` and incorrectly denied that approved
work after ordinary conversation. It now checks actual lifecycle, agreed and
authorized scope, assignment, exact revisions and project safety instead.
Holds, withdrawal, terminal/review stages, assessed results and stale corrections
remain blocked. An explicit hold pauses work; an ordinary message does not.

## Added application service

`src/services/ticketExecutionAdmissionService.ts` and
`src/store/ticketExecutionAdmissionStore.ts` follow the existing folders.

1. Resolve current verified internal developer membership, assignment, tenant,
   exact persisted ticket binding and eligible selected agent/squad.
2. Reserve only Todo work at the current approved revision. Atomically insert one
   logical Issue claim, private audit and stable operation receipt. A squad owns
   one claim for the whole logical Issue execution, not one claim per member.
3. A queued run requires a trusted persisted worker verification reference. At
   queue front, independently recheck live authority, client access, project
   creator/safety, scope, revision, correction brief, executor and lifecycle.
4. Compare the exact reserved claim and persisted run before recording admission.
   Repeated admission reports `newlyAdmitted: false`, not permission to spawn again.
   Admission does not prove a process exists, passes tests or has completed.
5. Unknown reservation commits use the original operation lookup. Historical
   receipts can be recovered while writes are disabled, but never authorize work;
   current membership/assignment is still required to read them.

Reserved and admitted claims must both block duplicate starts, corrections,
readiness and cancellation's work-stopped check. Active uniqueness spans ALL
revisions and agent/squad owners. No local timer may expire a still-running claim
and silently authorize another agent. Missing/unavailable ticket evidence is an
error, never a fallback to legacy execution.

No client message, private PM note or contact information enters runner context:
only the approved brief and exact immutable current correction instructions.

## Required integration, not yet implemented

- Build a durable adapter sharing lock order with PM commands and revision/grant/
  binding changes. Enforce active-claim/operation uniqueness in storage, not only
  application checks. Persist run/dispatch intent and admission atomically.
- Positive `unlinked` classification is only a routing result, NOT a legacy-start
  permit. The actual legacy claim must serialize with PM binding under the same
  boundary; returning from a read transaction and then starting would reintroduce
  a binding race. Missing evidence must never be treated as unlinked.
- Wire the same gate through direct, squad, retry, queue-front and recovery paths.
  Existing runner APIs currently lack the complete verified human/claim context;
  do not invent it or use process-memory ticket stores. Squad member continuation
  must recheck its single logical claim and current scope before each turn.
- A database admission cannot recall a process after a later hold/revocation.
  Connect durable dispatcher ownership, cancellation/checkpoints and completion/
  verified-stop reconciliation. Do not equate queue admission with an exactly-once
  external process start. An uncertain admission must reconcile existing dispatch/
  process identity, never blindly respawn or leave an orphan silently running.
- Retire claims only after verified cancellation/termination/completion; preserve
  history and exact revisions. Offline ticket work must not start/retry or publish.
- Add non-production integration and production release safeguards across runner
  approval, PR merge, promotion, workflow dispatch and hosting entry points.
- Verify old-daemon/sync behavior and real tenant/concurrency/revocation in staging
  before enabling ticket-backed work. Unrelated Issues must retain current behavior.

`runnerService.ts`, `squadRunner.ts`, existing Issue APIs and `src/index.ts` were
not changed at this checkpoint. This is preparation for safe integration, not a
claim that existing runners now enforce ticket permission. No Supabase/env/desktop
changes, real email, deployment, branch, commit or push.

## Verification

- 63 execution-service tests plus 30 developer-context tests passed, including a
  real client-reply workflow transition, atomic rollback/CAS, parallel reservation/
  admission, unknown commits, scope/revision drift, revocation, stale claims,
  squad ownership, caller-fact refusal and projection allowlisting.
- Backend typecheck passed; full regression: **135 files / 2,482 tests passed**.
  The initial restricted Windows run failed on existing loopback fetches and
  temporary Git/credential fixture permission errors. The permitted full rerun
  passed, including all 63 execution-service tests against the final source.
  No application configuration was changed to bypass those environment limits.
  Test fixtures are isolated and never runtime stores.
- No frontend runtime change. Its preceding 257-test/typecheck/build/browser
  checkpoint remains evidence for that unchanged UI, not for live runner wiring.
