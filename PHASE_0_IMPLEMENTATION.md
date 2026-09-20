# Phase 0 — Implementation Log

Running record of the auth/hosting work. Companion to
`ARCHITECTURE_AND_IMPLEMENTATION_DECISIONS.md`, which states the target;
this file records what actually changed and why.

**Started:** 2026-09-20

---

## Working-tree state found at start

Both repos had **uncommitted work already present** when this began, on `main`:

| Repo | File | What was already there |
| :--- | :--- | :--- |
| `alpha-fe-main` | `src/app/AppContext.tsx` | `KNOWN_ROLES` normalisation — funnels an unrecognised daemon role (it has served `'owner'`) into the `'pm'` fallback instead of crashing the first component to index `ROLE_TABS`. |
| `alpha-be-main` | `src/index.ts` | Import reshuffle adding `liveBuildRoomRouter`, `agentCallRouter`, `agentCallService`. |
| `alpha-be-main` | `src/services/workspaceRegistry.ts` | `DEFAULT_WORKSPACE_ID` imported instead of a second `'workspace-default'` literal, plus `ALTER TABLE` migrations adding `workspaces.status`, `created_by`, `join_code` and a partial unique index. |
| `alpha-be-main` | `src/services/chatService.ts` | `workspaceId` / `workspaceRole` added to `SendMessageParams`. |
| `alpha-be-main` | `src/services/sqliteService.ts` | `AgentCall`, `AgentCallTarget`, `AgentCallArtifact` type imports. |

This work is coherent and typechecks. It is **not** part of Phase 0 and is
unattributed here — it predates this log. Flagged so the two are not
conflated in a single commit.

---

## G6 — Remove the Supabase fallback from the frontend API client

**Status:** done
**File:** `alpha-fe-main/src/shared/services/apiService.ts`
**Net:** +5 / −138

### The defect

Five methods — `getProjects`, `createProject`, `getAgents`, `getIssues`,
`createIssue` — wrapped their backend call in a `try`/`catch` whose fallback
went straight to Postgres with the Supabase anon key:

```ts
try {
  return await fetchJson<Project[]>('/projects');
} catch (err) {
  if (isSupabaseConfigured() && supabase) {
    const { data } = await supabase.from('projects').select('*');
    ...
```

The `catch` fires on **any** backend failure, including a `403` from
`requireWorkspaceCapability`. So a permission denial was not a denial: it was
a redirect to an unguarded path. With no RLS policies in the project (none
exist yet), the anon key is full table access.

The write path was worse. A project created through the fallback exists only
in Postgres — the backend's SQLite never learns about it, so
`workspaceRegistry.bind()` never runs, it belongs to no workspace, and no API
call can reach it again. Silent data divergence with no reconciliation.

### The change

Each block collapses to the call it was wrapping:

```ts
getProjects: async (): Promise<Project[]> => {
  return fetchJson<Project[]>('/projects');
},
```

The now-dead `supabase` / `isSupabaseConfigured` import is dropped.
Rewritten programmatically rather than by hand so none of the five was
missed — a CRLF-aware regex over the shared shape. `supabase` references in
the file: 5 → 0.

### Why this and not "add RLS and keep the fallback"

Even with RLS, the fallback would still be wrong. It silently converts an
authorization decision into a different code path with different semantics,
and it forks the write path into a store the backend cannot see. The
frontend should have exactly one way to reach data.

Supabase is **not** being removed from the project — it remains the cloud
Postgres and Realtime provider. What is removed is the frontend writing to it
directly, behind the backend's back. The browser will still hold a Supabase
client for **Realtime subscriptions**, which are RLS-scoped and read-only.

### Verification

`npx tsc --noEmit` — exit 0.

---

## Test baseline

Established before trusting any "tests pass" claim in this log.

```
Test Files  4 failed | 47 passed (51)
     Tests  35 failed | 720 passed (755)
```

The four failing files — `issueCreation`, `issueLifecycle`, `runApproval`,
`threadCreation` — fail in teardown with
`EBUSY: resource busy or locked, unlink ...\alpha.db`: Windows refusing to
delete a SQLite file whose handle is still open. **These fail identically at
`HEAD` with all Phase 0 changes stashed**, verified by stashing and re-running.
They are pre-existing and unrelated to this work.

