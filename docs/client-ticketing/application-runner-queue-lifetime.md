# Plan 3 — existing runner workspace-lifetime correction

8 October 2026. Application-first step 3 / regression step 4. This corrects an
existing runtime prerequisite found while preparing ticket-backed execution;
it is not the finished ticket/cloud runner integration.

## Defect and correction

`WorkspaceQueue` correctly serialized its promise callbacks, but
`RunnerService.executeTask` returned immediately after registering process
listeners. Its queued promise therefore settled while the agent was still
editing. The next run could switch the same checkout underneath that process.
Previous queue-only tests did not cover this actual runner/process boundary.

The actual runner now awaits its child exit callback AND the existing verification,
diff, commit and PR review preparation before releasing the checkout. A callback
failure rejects the queued task and is recorded through the existing failure
handler. Different checkout keys still run concurrently. Sequential squad members
can enqueue their next turn without awaiting that new turn inside the old one.

Cancellation is freshly checked immediately before spawn, since it may arrive
during asynchronous branch preparation. Cancellation of a live process does not
release checkout ownership until the child exits. A failed/otherwise terminal run
after verification cannot be overwritten with successful review preparation.

A missing CLI can emit `error` with no PID and never emit `exit`. ProcessManager
now clears its timers/active entry and calls completion exactly once as
`spawn_error`. A later exit cannot duplicate the callback. An error on a live PID
is NOT evidence of termination and does not release ownership prematurely.

## Scope and boundaries

- Runtime changes: `src/services/runnerService.ts`, `processManager.ts`,
  `runLifecycle.ts`; colocated tests follow existing folder conventions.
- No new queue, ticket engine, task model, PM page, permission override or UI action.
- Actual `RunnerService` and actual `WorkspaceQueue` are exercised together;
  process, provider, Git and persistence effects in the new test are isolated doubles.
- This correction is active for locally built backend runners, not an installed
  desktop executable until its backend is rebuilt/bundled normally. No process or
  installed app was restarted and no real agent run was launched for verification.
- New ticket reservation/admission services still lack durable adapters and
  runner wiring. Shared authorization, old-daemon/sync, release, real cancellation/
  reconciliation, client identity/storage/mail and staging gates remain open.
- No Supabase, env, desktop source, actual invitation/email, deployment, branch,
  commit or push changes at this checkpoint.

## Verification

- Focused actual-runner/queue/cancellation/process/exit classification: five files,
  **31 tests passed**, including 13 new runner-lifetime tests.
- Coverage includes same-checkout serialization, different-checkout parallelism,
  verification/review waiting, spawn/exit/finalization failure, queued/live/pre-spawn
  cancellation, terminal-state preservation and an actual sequential squad advance.
- Backend typecheck passed; full regression: **136 files / 2,498 tests passed**.
  The full suite ran with permission for its isolated loopback/temp-file fixtures,
  using the existing cleared-credential test configuration. Whitespace checks passed.
- Local test doubles do not prove real provider behavior, distributed ticket
  authorization, process-tree shutdown or production release safety.
