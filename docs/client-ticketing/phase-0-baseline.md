# Client ticketing — Phase 0 baseline

Date: 7 October 2026. Direction: Plan 3, lightweight browser-only client account.

Status: technical baseline and local fixes verified. No shared/live database
changes, deployments, real invitations, commits or pushes. The full ticketing
feature is not implemented. Phase 0 is not a production-readiness approval.

## Scope that stays fixed

- Client: My Tickets, New Ticket and Ticket Detail; conversation, proposed
  document versions and explicitly shared delivery belong to the ticket.
- PM: one Tickets page for the queue and all client-facing handling.
- Developer: existing assigned Projects and Issues, runners and technical review.
- Keep the name Issues. Do not build another orchestration engine or require
  external clients to join GitHub, download Alpha or become internal members.
- One client can have multiple projects; one project can have multiple tickets.
  A ticket has at most one active project initially. An executable Issue has one
  primary ticket; reference links do not transfer ownership or status.
- Client agreement, PM work authorization, technical review, PM assessment,
  client acceptance, ticket closure and production release are separate decisions.
- A client correction of agreed work stays on the ticket and affects only the
  necessary Issues. New scope becomes a linked ticket. Uploaded revisions are
  proposals, never automatic updates to the approved brief or running agents.
- No automatic account deletion, whole-project restart or project completion
  merely because one ticket closes.
- Keep four PM counters and two client counters. No new analytics dashboard.

## Repository starting points and local branches

| Repository | Starting commit | Current implementation branch |
| --- | --- | --- |
| alpha-fe-main | 77628ab | feat/client-ticketing-foundation |
| alpha-be-main | c867852 | feat/client-ticketing-foundation |
| alpha-desktop | 92d9e1f | main; unchanged |

All worktrees were clean at inspection. No origin fetch was performed, so this
does not claim remote main freshness. No branch was pushed. Only repositories
with source/tooling changes need an implementation branch at this point.

## Protected integration boundaries

| Existing behavior | Ticketing requirement |
| --- | --- |
| Internal GitHub sessions and team roles | Keep intact; external identity/session/grants are separate. |
| Alpha-issued Data API token claims and RLS | Do not relax the issuer rule to make external sign-in work. |
| Cloud owner connection bypasses RLS | Authorize every ticket service query by actor/workspace/grant. |
| Frontend internal AppProvider bootstraps cached workspace data | Select an isolated client entry before mounting it. |
| Cloud Postgres versus desktop SQLite | Ticket authority is cloud-owned, not a second desktop store. |
| Frontend approveScope currently creates project/Issue state | Replace only the new ticket-backed path with PM-authorized server commands. |
| Desktop writes through the Data API | Old clients/direct writes must not bypass ticket guards. |
| Run approval may merge a PR; missing dev can fall back to main | Release safeguards precede the first ticket-backed run. |
| Project creator is immutable and must remain an active PM | Do not repair reassignment by changing created_by. Pause blocked work. |
| Existing board broadcasts contain internal row data | Never attach external clients to the raw board channel. |

## Permissions to implement

| Actor | Allowed | Forbidden |
| --- | --- | --- |
| Visitor | Text-only inquiry through the intended workspace entry; safe acknowledgement. | Private lookup using a reference, arbitrary workspace assignment or public uploads. |
| Verified invited client | Granted tickets, replies, ticket document uploads/replacements, scope agreement, shared-result review and withdrawal request. | Internal workspace membership, repositories, runs, Issue assignment, development/release authorization or impersonating another client. |
| Authorized PM | Invite/revoke, clarify scope, authorize work, choose eligible project, assign Issues, assess/share, download client-submitted documents, close/cancel and authorize release. | Cross-workspace access, document uploads/replacements, fabricating client acceptance, overwriting approved scope or bypassing project ownership. |
| Authorized developer/reviewer | Assigned Issue execution, approved brief and necessary correction context, required technical review. | Automatic access to whole client conversations, client invitations or publication/closure through Issue completion. |

These boundaries are acceptance requirements, not evidence that the new APIs
already exist. Existing non-ticket PM/developer permissions remain unchanged.

## Supabase reconciliation evidence

The user confirmed Agentic-Orchestration is shared/live. Inspection used only
project/migration/schema metadata and recorded migration SQL, never user rows,
Auth-user listings, credentials or document content. No SQL write was executed.

- 15 recorded timestamp migrations map by reviewed name/content to local
  numeric migrations 0001–0015.
- Six normalized sources match the recorded SQL exactly: 0001–0005 and 0014.
- Eight mapped sources have reviewed comment/formatting differences:
  0006–0011, 0013 and 0015. This review identified no executable-SQL behavior
  difference in those sources; it does not prove there were no later manual
  changes to live objects.
- 0012 has a real replay difference: recorded SQL drops the board-listener policy
  before creating it; local SQL does not. Function-source comments and COMMENT
  ON text also differ. Preserve history; do not replay the local file blindly.
- 0016_internal_agent_management is not in the recorded ledger. Live policy
  names still show the earlier developer-only agent-write policies, not its new
  internal-member policy names. Do not silently apply a permission change.
- 0017_hosting_audit is not in the recorded ledger. A read-only to_regclass check
  confirmed alpha_private.hosting_audit is absent.