`720 passed / 35 failed` is therefore the bar. Any change that moves those
numbers is a regression introduced here.

---

## ALPHA_MODE — one binary, two opposite jobs

**Status:** done
**Files:** `src/config/env.ts`, `src/index.ts`

The same compiled backend runs on Render and inside Electron, and nothing in
the code could tell the two apart. Every difference lived in a person's head,
which is how the packaged desktop build came to ship a backend snapshot with
no RBAC layer in it at all.

```ts
export type AlphaMode = 'cloud' | 'desktop';
export const ALPHA_MODE: AlphaMode = process.env.ALPHA_MODE === 'cloud' ? 'cloud' : 'desktop';
export const IS_CLOUD = ALPHA_MODE === 'cloud';
export const IS_DESKTOP = !IS_CLOUD;
```

Defaults to `desktop`: `npm run dev` behaves as before, and the mode reached by
accident should be the one that assumes least about its environment — cloud
mode binds a public interface.

### G1 — HOST binding

`HOST` defaulted to `127.0.0.1` unconditionally. Render health-checks the
container from outside; a service on loopback answers nothing, and the deploy
is marked unhealthy with no obvious cause.

```ts
export const HOST = process.env.HOST || (IS_CLOUD ? '0.0.0.0' : '127.0.0.1');
```

Loopback stays the desktop default for the original reason: this API spawns
shell commands, and `0.0.0.0` would hand every device on the network a way to
start a run.

### G3 — execution disabled in cloud mode

The cloud process has no working copy, no agent CLIs, no local models, and an
ephemeral disk. `runtimeRefreshService` would rescan the filesystem on a timer
and report "no runtimes" forever — indistinguishable from a real
misconfiguration on a developer's machine. Startup now returns early:

```ts
if (IS_CLOUD) {
  logInfo('Cloud mode: runner, runtime discovery and local scaffolding are disabled.');
  return;
}
```

That covers `reconcileOnStartup`, `ensureCatalogSeed`, `ensureMemoryScaffold`,
`ensureAgentFiles` and `runtimeRefreshService.start()`.

### The local WebSocket is no longer created in cloud mode

`WebSocketServer` broadcasts every run's stage updates to every connected
client, with no token check on upgrade and no workspace filter — the code says
so itself: it "is intentionally not an authorization boundary". True on
loopback, where the only listener is this app's own renderer. On Render the
same socket is public, and that sentence means any browser can watch every
developer in every workspace.

Cloud clients receive the same telemetry through Supabase Realtime, where RLS
applies. `broadcast()` is unchanged and simply iterates an empty client set.

### G2 — CORS wildcard labels

The allowlist was exact-match. Vercel gives every preview deploy a fresh
subdomain, so every preview would be blocked from the API — which reads as a
broken build. `isAllowedOrigin()` now supports `*` as a whole label:

```
https://*.vercel.app   admits alpha-fe-git-xyz.vercel.app
                       rejects evil.attacker.com.vercel.app.evil.com
```

The `*` expands to `[^.]+` — one label, no dots — and the pattern is anchored,
so a suffix match cannot accept a lookalike domain.

### G5 — OAuth callback path

`GITHUB_CALLBACK_URL` defaulted to `/api/github/callback`. The mounted route is
`/api/github/oauth/callback`. With an empty `.env` — this repository's only
ever state — the default applies, so the first OAuth attempt would have
redirected GitHub to a 404. Corrected.

### ALPHA_ORG — pinned, not inferred

```ts
export const ALPHA_ORG = process.env.ALPHA_ORG || 'Capstone-Agentic-AI-Orchestration';
```

Replaces `resolveWorkspaceOrg()`, which counted `githubOrg` across existing
projects. That was circular on a fresh install — a project is needed to resolve
an org, an org to resolve a role, a role to create a project — and the
resulting `undefined` org silently disabled the `no_team` access gate, so every
signed-in account fell through to the `?? 'admin'` default.

Wiring `identityService` to read it is the next change, and is **atomic** with
removing that default: see the note under "Next".

### Verification

`npx tsc --noEmit` — exit 0.
`npx vitest run` — 720 passed / 35 failed, identical to the baseline above.

---

## Next

