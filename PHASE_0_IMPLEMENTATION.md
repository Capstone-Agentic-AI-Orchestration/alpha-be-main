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
