# Client ticketing — Phase 1 integration contracts

### Application-first sequencing clarification — 8 October 2026

The existing phase order remains in force: complete the local application flow,
transport/safety work, and local regression/compatibility gates before starting
Supabase integration. The faster implementation path narrows the first workflow
and pauses adjacent features; it does not pull Supabase or staging work forward.
The six labels in the frontend [`application-first.md`](../../../alpha-fe-main/docs/client-ticketing/application-first.md)
are status roll-ups. The governing phase-by-phase plan and the requirements in
this document remain authoritative. No staging write, provider change,
invitation, or route enablement is authorized by this planning update.

Date: 7 October 2026. Direction: Plan 3, limited browser-only client accounts.

Current implementation checkpoint — 8 October 2026: the existing PM Tickets
page has an opt-in, read-only cloud API. Public inquiry persistence has a
PostgreSQL adapter tested against the reviewed ticket schema, including private
contact storage and transactional outbox/idempotency. The cloud route is gated by
the triage setting and exact allowed-origin/rate checks. PM
workflow writes, client activation/email, and runner/release guards are still
not enabled. Do not treat the UI or local database rehearsal as a working
hosted ticketing system.

Status: local engineering contract draft, transaction adapter, pure ticket
workflow decisions and an application command service implemented. These
primitives are not wired to application routes. The command service and test-only
store follow existing services/store folders; see
[the application command checkpoint](application-command-layer.md).
The subsequent [authorized read checkpoint](application-read-layer.md) adds safe
detail/conversation/PM-note read services and shared access checks. No read/write
ticket router or production ticket persistence is enabled by these checkpoints.
The [communication checkpoint](application-communication-layer.md) subsequently
adds atomic public replies, private PM notes and shared operation recovery in
the existing service/store/domain folders, still without a mounted API.
The [queue checkpoint](application-queue-layer.md) adds scoped client/PM lists,
safe pagination and the agreed two/four counters, with real query/auth/provider
adapters still deferred. Neither checkpoint creates actual client accounts.
The [creation checkpoint](application-creation-layer.md) implements signed-in
request creation/recovery. The [public-intake checkpoint](application-public-intake-layer.md)
adds an unmounted public inquiry service/store contract and allowlisted request
detail projections in the existing folders. Public route/provider/production
adapters, durable activation persistence, and invitation delivery remain
pending; inquiry submission cannot create an account, project, Issue, or agent run.
The [client activation checkpoint](application-client-activation-layer.md) now
defines the provider-neutral eligibility rule and an unmounted transaction
service/store contract to consume the invitation, bind the same ticket, and
create service/ticket grants. It does not implement the identity-provider
adapter or create the separate Alpha client session.
The [PM invitation issuance checkpoint](application-invitation-layer.md) adds
the provider-neutral PM-side issuance transaction, minimal delivery signal,
and unmounted PM command/invitation transport controllers; they do not send
email or enable an endpoint. PM review and invitation are distinct requests.
Invitation and activation use an internal reference to the immutable original
contact rather than copying email into the invitation record.
The [client session checkpoint](application-client-session-layer.md) adds a
provider-neutral exchange, revocable-session store contract, and cloud-only
session transport boundary. It does not use the GitHub session, create accounts,
connect a provider, or mount routes.
The [developer-context checkpoint](application-developer-context-layer.md)
defines a separate assigned-Issue brief projection. It exposes no client thread
or contact and is not a substitute for a fresh run-start/retry authorization.
Scheduling update, 8 October: the user approved application-first preparation,
deferring further Supabase integration. The previous database-first sequence is
superseded for local UI/workflow/service-adapter work only; hosted authentication,
storage, recovery and release gates remain mandatory before enablement. See the
frontend `docs/client-ticketing/application-first.md`. Client web links will use
`/#/client/...` to preserve the existing single-URL hosting/Electron asset base;
the proposed `/api/client` service endpoints below are unchanged.
No ticket routes, Auth flow, UI, schema or feature flags are enabled by this
document. Phase 1 exit is **not met**: the staging baseline is now applied and
verified, but client configuration, full recovery rehearsal and operational decisions
remain outstanding. These route
names are proposed, not an assertion that they already exist.