The role-resolution change is deliberately **one commit, not four**. The system
is currently safe only because two of its checks are broken at once: the
undefined org disables the `no_team` gate, and `?? 'admin'` papers over `admin`
being unreachable through `TEAM_ROLES`. Fixing either alone makes Alpha less
usable, not more —

- pin the org alone, and `Pineapple-2005` (an org member in no team) is locked
  out by a `403` on every request;
- remove `?? 'admin'` alone, and nobody can hold `workspace.manage_members` or
  `agent.manage`, because no team maps to `admin`.

So: pin the org, define the teamless-member outcome, add a real admin path, and
drop the default — together or not at all.

---

## Role resolution — the atomic change

**Status:** done
**Files:** `src/services/identityService.ts`, `src/services/workspaceRegistry.ts`,
`src/config/env.ts`, `src/services/teamAccess.test.ts`

Four edits that had to land together, because the system was only safe while
two of its checks were broken at once.

### 1. `admin` became reachable

`TEAM_ROLES` mapped slugs to `pm`, `dev` and `client`. Nothing mapped to
`admin`, so `workspace.manage_members` and `agent.manage` were capabilities no
member of the organisation could hold. An `admins` entry now exists. It matches
nothing today — the team has not been created yet — which is what ALPHA_ADMINS
is for.

Position in the array carries no meaning: `roleFromTeams` takes the highest
`ROLE_RANK` across all matches, so someone in both `developers` and `admins`
resolves to `admin` either way. Covered by a test.

### 2. ALPHA_ADMINS — a bridge, not the mechanism

```ts
function breakGlassAdmin(login: string): AlphaRole | undefined
```

Checked **before** teams, deliberately. The situations it recovers from include
"reading teams is what broke" — a revoked org approval, a token without
`read:org`, a deleted team — so it must not depend on a team read succeeding.

Empty by default. Clear it once the `admins` team exists.

### 3. `?? 'admin'` removed from `ensureMember`

The single most dangerous line in the permission system: any account this
function had not seen before became a workspace administrator.

It was survivable only because the *other* check was also broken.
`resolveWorkspaceOrg()` returned undefined on an install with no projects,
which made `workspaceOrg && !role` false, which disabled the `no_team` gate,
which meant callers with no role reached `ensureMember` constantly. Two defects
cancelling out — and fixing either one alone makes things worse:

- pin the org alone → `Pineapple-2005`, an org member on no team, is refused on
  every request with no admin able to fix it;
- drop `?? 'admin'` alone → nobody can hold `admin` at all.

`ensureMember` now returns without enrolling anyone when no role is supplied.
`resolve()` then finds no membership and answers 403 — the same response the
caller would have got anyway, without a silent grant on the way.

Verified reachable only via `workspaceContext -> resolve -> listForUser`, which
already refuses `no_team` before this point. `workspaceController` touches
`sqliteService` only.

### 4. The access gate became reachable

```ts
const access = role ? 'granted' : 'no_team';
```

Previously `workspaceOrg && !role`, where `workspaceOrg` was inferred and
usually undefined.

A diagnostic log now distinguishes the two ways a role can be missing, because
the `Identity` type cannot: genuinely no team, versus a token that cannot read
teams at all. The second would refuse an entire organisation as "no team", and
is the failure mode to expect if the org has third-party application
restrictions enabled. The GitHub App in the next change reads teams as an
installation rather than as the user, which removes it.

### Tests

Two tests failed, and both were asserting the defects:

| Test | Asserted | Now |
| :--- | :--- | :--- |
| `grants a fresh install with no projects attached` | `workspaceOrg` is `undefined` | `workspaceOrg` is ALPHA_ORG, role `pm`, granted |
| `grants when GitHub is signed in but the workspace org is unknown` | no teams → `granted` | scenario cannot occur; replaced |

The first was rewritten rather than deleted: the intent it protected — a fresh
install must not be bricked — still matters and now holds for a better reason.
The second's premise no longer exists, so it was replaced with coverage of the
new behaviour.

Four tests added: break-glass grants admin with no teams; a login not in
ALPHA_ADMINS still falls to the team rules; the `admins` team resolves to admin
once it exists; admin outranks a lower role held at the same time.

The file header and the `--- the three that must never be refused ---` marker
were updated too. Both described the old model, and a comment that outlives the
code it explains is worse than none.

### Verification