- The PM-owner helper and immutable-owner trigger helper exist on live.
- No development branch was listed in the earlier inspection; no separate
  staging environment has been selected.

The checked-in JSON stores normalized local SHA-256 fingerprints, recorded
version/name/MD5 metadata and review classifications. It contains no SQL bodies,
personal records or secret values. MD5 here is a historical source-comparison
field, not a security signature.

### Reproducible offline checks

Run from alpha-be-main:

```powershell
npm run test:migrations
npm run audit:migrations -- --baseline-only
npm run audit:migrations
```

- Eight Node tests cover normalization, missing/new/changed files, duplicate
  metadata, unsafe names and known-gap handling.
- Baseline-only exits 0 when sources still match this reviewed snapshot.
- Strict mode intentionally exits 2 because 0012 differs and 0016/0017 are not
  recorded. It must not be presented as a passing deployment gate.
- Source drift exits 1 even in baseline-only mode.
- Neither command connects to Supabase, loads .env or applies SQL. Even exit 0
  is not proof of current live schema health or permission to deploy.

### Historical migration decision

Keep existing files unchanged for this phase. Do not rename them to recorded
timestamps or run migration repair. The live ledger and local directory are not
currently interchangeable CLI histories. Before feature DDL, the designated
database maintainer must approve the canonical history/release workflow and
disposition of 0016/0017. New DDL must be a reviewed migration file, rehearsed
against isolated targets. Never use “apply all files” as the live rollout plan.

## Local problems fixed

### Frontend Node import failure

shared/desktop.ts read window at import time. A repository helper test imports
the component/API/config chain, so it crashed before assertions could run.
Guarding a missing window preserves browser/Electron bridge behavior and makes
non-browser imports safe. Four new tests cover Node, browser, current preload
addresses and older optional-capability support.

### Backend test configuration contamination

Tests that remove ALPHA_MODE and re-import env.ts allowed dotenv to reload the
developer's real .env. This made local-store tests unexpectedly select cloud
mode. The Vitest-only setup now mocks the file loader before application imports;
explicit per-test environment fixtures still work. Real cloud/database/token
values and a shared SQLite override are cleared in test configuration. Runtime
env.ts and the actual .env files are unchanged.

An initial diagnostic run also used one temporary SQLITE_DB_PATH for all tests.
That was a test-command mistake: it bypassed each test's ALPHA_HOME isolation and
caused duplicate fixture records. The override was removed. That failed run is
not evidence of production data duplication.

Windows sandbox native-realpath restrictions prevented Vitest from collecting
tests. Successful runs used the approved unsandboxed local test process, not a
dependency downgrade or permission relaxation in the application.

## Verified checks

| Check | Result |
| --- | --- |
| Frontend typecheck | Passed. |
| Frontend Vitest | 9 files / 61 tests passed, including the previously failing helper suite. |
| Frontend production build | Passed; Vite reports an existing oversized JavaScript chunk (about 1.33 MB minified). No deployment performed. |
| Backend typecheck | Passed. |
| Backend Vitest | 113 files / 1,568 tests passed with isolated configuration. |
| Backend production build | Passed. No backend was started against live. |
| Offline migration-audit Node tests | 8 passed. |
| Baseline-only migration check | Passed; historical source unchanged. |
| Strict migration check | Expected exit 2; known live reconciliation gaps remain visible. |
| Desktop syntax checks | main.js, preload.js, desktop-address.cjs and scripts/prepare.mjs passed. |

These tests exercise existing login/session, workspace/Issue access, stores,
runners, GitHub/hosting and sync behavior against local fixtures/mocks/PGlite.
They do not prove real hosted Auth/email/Storage delivery, the full interactive
UI or a packaged desktop release. A build alone is not an end-to-end test.

## Outstanding gates before the next implementation checkpoint

1. The user selected and created Alpha Ticketing Staging on 7 October; its
   separate project ID pvbppmajgsbkrnvxlzrn is now verified in Capstone.
   Read-only inspection found a fresh application schema/migration surface and
   no advisor findings. Identification is complete; staged schema/configuration
   preparation and recovery verification are not. Docker is not the selected
   immediate path. Live remains read-only; normal app .env files are unchanged.
2. The user approved a staging-only baseline matching the 15 deployed migrations,
   excluding 0016/0017. It has now been rehearsed, applied to staging and verified;
   see `../../supabase-staging/README.md`. Shared/live history and 0016/0017 release
   handling still require maintainer approval. Shared history was not modified.
3. Confirm usable backup/restore coverage and rehearse recovery in isolation,
   including actual Storage files and configuration dependencies.
4. Identify the approved sender/provider, client web origin, attachment scanning
   and retention policy. No SMTP/DNS/Auth settings were changed.
5. Approve pilot repository/environment safeguards and named release/recovery
   owners. Existing main-only fallback cannot become the ticket release path.
6. Obtain team approval of manuscript interpretation and the scope/permissions
   above. This is development-request ticketing, not a general incident helpdesk.

Work that is safe meanwhile: review the local diff, run isolated regression
checks, refine concrete integration contracts and prepare local test fixtures.
Do not mark the staging/recovery or live rollout gates complete from this report.