Read with [Phase 0 evidence](phase-0-baseline.md). Existing PM/dev behavior and
the original twelve-phase plan remain the requirements, not a smaller MVP.

### Environment decision — 7 October 2026

The user selected option 2: a separate online staging Supabase project. Local
Docker setup is no longer the immediate prerequisite. This selects the type of
environment; it does not approve a billable resource or identify a writable
target. The initial read-only project listing exposed only the known
shared/live Agentic-Orchestration project; its development-branch listing is
empty. No staging target was available through the connection at that checkpoint.

Next: confirm the organization for staging (or obtain access to an existing
separate staging project), show the applicable cost for approval if creating
one, then verify its distinct project ID before any setup write. Keep the
shared/live project read-only. Do not copy live client data or credentials;
use isolated test identities, files, configuration and approved recipients.
Existing local .env files and the normal app connection remain unchanged.

The user confirmed Capstone as the staging organization. Read-only organization
metadata reports the Free plan. The connection's advertised get_cost command
returned UNAVAILABLE (not exposed by tools/list), so no project-specific cost
quote/confirmation ID was obtained and no creation was attempted. Official
pricing currently lists Free at $0/month with a two-active-project limit;
this does not prove this account has an unused slot or authorize a paid upgrade.
The owner can confirm eligibility and create the separate staging project in
the Dashboard without selecting a paid upgrade, or restore provisioning/cost
capability to the connection. Proposed name: Alpha Ticketing Staging; proposed
region: Tokyo, matching the inspected live region. These remain proposed until
the actual staging project ID is verified. Do not request passwords or secret
keys in chat. Pricing reference: https://supabase.com/pricing.

The user subsequently created and named Alpha Ticketing Staging. A new
read-only listing and staging-only inspection verified the following targets:

| Environment | Exact project ID | Observed region/version | Permitted use |
| --- | --- | --- | --- |
| Shared/live Agentic-Orchestration | gupmckxxaaxlameekihy | ap-northeast-1; PostgreSQL 17.6.1.141 | Read-only inspection; no development writes. |
| Alpha Ticketing Staging | pvbppmajgsbkrnvxlzrn | ap-northeast-2; PostgreSQL 17.11.0.003 | User-approved deployed baseline applied and verified; new client feature/settings remain gated. |

Both targets are in Capstone and report ACTIVE_HEALTHY. Staging is in
ap-northeast-2 rather than the proposed Tokyo region; retain the user's project,
do not recreate it automatically. Account for the region/Postgres patch
difference during compatibility/load verification instead of claiming identical
infrastructure. Project IDs are non-secret target identifiers, not credentials.

Staging inspection returned no tables in public/alpha/alpha_private, an empty
migration ledger and no security/performance advisor findings. This proves the
inspected application surface is fresh, not that hosted Auth/Storage/email or
the application is configured/tested. No auth user listings, record copies,
schema writes, settings changes or secret-key retrieval were performed.

The environment-choice/identification blocker is resolved. Schema baseline,
historical migration disposition, independent connection/credential setup,
recovery rehearsal, test recipients and other Phase 1 gates remain open.
Future writes must verify pvbppmajgsbkrnvxlzrn explicitly; the existing live
project is never a fallback. Existing app .env files have not been switched.

The user subsequently approved **matching the deployed live baseline**, excluding
0016/0017. After local replay/rollback and issuer checks passed, one baseline
migration was applied to staging only: 20261007154549_live_control_plane_baseline.
It reconstructs the 15 recorded live migrations without copying records or
repairing either remote ledger. The separate `supabase-staging` workspace records
the source/target, exact SQL fingerprints and its real applied version; historical
`supabase/migrations` files remain unchanged.