`npx tsc --noEmit` — exit 0.
`npx vitest run` — **723 passed / 35 failed (758)**.
Baseline was 720 / 35 (755); the +3 is this change's net new tests, and the
failure count is unchanged.

---

## G2 revisited — the wildcard was too generous

**Status:** done
**Files:** `src/config/env.ts`, `src/index.ts`, `src/config/corsOrigin.test.ts`

An automated security review flagged the wildcard matcher after it was
committed. The finding was correct.

### The defect

`https://*.vercel.app` expands to `^https://[^.]+\.vercel\.app$` — one label,
anchored, no dots. The original comment defended exactly that, arguing it could
not be satisfied by `evil.attacker.com.vercel.app.evil.com`.

That reasoning was about the **shape** of the match and never asked the
question that decides trust: **who can obtain a name that matches?**
`vercel.app` is a shared apex. `attacker-exfil.vercel.app` is free, instant,
and available to anyone. So the pattern did not describe an allowlist — it
described every tenant of the platform. With `credentials: true`, any of them
could replay a signed-in user's cookie against this API.

Not yet exploitable, because the default `CORS_ORIGIN` is localhost-only and
nothing sets a wildcard. But it was documented as the way to support previews,
which is worse than a live bug: a footgun handed over with instructions.

### The change

A wildcard remains fine over an apex the operator owns —
`https://*.alpha.example.com` can only ever be issued by them. Over a shared
apex it is accepted only if the literal part of the pattern pins something they
control:

```
https://*.vercel.app                            REFUSED
https://*-app.vercel.app                        REFUSED  (token gesture)
https://alpha-fe-main-*-lloyds-projects.vercel.app   allowed
https://*.alpha.example.com                     allowed  (own apex)
```

Vercel preview URLs end `-<team-slug>.vercel.app`, so pinning the slug puts the
match back behind something an attacker would have to publish under.

Measured as literal alphanumeric characters (fewer than six ⇒ refuse) rather
than by parsing each platform's URL format, because every platform's format
differs and changes. The threshold rules out a bare `*` and a gesture like
`*-app` without pretending to understand the scheme.

A bare `*` is now refused outright rather than silently doing nothing: browsers
reject `*` with credentials anyway, so accepting it only looked like it worked.

Refusals are collected and logged at startup. An ignored pattern would
otherwise show up as a browser CORS error with nothing server-side explaining
that the entry was dropped deliberately.

### Verification

`npx tsc --noEmit` — exit 0.
`npx vitest run` — **731 passed / 35 failed (766)**. Eight new tests in
`corsOrigin.test.ts`; failure count unchanged from the baseline.

---

## The session layer

**Status:** done
**Files:** `sessionService.ts` (new), `sessionContext.ts` (new),
`workspaceContext.ts`, `githubController.ts`, `identityService.ts`,
`config/env.ts`, `index.ts`, `types/express.d.ts`

The change the whole phase was for. Every request now resolves to the person
who made it.

### What was wrong

`workspaceContext` asked `currentIdentity()`, a process-global cached read of
the local `gh` CLI. One process, one human — correct on a workstation, and
meaningless on Render, where one process serves everyone. There is no `gh` in
the container, so every caller resolved to the OS user, and the entire RBAC
layer below was gating on a constant.

The other half was already written and unused. `githubRequestContext.ts` says
in its own comment that it is "populated by middleware once sessions exist".
That middleware did not exist, and `withGitHubIdentity` was called in exactly
one place: inside the OAuth callback, on the token it was about to discard.

### Shape

```
browser --cookie(opaque, httpOnly)--> sessionContext --> workspaceContext --> route
                                            |                   |
                            resolves the session     decides what they may do
                            + withGitHubIdentity()
```

Identity first, authorization second; the order is not interchangeable. On the
desktop `sessionContext` is a pass-through, because identity there is the
machine's `gh` login and a cookie would be ceremony around a settled question.

### What a session holds

The GitHub token never reaches the browser. The browser gets 32 random bytes in
an httpOnly cookie; the token stays server-side, encrypted, replayed per
request on the async call chain. A cookie that leaks is a revocable session. A
token that leaks is every private repository its owner can reach, and it keeps
working after they sign out.

Two properties the tests pin down, both about an attacker holding the database
rather than a live attacker:

