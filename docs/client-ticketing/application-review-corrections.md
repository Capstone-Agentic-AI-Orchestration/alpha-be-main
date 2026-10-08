# Plan 3 — review and targeted corrections

Application-only checkpoint, 8 October 2026. Existing feature/service/store/domain
folders are retained. Ticket routes are still unmounted; Supabase integration stays last.

## Lifecycle

1. An assigned developer finishes the existing Issues and technical checks.
2. PM reviews the work. If it needs fixing, **Return affected Issues** on Tickets
   selects only the reviewed/completed Issues and requires a developer brief.
3. The server rechecks the exact authorized manifest, active affected assignees,
   current revisions, and absence of queued/running work. An Issue already queued
   for its correction cannot be repeatedly reset under fresh operation IDs.
4. A correction atomically appends an immutable private brief/new revision,
   compares the previous revision, reopens only selected Issues as Todo with
   fresh review requirements, clears the current delivery pointer and records
   the audit/outbox/operation outcome. Initial work links, prior reviews and
   deliveries are preserved; unrelated Issues are unchanged.
5. The assigned developer's work-context projection includes the original agreed
   scope plus the current revision's PM instructions. It never copies the whole
   client thread or PM notes. A missing, foreign or stale correction brief fails
   closed, and unresolved client withdrawal blocks the context.
6. After corrected work passes fresh review, PM must assess/share a new pinned
   result. Client feedback on that exact result goes through the same targeted
   PM correction flow; extra scope remains a linked new ticket.
7. Only an explicitly accepted current result offers **Close accepted ticket**.
   PM confirms closure; history becomes read-only. No project completion or
   release/deployment is inferred.

The UI has no new PM page or metrics. Corrections and closure are inline on
Tickets. New PM/client decision controls do not directly start or restart agents.

## Application contracts refined

- `authorize_correction` now requires `reason`, as `request_fixes` already did.
  It is the PM's explicit internal developer instruction, not a public reply.
  These new ticket endpoints are not deployed, so no existing Issue/login API
  or live external client contract is changed.
- `TicketIssueCorrection` carries exact tenant/ticket/project/Issue/scope, old
  and new revision IDs, normalized instructions, source, PM and timestamp.
- `reopenIssues` accepts these records instead of bare IDs. A durable adapter
  must append them and change the current revision/status/review requirements
  in the same transaction as the ticket decision. IDs are generated on the server;
  duplicates/invalid IDs roll back the decision. Do not store the instructions
  in public conversation or infer the relationship from Issue text.
- Developer snapshots require the initial revision and the exact current
  correction (null only for the initial revision). The response allowlists only
  `instructions` and `authorizedAt` in addition to the existing work context.
- Completed evidence also requires no active run before readiness, assessment,
  sharing, acceptance or closure. Client defect reporting itself remains possible
  even when the underlying technical status has subsequently failed.

## Composer safety

Public messages and private notes now keep separate drafts. Switching tickets
clears both; switching tabs cannot put a private note into the public composer.
Uncertain-outcome recovery retains its original draft panel and clear policy,
so retrying a correction/closure does not erase an unrelated message draft.
Long detail/forms use a scrollable detail region rather than clipping controls.

## Still required before enablement

No durable revision adapter, runner claim/gate, completed-work integration hook,
secure result creation/preview, hosted client session, document pipeline, email
or deployed ticket route is supplied by this checkpoint. Client acceptance stays
unavailable in the actual frontend until the actual work can be inspected through
an authorized secure preview. Delivery assessment/sharing is not falsely enabled
from a summary or arbitrary URL. Application tests do not prove real distributed
locking, real mail, provider Auth or hosted RLS.

Supabase/staging configuration and additive persistence remain deferred. Shared/live
stays untouched. No branch/commit/push, env edit, real invitation or deployment.

## Verification

- Backend full regression: 127 files / 2,188 tests passed. The focused six-file
  domain/command/context/route/message/creation run passed 407 tests.
- Frontend full regression: 16 files / 179 tests passed. Both typechecks passed;
  the frontend production build passed with the existing large-chunk advisory.
- Real PM-view browser rehearsal passed initial handoff, targeted PM fixes,
  client correction triage, accepted-only closure, same-operation lost-response
  recovery, private/public draft separation, cross-ticket draft clearing and
  unrelated draft preservation on correction retry. No real API/external calls
  or page errors occurred.
- Desktop/mobile screenshots were inspected. The correction form fits narrow
  screens; the page scrolls on mobile and detail scrolls independently on desktop.
- Existing GitHub login, Project/Issue APIs, runners, desktop source, environment
  files and Supabase schemas/settings were not changed in this checkpoint.

The optional browser fixture explicitly selects later lifecycle states; it does
not prove that the still-unmounted result/identity/storage/execution services are
operational. Complete those integrations and cross-persona staging tests later.
