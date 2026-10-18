# Phase 7–9 execution plan

Status: implementation complete locally on `feat/ticket-lifecycle-phases-7-9`;
ready for end-to-end acceptance testing, not yet pushed or deployed. The additive
workflow schema has been applied to the active Supabase project. Application
write gates remain disabled, and Render has not been changed. Focused Phase 7–9
checks are green. The full backend suite passes 2,705/2,717 tests; the remaining
12 are in the untouched board-route suite. Those tests pass on the pre-merge
`31b21fc` checkout; current main adds PR #89 persistence/model changes, so this
appears to be a separate main-branch regression to triage before release. The
two staging-baseline failures were caused by CRLF checkout differences; the
test now normalizes SQL line endings and passes 8/8.

## Operating model

- One client request remains one ticket and one client-facing conversation.
- A PM may link an agreed ticket scope to an existing project in that PM's
  workspace and select the Issues that implement that scope.
- Ticket-linked Issues are not owned by a named developer. The PM assigns access
  at the workspace/project level; any active developer authorized for that
  project may claim an eligible Issue. One atomic active claim prevents duplicate
  concurrent work. Unlinked, ordinary Issues keep their current assignment flow.
- Client approval applies to the exact proposed scope. A client sees only a
  deliberately shared result preview, never the internal project, Issues, PM
  notes, runner, or private work conversation.
- “New Request” is explicitly out of scope.

The core evidence chain is:

`ticket → agreed scope version → workspace project → exact Issue/revision manifest → one active execution claim → passed internal reviews → immutable shared result → client decision → PM closure`

## Phase 7 — authorize ticket work against an existing project

**Goal:** make the agreed ticket scope actionable without creating a parallel
project or Issue system.

1. PM reviews the ticket and proposes a versioned client-safe scope plus a
   separate private developer brief. Client agreement applies only to that exact
   scope version.
2. PM selects an existing project in the PM's workspace and the existing Issues
   that cover the agreed work. The PM confirms the manifest; the server reloads
   the current project, Issue IDs, revisions, statuses, scope and workspace.
3. In one transaction, the server checks PM authority, client access, project
   workspace/safety, exact scope agreement, Issue eligibility, no prior ticket
   binding, and no queued/running work. It saves the immutable ticket-to-project
   and ticket-to-Issue/revision links, audit, operation receipt and ticket state
   together. No Issue is assigned to an individual developer and no runner starts.

**Acceptance gate:** tenant-bound authorization, idempotent replay, stale-version
and concurrent-link tests, rollback on any failure, and confirmation that the
existing project/Issues and ordinary unlinked workflows remain unchanged.

## Phase 8 — project-authorized execution and internal review

**Goal:** let any project-authorized developer perform the linked work safely,
with no per-Issue named-assignee bottleneck.

1. The developer view exposes only the ticket's approved brief, current revision,
   linked project/Issue context and any PM correction brief. It excludes client
   contact, the full conversation, PM notes and unpublished results.
2. Every execution entry point—direct start, retry, agent or squad, queue-front
   admission and desktop/cloud sync—must use the same fresh workspace/project
   access check and lock order. A single durable `(workspace, Issue)` claim
   serializes competing developers, agents, retries and squads.
3. Revoked access, stale scope/revision, hold/withdrawal, unsafe project, active
   or ambiguous run, or failed review blocks admission. A success-looking
   response is not proof that a process started or finished; reconcile ambiguous
   outcomes before retrying.
4. Trusted completion evidence for the complete authorized manifest enters
   internal review. Only all required passed reviews move the ticket to PM result
   assessment; this does not share anything with the client.

**Acceptance gate:** race tests for competing claims and revocation, negative
tests at every execution entry point, durable lock/claim and crash-recovery tests,
trusted completion provenance, complete-manifest review tests, and regression of
legacy unlinked Issue assignment and runner behavior.

## Phase 9 — PM result review, limited client preview and closure

**Goal:** share only an explicitly approved result and finish the ticket through
clear PM/client decisions.

1. PM inspects the exact immutable result pinned to the current Issue revisions
   and passed reviews. PM assessment and publication remain separate actions.
2. The client sees a preview only after the PM shares it. On that exact result,
   the client may accept it or request changes. A request does not close the
   ticket or silently expand the agreed scope.