- **The stored id is a SHA-256 of the cookie**, so read access to the table
  cannot mint a session — the same reason passwords are not stored either.
  Unsalted deliberately: the input is CSPRNG output, so there is no dictionary
  for a salt to defend against, and a slow KDF would only add latency to every
  authenticated request.
- **The token is AES-256-GCM encrypted** under `ALPHA_SESSION_SECRET`. GCM
  rather than CBC so a tampered row fails to decrypt instead of decoding to
  something plausible.

Cloud mode exits rather than start without that key. A warning is read once and
then lives in a log nobody opens, while the failure it precedes is silent and
permanent.

### The role is resolved once, at sign-in

Per request it would be a GitHub team lookup on every API call — hundreds of
milliseconds on a service whose free tier already cold-starts. Cached on the
session row instead. A team change then takes effect at next sign-in, which is
the right trade for a membership that changes a few times a year.

`fetchTeamsWithToken()` is new: `fetchTeams()` shells out to `gh`, which a
container does not have. Same question over REST, paginated — `per_page` caps
at 100 and this account is already in sixteen teams across six organisations,
so stopping at one page would silently under-resolve roles. `roleForLogin()` is
shared by both paths so they cannot drift.

### The OAuth callback stopped discarding the credential

It returned `{ username, token }`, dropped the token, and redirected to
`/#github_connected=true&username=...` — a name in a URL fragment, which is not
authentication, and which nothing in the frontend read. Both ends were inert,
consistent with `.env` having always been empty: the flow has never once run.

Sign-in with no mapped team is refused before a session exists, and returns to
the app with a reason rather than a bare 403 page.

Added `GET /api/github/session` (who am I, minus the token) and
`POST /api/github/session/logout` (revoke, then clear). Both bypass
`workspaceContext` — running the workspace resolver first would refuse the very
call the browser makes to find out whether it is signed in.

### Cookie attributes, and what each one stops

| Attribute | Stops |
| :--- | :--- |
| `HttpOnly` | an XSS bug reading the session out of `document.cookie` |
| `Secure` | travel over plain HTTP. Omitted on desktop, whose origin is `http://127.0.0.1` |
| `SameSite=Lax` | a cross-site POST carrying the cookie — CSRF defence for every state-changing route at once. Lax not Strict: the OAuth callback returns as a top-level navigation and Strict drops the cookie on exactly that hop |
| `Path=/` | sign-out clearing a different cookie than the API set |

Parsed by hand rather than with `cookie-parser`: one cookie, one place, six
lines — and a dependency here ships in the desktop binary too.

### HOST again — a gitignored .env defeated G1

The cloud smoke test logged `CLOUD mode on http://127.0.0.1:3999`. `dotenv`
loads the repository's `.env`, which sets `HOST=127.0.0.1`, and an explicit
value beats a mode default.

`.env` is gitignored so a real deploy would not have it — but "safe because a
file is absent" holds only until someone copies their env to the server, and
the failure is a health check that times out with nothing explaining it. Cloud
mode now overrides a loopback HOST to `0.0.0.0` and reports why at startup.
Overridden rather than refused: the deploy should come up, and the stale
setting should still get fixed.

### Verification

`npx tsc --noEmit` — exit 0.
`npx vitest run` — **748 passed / 35 failed (783)**. Baseline 720/35; the +28
is this phase's new tests, failures unchanged.

Smoke-tested against a running cloud-mode daemon:

```
GET /api/health                          200   (public)
GET /api/projects          no cookie     401   "Sign in with GitHub to use Alpha."
GET /api/github/session    no cookie     401   "Not signed in."
GET /api/projects          forged cookie 401
log: Cloud mode: runner, runtime discovery and local scaffolding are disabled.
```

The second line is the point of the phase. `/api/projects` previously answered
an anonymous caller with data, because that caller resolved to the OS user and
`ensureMember` had already made them an admin.

### Still open

- Sessions live in SQLite, so on Render they do not survive a deploy or a
  spin-down and everyone signs in again. Inconvenient rather than broken, and
  it goes away with the Postgres store; `sessionService` is deliberately small
  so that is a driver swap.
- `sqliteService` still opens the database at import time, so cloud mode
  touches SQLite before the mode guard can run — visible as memory scaffolding
  written during the fail-fast test. That is the module-shape problem the
  store-driver work exists to fix.