Read-only post-application checks verified 21 RLS-enabled tables, zero application
rows, 496 matching catalog entries and 72 matching effective schema/table permission
entries. Advisors surfaced inherited mutable-search-path, private-session/no-policy,
overlapping project-policy and unused-index findings. These are recorded in
[the staging report](../../supabase-staging/README.md); they are not hidden by a
claim of release readiness. No live write, real user/invitation, SMTP/Auth/Storage
setting, app environment switch or deployment accompanied this staging setup.

Staging identification and the deployed-baseline choice are resolved. Full hosted
Auth/Storage/email/recovery, independent secrets/origins/recipients and pilot
safeguards remain open. Shared/live history and pending-migration disposition
still require the maintainer's separate release decision.

### Staging follow-up — 8 October 2026

The separate tracked migration `20261007160159_pin_project_owner_search_path`
resolved staging's mutable-search-path warning. Hosted metadata verifies exactly
one intentional catalog delta (`alpha.keep_project_owner()`), unchanged function
identity/body/owner/ACL/invoker mode, all 72 effective access entries unchanged,
and 21 empty application tables. The private-session/no-policy INFO remains an
intentional server-only boundary. Local baseline/hardening rehearsal: 14 tests
passed; typecheck and build passed. Fresh full backend regression after the final
test-source edits: 117 files / 1,675 tests passed. Offline migration tests: 8 passed;
historical baseline-only audit and git diff whitespace check passed. An initial
typecheck caught missing generic types in the new test; those were corrected
before the successful final checks. See `supabase-staging/hardening-manifest.json`.
This is a second staging-only migration, not a live fix or feature enablement.