3. PM triages feedback. For a correction, PM selects only affected linked Issues
   and writes private instructions. The server appends a new immutable revision,
   preserves old evidence, clears only the current result pointer, and makes the
   corrected work claimable by any developer with project access.
4. Corrected work repeats Phase 8 review and Phase 9 assessment/share. Only after
   client acceptance does the PM explicitly close the ticket. Closing a ticket
   does not imply project completion, release or deployment.

**Acceptance gate:** authorization and object-store isolation tests, immutable
manifest/hash and fresh scan-generation checks, no client visibility before PM
share, no leakage of private correction content, targeted correction/idempotency
tests, and separate client-acceptance/PM-closure tests.

## Delivery sequence and rollout

1. Freeze the contract and threat model above; verify the current six phases and
   ordinary Issue/project workflows as the regression baseline.
2. Add/version only the durable schema needed for ticket links, claims, audit,
   operation receipts, review evidence and immutable delivery registration.
   Keep migrations additive and test upgrade/rollback against a disposable DB.
3. Implement transaction adapters and authorization first. Exercise cross-tenant,
   stale revision, concurrent claim, rollback and ambiguous-commit behavior before
   exposing routes.
4. Mount APIs behind disabled-by-default server gates. Add integration tests for
   every direct/retry/queue/squad path; do not bypass the current runner/release
   safeguards.
5. Wire the existing PM Tickets and client portal screens to those APIs. Roll out
   read-only first, then PM authorization, developer claim/review, and finally
   result preview/closure, with an observable kill switch at each boundary.
6. Enable live modes only after production-equivalent integration, security,
   regression and recovery checks pass. The Supabase schema is present, but this
   local application branch is not deployed and no Render setting or feature
   gate has been changed.

## Implementation checkpoint (2026-10-18)

- **Phase 7:** linked ticket scope, project and Issue/revision authorization,
  idempotent transactional binding, PM APIs and audit receipts are implemented.
- **Phase 8:** direct, retry, queue, squad and desktop/cloud execution paths use
  fresh project membership plus a durable single-active-claim admission gate;
  completion evidence and internal review are wired.
- **Phase 9:** PM result assessment, share registration, client accept/request
  changes, PM corrections, immutable result evidence and explicit PM closure are
  implemented. Client-visible results remain PM-share gated.
- **UI:** the current landing route now uses Pineapple's already-merged public
  shell and styling while retaining the current inquiry form, password sign-in,
  client portal and team sign-in routes. PM and client ticket screens expose the
  lifecycle actions; “New Request” remains out of scope/disabled.
- **Schema:** `ticket_workflow_execution_delivery` is applied in Supabase. A
  follow-up migration adds child-side indexes for the three new composite
  foreign keys identified by Supabase's performance advisor. No existing ticket
  rows are transformed.
- **Remaining before release:** manually exercise the real PM → developer →
  internal review → PM share → client decision → PM closure flow in a
  production-equivalent environment, verify runner and object-storage behavior,
  and separately fix or formally waive the 12 board-route failures on current
  main. Keep Render and all server feature flags unchanged until then.

## UI/UX refinement within the existing workflow

- **PM Tickets:** make the next action explicit in queue rows and details; group
  by client/project without merging distinct ticket conversations; separate
  “New inquiries” from accepted tickets; make workspace/project context visible;
  keep status, owner and actions textual rather than color-only.
- **Client portal:** show a short ticket timeline and plain-language current
  status/next step; keep each ticket conversation separate; make the shared
  project preview clearly read-only and explain what the PM has and has not
  shared; use clear success/error feedback that preserves form input.
- **Accessibility:** preserve keyboard operation and visible focus, use labeled
  controls and inline plus summary validation, and make targets comfortably
  tappable. This is refinement of the existing Tickets and portal pages, not a
  new request workflow or a replacement app.

These choices follow established queue triage patterns, plain-language form
validation, and WCAG guidance: [Atlassian service queues](https://support.atlassian.com/customer-service-management/docs/about-queues/),
[GOV.UK validation pattern](https://design-system.service.gov.uk/patterns/validation/),
[GOV.UK error summary](https://design-system.service.gov.uk/components/error-summary/),
[WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum),
and [WCAG focus appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance).