- Still OAuth-App tokens, which do not expire. GitHub App user tokens expire in
  8 hours and need refresh; the session row has somewhere to put that.

---

## Closing the loop — the browser can now sign in

**Status:** done
**Files:** `dataController.ts`; frontend `apiService.ts`, `types/index.ts`,
`App.tsx`, `SignIn.tsx` (new), `DeveloperGateway.tsx` (new)

The session layer made the API refuse anonymous callers. The frontend had no
way to stop being one, so cloud mode was a closed loop: the backend answered
401 to everything and the browser could not authenticate.

Two causes, each individually fatal:

1. **`fetch` never sent the cookie.** No `credentials` option, and the browser
   omits credentials cross-origin unless asked — which Vercel-to-Render always
   is. Every request arrived anonymous no matter who was signed in.
2. **`/me` answered from `currentIdentity()`.** The same defect as
   `workspaceContext`, one level up: in a container that is the OS user, so the
   browser's "who am I" would have returned the same person for everyone and
   the UI would have drawn their role.

### `/me` is now the sign-in probe

Mode-aware: the session in cloud, `gh` on the desktop. Always 200, never 401 —
this is the call the app makes on boot to find out *whether* it needs a
sign-in, and an error status would put that answer on the failure path, where
the existing caller already swallows it. `authenticated: false` is a fact about
the caller, not a failure to read one.

When OAuth is unconfigured the response carries no `signInUrl`, and the screen
says so rather than rendering a button that cannot work — a dead button reads
as a bug in the app instead of a gap in the deployment.

### Two new gates

**`SignIn`** — web only; the desktop resolves identity before its window opens,
so `authenticated` is never false there. Not a form: Alpha has no passwords and
no user table. A person is their GitHub account and their role is their team.

It renders the reason a previous attempt bounced, read from the redirect
fragment (`#alpha_error=no_team|oauth_failed`). A fragment rather than a query
string because it never reaches the server and so never lands in an access log
or a `Referer` header. Read once and cleared, so a refresh does not re-show an
error already resolved.

**`DeveloperGateway`** — a developer who signs in to the web app. Their tools
need a checkout and the AI CLIs on their own machine; a browser tab has
neither. The honest answer is a signpost, not a degraded workspace. Their
session stays valid and the desktop app finds the same account.

Gated on `role === 'dev' && !isDesktop`, where `isDesktop` comes from the
Electron preload bridge that already exposed `window.alphaDesktop.isDesktop`.

### Verification

Cloud mode, live:

```
GET /api/me          no cookie   200  {"authenticated":false}
GET /api/projects    no cookie   401
log: HOST was set to "127.0.0.1", which in cloud mode would accept no traffic
     from outside the container ... Bound 0.0.0.0 instead.
```

That last line is the HOST override from the previous commit firing correctly —
the earlier smoke test bound loopback because the gitignored `.env` won.

Desktop mode, unregressed:

```
GET /api/me          200  {"authenticated":true,"login":"LloydLim1",...}
GET /api/projects    200
log: DESKTOP mode ... WebSocket Live Stream Server listening
```

`npx tsc --noEmit` both repos — exit 0.
`npx vitest run` — 748 passed / 35 failed, unchanged.
`npm run build` (frontend) — 917 kB, builds clean.

### Not done yet

The gateway's download link points at `/api/download/desktop`, which still
serves a stale 333 kB source zip rather than the 86 MB installer, and requires
no authentication. Fixing that needs a published GitHub Release and an
authenticated proxy — see the blockers recorded against the gateway in the
hosting plan.

---

# Phase 1a/1b — Supabase schema and RLS

**Status:** done (migrations written and tested; not yet applied to a project)
**Files:** `supabase/migrations/0001_control_plane_schema.sql` (new),
`supabase/migrations/0002_row_level_security.sql` (new),
`src/services/rlsPolicies.test.ts` (new)

No Supabase schema existed. `supabaseService` has been upserting into
`prototype_runs` and `issues` for months against tables that were never
created, swallowing every error into `logError` — so cloud persistence has
silently done nothing while looking healthy.

## 20 tables, not 24

The three-way split from the hosting plan, made concrete. `allowed_paths`,
`runtimes`, `thread_sessions`, `meta` and `local_project_bindings` are absent
on purpose: they name paths, PIDs, binaries and session files, which are facts
about one machine. `C:\Code\checkout` means nothing on another developer's Mac.