The user is unsure whether staging custom SMTP is configured. Treat delivery
readiness as unknown, not configured or absent. Installed MCP tools expose no
Auth configuration endpoint; SQL metadata cannot prove SMTP/redirect settings.
An authorized owner needs to inspect staging Authentication → Email → SMTP and
URL Configuration, then confirm sender, test recipient eligibility and exact
web origin. Never ask for secret values in chat. No provider settings, invitations
or emails have been changed/sent. Default SMTP only delivers to organization-team
addresses; real clients require a reviewed custom sender.
Reference: [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

Source inspection also confirms client email authentication is a new boundary:
`index.ts` currently mounts internal `sessionContext` then `workspaceContext`
before internal routers; `sessionContext.ts` resolves GitHub cookie/bearer identity.
Future `/api/client` routing must have its own narrow cloud-only authentication
chain before internal workspace rejection, without exempting internal routes or
turning provider JWTs into GitHub sessions. No client sign-in/mail adapter exists
in the current source. Returning passwordless login must explicitly disallow
automatic signup; invitation activation must bind the verified identity once
to the server-owned grant. Do not create client workspace membership as a shortcut.
Reference: [Supabase passwordless login](https://supabase.com/docs/guides/auth/auth-email-passwordless).

Phase 1 is still incomplete: independent ignored staging app configuration,
hosted Auth/Storage/recovery evidence and operational/pilot safeguards remain
open. Existing branches are retained following the user's instruction to
continue; no additional branches, commits or pushes were created.

Owner next action: follow [the staging Auth checklist](staging-auth-checklist.md)
for read-only SMTP/origin inspection. Phase 1 is not marked complete, and these
checks do not claim working hosted client Auth, Storage, email or recovery.

## 1. One service, separate identities

- Cloud is the only ticket authority. No SQLite ticket copy accepts commands.
- Internal actor: existing verified GitHub session or desktop bearer identity,
  plus fresh workspace membership and PM capability. Never accept a PM role
  supplied in a body/header or inferred from the client account.
- External actor: verified Supabase Auth user ID plus Alpha's dedicated persisted
  client session and current server-owned grant. Verified email is used to bind
  an invitation once, not as the continuing authorization key.
- A client session never becomes req.session (the existing GitHub session),
  workspace membership, an Alpha-issued internal database token or an internal
  project's assignment. One person can hold both identities without merging them.
- The existing backend Session now carries a server-only ticket authentication
  proof: persisted cookie-session hash ID or a request-scoped handle minted after
  verified GitHub bearer auth. `/me` explicitly allowlists fields and does not
  return this proof. It still does not authenticate external clients.
- PM ticket management now has an explicit `ticket.manage` workspace capability.
  It is granted to PM only in this PM/Dev phase; external client identities do
  not use workspace membership or this capability.
- Client data access is server-mediated. An owner database connection bypasses
  RLS, so every query also has an explicit actor/grant/workspace predicate.
- Invite revocation, expiry and client-session revocation are rechecked on every
  protected operation, including download and acceptance. Revoking Alpha access
  does not depend on waiting for an old provider JWT to expire.

## 2. Entry, routes and transport

| Surface | Proposed method/path, relative to /api | Gate and result |
| --- | --- | --- |
| Public intake | POST /client/intake/:entry/inquiries | Published server-resolved workspace entry; abuse limits; text-only payload. Generic acknowledgement, never private lookup by reference. |
| Provider sign-in/activation | POST /client/auth/activate; provider sign-in is owned by the configured provider | The unmounted activation controller accepts the one-time invite token plus server-verifiable provider credential; exact invite binding and safe generic response. No open signup. |
| Alpha session exchange | POST /client/auth/session | Unmounted controller/service contract: server-verifies provider credential; creates a separate revocable Alpha session only for an already activated client account. Requires exact origin and rate-limit admission; no automatic provider/Alpha signup. |
| External session | GET /client/session, POST /client/session/logout | Dedicated client cookie; logout is idempotent, clears only this identity. Session inspection reveals no ticket records before authorization. |
| Client discovery/list/create | GET /client/workspaces; GET /client/workspaces/:workspaceId/intake-context; GET /client/workspaces/:workspaceId/tickets; POST /client/tickets | Unmounted transport. Workspace is only a selector; available workspaces and create handles come from current client grants, not arbitrary workspace/project IDs. |
| Client detail/actions | GET /client/workspaces/:workspaceId/tickets/:id; GET/POST .../:id/messages; POST .../:id/commands | Unmounted transport. Grant checked in the application service before protected data is returned; client-safe DTOs only, no private-note route. |
| Client files | POST .../:id/attachments; GET .../:id/attachments/:fileId | Authenticated allowed types/quotas; immutable quarantine/scan/finalization; no public intake upload. Exact upload protocol follows scanner selection. |
| PM queue/detail | GET /tickets; GET /tickets/:id | Existing internal cloud auth; active PM and workspace/entity access. One frontend Tickets page. |
| PM conversation/notes | POST /tickets/:id/messages; POST /tickets/:id/notes | Same PM checks; public reply and private note are different operations and responses. |
| PM decisions | POST /tickets/:id/commands | Allowlisted command; expected version; operation ID; explicit command-specific permission. No generic PATCH status. |
| Saved operation lookup | GET /client/tickets/operations/:operationId?intakeContextId=...; GET /client/workspaces/:workspaceId/tickets/:id/operations/:operationId; GET /tickets/operations/:operationId?ticketId=... | Original verified actor + current applicable grants/workspace access. Return only authorized saved outcome; non-enumerating 404 otherwise. PM controller registers the static operation route before parameterized ticket routes. |
| PM invitation handling | POST /tickets/:id/invitations; POST .../:id/invitations/:invitationId/commands | Exact invitation belongs to ticket/workspace; resend/revoke/supersede are recorded, bounded operations. |
| Developer execution context | GET /issues/:id/ticket-context | Existing assigned project/Issue checks; approved brief and affected-work context only, never the full client thread. |

The activation, session, and client ticket controllers are currently unmounted.
When stores and providers are ready, mount the client router with its own
authentication/authorization **before** the
existing internal sessionContext/workspaceContext chain. Handle unknown client
routes as 404 in that router; never let them fall into internal routing. Do not
add /client or /tickets to workspaceContext's public prefix list. Public
operations are exact method/path pairs, not an exemption covering all verbs.

Keep PM web requests behind the existing internal chain. Desktop PM ticket
requests relay through the local daemon using cloudRequest and the existing
verified GitHub credential path. If cloud transport is unconfigured/unavailable,
ticket commands fail explicitly: no local success, queued approval or fallback
to a second authority. Never expose the GitHub token to the renderer or send
client cookies to a desktop daemon. ALPHA_CLOUD_API is an address, not a key.

Client web entry is selected in src/main.tsx **before** importing/mounting the
internal AppProvider/App module graph. Use a lazy separate client entry/context;
do not bootstrap internal API calls, cached projects or raw board subscriptions
first and merely hide them. Legacy GitHub-client screens remain separate until
explicitly reviewed migration; their approveScope path cannot handle new tickets.

Prefer one approved HTTPS web origin proxying /api to cloud. Proposed client
cookie: __Secure-alpha_client_session, HttpOnly, Secure, SameSite=Lax,
Path=/api/client, no Domain. Use independent CSRF/session secrets, exact origin
validation for unsafe requests, a per-session CSRF token, no GET mutations and
no wildcard credentialed CORS. Local development uses a separately configured
non-Secure cookie name on loopback, never a production fallback. A different
cross-site topology needs a separate reviewed cookie/CSRF design. Provider
callback/OTP details, lifetimes and redirect allowlist must be verified against
the chosen Auth deployment before implementing activation.

## 3. Response and command contracts

Client summary fields: opaque ID, human reference, client-safe company label,
title, status, record version, latest **client-visible** update and requested
action. Optional project information is a deliberately shared display name,
not an internal Project record or repository URL.

Client detail adds its public messages, agreed/proposed scope versions, allowed
attachment descriptors and deliberately shared delivery/review records. Map
fields explicitly; never serialize an internal record then remove a few keys.
Private notes, runs, actor credentials, internal member identities, repository
metadata, agent prompts and internal-only document versions are absent at query
and DTO boundaries. No placeholder counts on failed requests.

Command envelope: schema version, operation ID, expected ticket version,
allowlisted command name and command-specific input. Actor, workspace, status,
timestamps and approval authors come from the server, never trusted from input.
Scope/review commands name the exact immutable version they concern.

- Reusing an actor/workspace/operation key with the same canonical payload
  returns the saved authorized outcome. Changed payload -> conflict.
- Lock/check the ticket version and business uniqueness inside the transaction;
  different operation IDs must not create duplicate primary Issue ownership or
  accept a superseded delivery. Reauthorize before replaying a saved result.
- Missing login -> 401; authenticated forbidden known operation -> 403;
  inaccessible resource -> non-enumerating 404; stale version/invalid transition
  -> 409 with a safe refresh instruction; invalid input -> 400; disabled writes
  or unavailable authority -> explicit unavailable response, never false success.
- Pagination and counters are filtered by the same live grants. Error responses
  never include driver messages, SQL, signed URLs, tokens or document contents.
- Audit records capture operation/actor IDs, decisions and referenced versions,
  not secret credentials or duplicate private message bodies in general logs.

## 4. Lifecycle and review loops

States: Received, Under review, Awaiting you, In progress, Ready for review,
On hold, Closed, Declined and Cancelled. Terminal records are retained read-only.
Outstanding action owner/reason is separate from status; do not infer the next
actor from status alone. Client acceptance is a decision on a delivery, not an
automatic Closed status or deployment.

| Event | Who records it | Required evidence / next state |
| --- | --- | --- |
| Inquiry submitted | Intake service | Intended workspace entry -> Received, no run/work creation. |
| Initial suitability | PM | Decline with safe email -> Declined; invite suitable client -> Under review. Invitation is not scope authorization. |
| Clarification/proposal | PM | Activated granted client; immutable public scope version plus private developer brief -> Awaiting you. Before work authorization, a revised proposal creates a new version. Client reply/change request -> Under review. Ordinary conversation during implementation does not reset progress. |
| Scope agreement | Client | Current proposed scope version -> recorded agreement; Under review until PM separately authorizes. |
| Work authorization | PM | Agreed immutable scope, eligible project, current creator/access/release safeguards, validated Issue manifest -> In progress. Project/Issues/link/audit/job writes are atomic, provisioning reconciled separately. |
| Developer reports done | Existing execution/review path | Required technical review evidence -> PM assessment pending; no client publication, ticket closure or production merge. |
| PM requests fixes | PM | Affected Issue/review IDs and reason -> In progress; no whole-project restart. |
| PM shares result | PM | All required manifest work/reviews pass; PM assessment; pinned commit/build/artifact + current scope version -> Ready for review. |
| Client reports agreed-work defect | Client, then PM | Feedback on current delivery; PM triages/authorizes affected correction -> In progress, supersedes acceptance opportunity for old delivery; repeat technical/PM/client review. |
| Client accepts | Client | Current pinned delivery/version; active grant -> recorded acceptance. PM still owns closure and separate release authorization. |
| PM closes accepted work | PM | Current unsuperseded acceptance -> Closed, reason Accepted. Does not complete all project tickets. |
| PM answers without development | PM | Public answer; no outstanding authorized implementation -> Closed, reason Answered. Not acceptance of software. |
| Withdrawal requested | Client, then PM | PM stops queued work and resolves running work safely -> Cancelled. Unrelated Issues/runs continue. |
| Client silent / operational blocker | PM | Audited reason -> optional On hold; no automatic acceptance. Resume only through fresh prerequisite checks. |
| Extra scope or post-authorization change | Client/PM | New linked ticket -> Received; retain original work and decisions. A correction to agreed work uses targeted correction on the current ticket; no whole-scope reset. |
| Post-closure feedback | Client/PM | New linked ticket -> Received; retain original decisions. |
| Production promotion | PM/release service | Separate current release authorization covering every included ticket/build/commit and acceptance; never a side effect of acceptance/closure. |

An initial suitable inquiry becomes the **same** ticket after activation. Do not
create one inquiry ticket plus a duplicate authenticated request. PM may link an
existing project, create a project once the scope/work is authorized, or resolve
without a project. One active project per development ticket initially; multiple
tickets per project and multiple Issues per ticket remain supported.

Document upload/revision is a proposal tied to a ticket. Store immutable
versions; do not edit an agent's approved baseline. Before work authorization,
material changes require impact review and a new client-agreed scope version.
After authorization, additional scope or a changed baseline is a linked ticket;
an agreed-work defect uses targeted correction. Do not reset or silently revoke
work already underway. A general reply or attachment upload is never an implicit
change to scope or authorization.

## 5. Atomic writes, side effects and recovery

Implemented local primitive: database().transaction(work), callback receives
Sql bound to **one** checked-out pg client. Existing database().query callers
remain unchanged. Await all statements through tx; never issue BEGIN/COMMIT,
nested transactions, provider calls or database().query inside the callback.
Use short transactions and reviewed transaction-local timeout settings in the
future ticket store; connection/pool settings are unchanged in this phase.

Callback/SQL failure rolls back; swallowed SQL failure still rejects. Failed
BEGIN/ROLLBACK discards the connection. Unacknowledged COMMIT raises the safe
DatabaseCommitError with outcome unknown and discards the connection; do not
automatically rerun. The API maps this distinct error to 409 with code
transaction_outcome_unknown and reconciliationRequired, not the ordinary 503
"try again" response. Inspect the durable operation outcome using a new connection
and the same authorized identity. Concurrency/uniqueness is the store's job,
not provided automatically by this adapter. Adapter tests cover real local
Postgres rollback as well as mocked connection cleanup/failure scenarios.

Use the operation lookup above after an ambiguous result. A missing record
after an unknown commit is not permission to immediately send a different
operation ID: the original may still be completing. Reconcile the original
identity/key, then retry only the same command through its uniqueness/version
checks when the service can establish a safe outcome. Unknown provider effects
remain pending until their external operation is reconciled.

The transaction will save business changes, audit, idempotency outcome and
notification jobs together. A leased cloud notification worker sends only after
commit, retries with deduplication/bounds, records failed/uncertain delivery and
never claims exactly-once email. Worker process owner, retry/lease budget and
provider are unresolved; no worker is started by this contract.

Repository provisioning likewise uses a persisted operation state before remote
calls. Unknown remote outcome is reconciled by stored repository identity;
never fabricate a rollback of a successfully created repository.

## 6. Existing paths that must be guarded before ticket execution

| Current source/path | Ticket-aware enforcement required later |
| --- | --- |
| controllers/dataController.ts: /projects create/update/delete; /issues create/update/complete/delete; /board/sync | Same-workspace/project/primary-ticket constraints; preserve retained evidence and baseline; completion is technical only. Unlinked records retain existing behavior. |
| controllers/runController.ts: /runs/start and /runs/:id/retry; services/runnerService.ts:startRun/executeTask | Fresh cloud authorization and approved Issue/scope revision at actual execution, including queued starts/retries. Offline or stale daemon -> block ticket-backed start. |
| controllers/runController.ts: /squads/:id/run; services/squadRunner.ts | Apply the same per-Issue checks to every member; squad order is not a second ticket workflow. |
| controllers/runController.ts: /runs/:id/approve | Technical approval must not merge ticket-backed work into an uncontrolled production destination. Preserve separate PM assessment/acceptance/release. |
| services/runnerService.ts: PR base dev-or-main fallback | Reject unsafe ticket project before launch; never silently use main when controlled non-production branch is absent. |
| controllers/githubController.ts: /github/merge and /github/dispatch; services/githubService.ts and githubPullRequests.ts | Shared release guard before protected integration; actor capabilities alone do not prove accepted scope. Review workflow dispatch destinations. |
| controllers/projectRepoController.ts promotion; services/githubRepoWorkspace.ts | Validate all included changes/tickets and current pinned release authorization, not only the initiating ticket. |
| controllers/agentBridgeController.ts; controllers/hostingController.ts and services/hosting | Production env changes, redeploys, approvals and external provider calls cannot bypass ticket delivery/release gates. |
| Supabase direct Data API upserts, old desktop sync and deletion | Protected server-owned link/baseline tables plus database enforcement prevent payloads omitting new fields from erasing authority. Do not relax internal issuer/RLS. |
| Agent shell/git tools and remote GitHub/hosting workflows | Repository/environment protections and compatible daemon/tool policy are prerequisites; HTTP checks alone cannot contain arbitrary remote credentials. Detect/admin-audit exceptions. |

This is a source inventory, **not implemented protection**. Before first ticket
run, test every path and its service-layer entry, legacy daemon and direct write
variants. A selected repository stays ineligible until protections hold even for
non-ticket commits carrying its unaccepted changes. No new ticket may launch
early merely because an intake UI works.

## 7. Compatibility, feature-off and remaining decisions

- Define a ticket contract version independent of app marketing version and a
  minimum compatible daemon capability. Capability checks occur at cloud and
  actual runner actions, not just renderer buttons. Exact version is assigned
  when integrated guards exist, not advertised prematurely.
- Enable ticket writes per approved workspace/project only after readiness.
  Feature-off retains authorized history and safe cancellation/recovery while
  disabling invitations/new writes/sharing/release. No fallback to legacy scope
  auto-project creation. Running computation may finish locally; remote sharing
  waits for authority. Unrelated work is unaffected.
- Keep compatible guard services during rollback; dropping new tables or using
  an old unguarded daemon is not a safe rollback of active ticket work.
- PM Tickets has four counters; client My Tickets has two. Definitions are in
  Phase 0/master plan; no extra dashboard or completion percentage.
- Still required: independent staging application configuration, reviewed live
  migration-release history, hosted storage/config recovery rehearsal, approved web origin/sender,
  Auth/invitation lifetimes, scanning/quota/retention, numeric pool/worker/timeout
  budgets and stop thresholds, named release/support/worker/recovery owners,
  manuscript interpretation and pilot repository protections.
- Do not substitute PGlite for real Supabase Auth/Storage/email/RLS integration
  tests. No live schema write, provider setting, invitation or deployment is
  authorized by this document or a passing local test.

## 8. Local workflow checkpoint

`src/ticketing/workflow.ts` provides pure decisions for the lifecycle in section 4.
It has no database, session, runner, email or HTTP integration. It separates scope
agreement, PM work authorization, technical readiness, PM assessment/sharing,
client acceptance and PM closure. None of its decisions releases software or
marks a project complete. Terminal tickets stay read-only; extra work needs a
new linked ticket in the future service, not a reopen command.

The default mode disables decisions. Strict versioned commands reject raw status
updates and caller-supplied actors/facts. Tests cover tenant/grant/role checks,
stale versions, exact Issue/revision manifests, pinned deliveries, clarification,
holds, withdrawal, correction loops and superseded results. An internal-only
technical-readiness hook routes passed work to PM assessment without publishing.

Follow-up regression tests reproduced and fixed two local rule gaps: initial
authorization cannot replace an already-authorized manifest during correction
triage, and a correction needs an active assignee only for affected Issues, not
an unrelated finished Issue. Repeated scope agreement cannot overwrite triage.
A genuinely new scope still requires fresh agreement and PM authorization.

These are domain checks, **not implemented API authentication or database
isolation**. Future services must resolve identities and fresh facts in the same
transaction, enforce revocation, persist immutable history and operation outcomes,
and apply affected Issue changes atomically. The returned event is metadata;
the store must also retain validated decision references and reasons in its
private audit record without putting message bodies or credentials in general logs.
Real runner/release guards, notifications and idempotent replay remain unimplemented.

## 9. Local verification and handoff

Verified after the final source edits:

| Check | Result |
| --- | --- |
| Backend typecheck and production build | Passed. |
| Fresh full backend regression including staging rehearsal and workflow decisions | 116 files / 1,669 tests passed. |
| Focused pure workflow suite | 1 file / 78 tests passed, including unsafe numeric versions, repeated-authorization protection and targeted corrections. |
| Focused staging baseline rehearsal | 1 file / 8 tests passed; 86 tests combined with the workflow suite. |
| Transaction, existing database and API error focused suites | 3 files / 28 tests passed. |
| Offline migration audit tests | 8 passed. |
| Historical source baseline | Unchanged; baseline-only passed. Strict check still intentionally reports the 0012/0016/0017 reconciliation gaps. |
| Frontend baseline | Typecheck, 61 tests and production build passed; no additional frontend changes in this Phase 1 preparation. Existing large-bundle warning remains. |
| Desktop | No source changes; Phase 0 syntax checks passed. No package/release test claimed. |

One intermediate full regression run overlapped the error-handler edits and
reported two failures against an already-loaded old handler. The focused fresh
run and the final full fresh run both pass. Do not use the mixed-source run as
release evidence or conceal its result as a production defect.

Current code diff is local and uncommitted. No live schema, environment files,
historical migrations, Auth/SMTP/Storage settings, real email, billable resource,
deployment or repository push was changed. No new user-facing ticket capability
exists yet. The Supabase skills informed connection/transaction isolation and
the requirement to rehearse schema/Auth/Storage changes away from shared live.

The hosted staging baseline above is the one remote database change now made;
earlier no-write checkpoints describe their historical state, not this later step.
The skills also informed bounded execution, catalog and privilege verification,
and preserving managed schemas rather than changing provider objects.

Application-first scheduling update: next finish the isolated client request/read
transport and frontend account flow without connecting provider or database
adapters. Then return to the isolated staging/Auth/Storage/recovery gates and
complete cross-persona acceptance before any pilot. Preserve the separate
maintainer live-history gate; shared/live remains read-only throughout.

Implementation references: [node-postgres transactions](https://node-postgres.com/features/transactions),
[pool client cleanup](https://node-postgres.com/apis/pool),
[Supabase pooler connection state](https://supabase.com/docs/guides/troubleshooting/resolving-cannot-execute-update-in-a-read-only-transaction-on-transaction-pooler-connections-ef582c).
