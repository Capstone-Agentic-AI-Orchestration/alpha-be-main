# Plan 3 — PM work handoff checkpoint

Application-only changes; Supabase/Auth/mail/storage integration stays last.

## Existing folders and authority

- Backend: `src/services/ticketCommandService.ts`, `src/store/ticketCommandStore.ts`,
  existing `src/ticketing/workflow.ts`, colocated tests.
- Frontend: `src/features/ticketing/PmWorkHandoffForm.tsx`, `pmWorkHandoff.ts`,
  colocated tests, and the existing `PmTicketsView.tsx`/`pmApi.ts`.
- No new app, task engine, repository catalogue or runner. No existing Project,
  Issue, assignment, login or execution API is replaced.

## PM journey on the one Tickets page

1. Review the request and propose scope. The client agrees to that exact version.
2. Select **Link agreed work** within ticket detail.
3. Choose an existing project in the PM's workspace and its unstarted Issues.
   Ticket-linked Issues are not assigned to a named developer: any active
   developer with access to that project may claim the work. Missing projects/Issues still use the existing creation screens;
   return and refresh the selector. Draft work is not yet an authorized handoff.
4. Confirm the selected Issues cover the agreed scope; authorize once.
5. The backend rechecks current access, scope, project ownership/safety, Issue
   status, workspace/project developer access, bindings, active runs and exact revisions. Client-provided
   selection IDs do not prove permission or eligibility.
6. Private Issue links, ticket transition, audit, change signal and saved operation
   commit together. Any failure rolls them all back. A lost response keeps the
   same operation ID for reconciliation/retry.

Authorization does not start agents, change existing Issue statuses/assignments,
give clients internal project access, deliver results, or complete a project.
The frontend preflight is usability only, not authorization. Suggested next-action
labels are not an extra lifecycle gate: a client follow-up must not erase the PM's
ability to authorize a still-agreed scope.

## Remaining runtime gates

The subsequent `application-execution-admission.md` checkpoint adds an isolated
reservation/queue-front service and fixes conversation-related context refusal.
It does not wire the real runners or replace the durable integration gates below.

Ticket API factories remain unmounted. No real ticket can be handed off yet.
The deferred durable adapter must implement candidate loading, insert-only unique
Issue ownership and atomic writes on one authoritative transaction. All runner
entry paths need the same durable execution gate/claim; a read-then-start check
does not prevent races. Agent/squad/retry/approval/merge/dispatch coverage and
cross-persona staging tests remain mandatory before enabling ticket-backed work.

The optional FE `scripts/test-ticketing-pm-handoff.mjs` renders the real PM view
with transport fixtures intercepted only in its loopback browser test. It blocks
all real API and external network calls. No seeded records enter runtime code.

## Verification — 8 October 2026

- Backend full regression: 127 files / 2,150 tests passed.
- Frontend full regression: 15 files / 145 tests passed; focused handoff/transport
  rerun after eligibility refinement: 34 tests passed.
- Backend/frontend typechecks passed; frontend production build passed (existing
  large-chunk advisory remains).
- Isolated real-view browser rehearsal passed project-change selection reset,
  exclusion of started/unassigned Issues, acknowledgement, mobile overflow check,
  uncertain-outcome editing lock and same-operation recovery, with zero actual
  API calls and zero page errors. Desktop screenshot was visually inspected.
- Windows sandbox restrictions initially blocked build realpath/loopback access;
  checks passed outside the sandbox without production configuration changes.

These results verify local application behavior, not hosted Supabase, provider
login/email, durable concurrency, or real agent execution. No remote writes,
new branch, commit, push, env change or deployment was performed in this checkpoint.