Identifiers stay `text`. The application mints `member-<uuid>` and
`ws-default`, and changing that is a different change from moving the storage.
This is also why `auth.uid()` is unused — it casts to uuid, and Alpha's subject
is a GitHub login.

## RLS is the security boundary, not defence in depth

The desktop talks to Postgres directly, because proxying every board action
through Render means a thirty-second cold start on the first one. So a
developer's machine holds a token that reaches the database, and the Express
authorization checks are not in that path. The policies are what stands between
one developer's session and another's conversations.

Claims contract: `sub` (login), `workspace_id`, `alpha_role`. The role travels
in the token rather than being read from `workspace_members` per row — a
membership lookup inside a policy runs once per row, and the token is already
minted from a session that resolved the role at sign-in.

### The privacy line, as policy

| | |
| :--- | :--- |
| `chat_threads`, `chat_messages`, `agent_calls` | owner only, **no overseer bypass** |
| `agent_call_artifacts` (patches) | owner **or** pm/admin |
| `prototype_runs`, `squad_runs` | owner **or** pm/admin |
| board (`projects`, `issues`, `agents`, …) | any workspace member; clients excluded from issues |
| `remote_actions` | insert + select only — no update or delete policy exists |

A PM sees the work and not the thinking that produced it. The audit log's
missing update/delete policies are the feature: with RLS on, an operation with
no policy is denied, and an actor who can rewrite their own audit trail is not
audited.

`chat_threads.owner_id` is new. In SQLite the table has only `workspace_id`,
which is why `GET /chat/threads` returned every thread in the workspace to
every member — there was no column to filter on, so the filter was never
written.

## RLS composes through subqueries

The one real bug, found by running the policies rather than reading them.

`agent_call_artifacts` deliberately grants **more** than its parent
`agent_calls`: a PM must be able to review a patch without reading the prompt
that asked for it. The first version expressed that as

```sql
exists (select 1 from agent_calls c where c.id = ... and (... or alpha.is_overseer()))
```

which cannot work. **RLS applies inside a policy's own subqueries**, so that
lookup runs under the caller's access to `agent_calls` — none, for a PM, by the
policy immediately above it. The subquery returned no row and the grant
silently never fired.

The policy read correctly. It granted nothing.

Fixed by denormalising `workspace_id` and `owner_id` onto the artifact, so the
decision needs no parent read. The general rule, now written in both files:
**a policy may only widen access beyond its parent if it can decide without
reading that parent.**

`chat_messages` joins to `chat_threads` and is fine, because there the child's
visibility is meant to equal the parent's. It is only the widening case that
breaks.

## Tested behaviourally, as an unprivileged role

`src/services/rlsPolicies.test.ts` runs both migrations against PGlite —
Postgres compiled to WebAssembly, with the real planner and the real policy
machinery — seeds two developers, a PM and a client, and asserts what each can
reach. Superusers bypass RLS, so the tests `set role` to an unprivileged role
first; without that they would all pass and prove nothing.

14 tests. The one that matters most: a second developer reading the first's
`chat_threads` returns zero rows.

## Verification

Both migrations apply cleanly: 20 tables, 20 with RLS enabled, 37 policies,
none unprotected.

`npx tsc --noEmit` — exit 0.
`npx vitest run` — **762 passed / 35 failed (797)**. Baseline 720/35.

## Not done

- The migrations have not been applied to a real Supabase project.
- Nothing mints the JWT yet. The session cookie is opaque by design; the token
  these policies read is a separate short-lived one, derived from a session —
  that endpoint is the next piece.
- `supabaseService` still writes with the anon key and no claims, so it will
  now be *correctly* denied by RLS rather than silently failing against missing
  tables. It needs the token before it can work.

---

## 1c — Database tokens

**Status:** done
**Files:** `supabaseTokenService.ts` (new), `supabaseTokenService.test.ts` (new),
`dataController.ts`, `config/env.ts`, `rlsPolicies.test.ts`

The policies in `0002` read three claims. Nothing produced them, so
`supabaseService` was writing with a bare anon key and would now be *correctly*
denied by RLS rather than silently failing against missing tables. Better, but
still not working.

### Deliberately not the session

The browser's session is an opaque cookie and the GitHub token behind it never
leaves the server. But the desktop talks to Postgres directly, and the web app
subscribes to Realtime directly, and neither can present a cookie to Supabase.

So this is a second, different credential minted from a session:

| | session cookie | database token |
| :--- | :--- | :--- |
| lifetime | 7 days | 10 minutes |
| revocable | yes, server-side row | **no** — nothing checks a blocklist per row read |
| holds | nothing but an id | the three claims the policies read |

Un-revocable is why it is short. Its lifetime is the only bound on a leaked
one.

Claims come from `req.workspace`, which the middleware already resolved, so a
caller cannot choose them. Asking for a token for a workspace you do not belong
to fails earlier, in `workspaceContext`.

### `role` and `alpha_role` are different claims

PostgREST reads `role` to decide which Postgres role to run the request as, and
rejects anything but `authenticated` or `anon`. Alpha's own role could never
have shared that name — one claim cannot mean both "which database role" and
"pm or dev". This is why the policies read `alpha_role`, and there is now a
test asserting both are present and distinct.

### The contract is tested from both ends

`rlsPolicies.test.ts` previously fed the policies hand-written claims, which
proves the policies work but not that anything emits claims in that shape. A
name drifting between the service and the migration would not fail loudly — the
policy reads `null` and denies everything, or matches a row it should not.

Three tests now decode a genuinely minted token and hand the policies exactly
what the server would send.

One of those failed first, and it was the test that was wrong: it asserted a
second developer sees zero threads, but that developer owns one, so the correct
answer is one — his own — plus zero of the other developer's. Asserting zero
would have been asserting the policy was broken.

### Verification

`npx tsc --noEmit` — exit 0.
`npx vitest run` — **773 passed / 35 failed (808)**. Baseline 720/35.

### Still open

`supabaseService` does not yet use the token: it holds a client built with the
anon key at construction. Pointing it at `/database/token` is the next change,
and is what finally makes cloud persistence do something.

---

## Chat ownership — closing the leak in the code that actually runs

**Status:** done
**Files:** `sqliteService.ts`, `models/index.ts`, `chatController.ts`,
`index.ts`, `chatOwnership.test.ts` (new)

The sequencing was backwards. RLS protects a Postgres database nothing talks
to yet, while the desktop app — the one people run today — still returned every
thread in the workspace to every member:

```ts
res.json(workspaceRegistry.scope('chat_threads', sqliteService.getChatThreads(), ...))
```

`SELECT * FROM chat_threads WHERE workspace_id = ?`. No owner column existed,
so there was nothing to filter on and the filter was never written.

### `owner_id`, and what an unowned row means

Added through the existing `additions` migration table. Nullable, because
`ADD COLUMN` cannot be `NOT NULL` without a default and there is no sensible
default for "who wrote this".

That leaves legacy rows with no owner, and the tempting read is
`owner_id = ? OR owner_id IS NULL` — which would have reinstated the exact leak
being closed, with every pre-existing thread visible to everyone.

So unowned is **not** public. Legacy rows are claimed once at startup by
`claimUnownedThreads()`, which is correct on the desktop for the reason the
whole mode split exists: one process, one person at one keyboard, so every
thread on this machine is theirs. A cloud database has no legacy rows. The
claim only touches `owner_id IS NULL`, so it can never transfer ownership.

It runs after `currentIdentity()` resolves, because the login is not known
until `gh` answers.

### The owner comes from the middleware, never the body

```ts
sqliteService.createChatThread({ ...req.body, ownerId: req.workspace!.userId })
```

A client that could name its own `ownerId` could attribute a thread to someone
else, or read one by claiming to own it.

### Same rule, enforced twice, on purpose

The desktop reaches Postgres directly, so this Express check is not in that
path — which is why `0002_row_level_security.sql` states the rule again. The
two do not share code and cannot be kept in step by a type, so each has its own
test: `chatOwnership.test.ts` here and `rlsPolicies.test.ts` there.

`getChatThreads()` keeps its unscoped form for internal callers resolving a
single thread the controller already authorised. Nothing on a request path uses
it, and a test pins that the unscoped call still sees everything so the
distinction stays visible rather than becoming an accident.

### Verification

`npx tsc --noEmit` — exit 0.
`npx vitest run` — **781 passed / 35 failed (816)**. Baseline 720/35.
