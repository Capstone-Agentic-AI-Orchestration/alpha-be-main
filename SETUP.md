# Alpha — manual setup

Everything that cannot be done from the codebase. Ordered by dependency: each
step needs something from the one before it.

Roughly 45 minutes end to end, most of it waiting for builds.

---

## 0. Push the branches

Render and Vercel deploy from GitHub, so nothing reaches them while the work
sits on a local branch.

```bash
cd alpha-be-main  && git push -u origin feat/phase-0-auth-and-hosting
cd alpha-fe-main  && git push -u origin feat/phase-0-auth-and-hosting
```

Open a PR into `main` on each, or point the hosts at the branch. Deploying from
a branch is fine for now and keeps `main` clean until the first deploy works.

---

## 1. GitHub teams — 5 minutes

Roles come from team membership in
`Capstone-Agentic-AI-Orchestration`. No team means no access, by design.

| Do | Why |
| :--- | :--- |
| Add **Pineapple-2005** to a team | They are in the org but on no team, so every request returns 403 |
| Create a team named **`admins`** | Nothing currently maps to the `admin` role, so `workspace.manage_members` is unreachable |
| Add yourself to `admins` | Then `ALPHA_ADMINS` can be deleted |

The slug must be `admins` or `administrators`. Existing teams that already work:
`developers` → `dev`, `project-managers` → `pm`.

> You are in `project-managers`, not `developers`. PMs currently cannot run
> agents. If you want to demo an agent run from your own account, add yourself
> to `developers` as well — the highest-ranked team wins.

---

## 2. GitHub App — 10 minutes

**One App, not an OAuth App.** A GitHub App does the same login flow *and*
adds webhooks, org permissions, and a server identity. The login endpoints are
identical, so `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` take an App's
credentials unchanged.

`github.com/organizations/Capstone-Agentic-AI-Orchestration/settings/apps`
→ **New GitHub App**

```
Name                                          Alpha
Homepage URL                                  https://<vercel-app>.vercel.app
Callback URL                                  https://<render-app>.onrender.com/api/github/oauth/callback
Request user authorization (OAuth) on install ✓ CHECK
Expire user authorization tokens              ✗ UNCHECK          ← see below
Webhook URL                                   https://<render-app>.onrender.com/api/github/app/webhook
Webhook secret                                openssl rand -hex 32
Where can this be installed                   Only on this account
```

The Render URL is not known until step 4. Create the App with placeholders,
then come back and correct both URLs — GitHub matches the callback exactly.

**Permissions**

| Scope | Permission | For |
| :--- | :--- | :--- |
| Repository | Contents — Read & write | branches, commits |
| Repository | Pull requests — Read & write | opening and merging PRs |
| Repository | Actions — Read & write | CI runs, failed-run logs |
| Repository | Issues — Read & write | board sync |
| Repository | Metadata — Read | mandatory |
| Organization | **Members — Read** | **team membership → roles** |

Then **Install** it on the organisation, **All repositories**.

Save: **Client ID**, **Client Secret**, **App ID**, the **private key** `.pem`,
the **webhook secret**, and the App **slug** from its URL.

### Leave token expiry unchecked

With it on, user tokens expire in 8 hours and return a `refresh_token`. The
exchange in `githubService.ts` reads `access_token` and ignores both, so every
session would break after 8 hours with no recovery. Refresh handling is written
but not yet implemented (finding **O6**).

---

## 3. Supabase — 15 minutes

Create a project. Region closest to you; the free tier is fine.

**SQL Editor** → run in order:

```
supabase/migrations/0001_control_plane_schema.sql
supabase/migrations/0002_row_level_security.sql
```

Both are tested against a real Postgres engine, so they apply without edits.
Expect **20 tables, RLS enabled on all 20, 37 policies**.

Verify:

```sql
select count(*) from pg_tables  where schemaname = 'public';               -- 20
select count(*) from pg_tables  where schemaname = 'public' and rowsecurity; -- 20
select count(*) from pg_policies where schemaname = 'public';              -- 37
```

From **Settings → API**, save:

- **Project URL**
- **anon key** — public by design; RLS is what protects the data
- **JWT Secret** — signs the tokens the policies read

> Do not copy the **service_role** key anywhere. Nothing in Alpha uses it and
> it bypasses every policy.

---

## 4. Render — 10 minutes

**New → Blueprint**, connect `alpha-be-main`. It reads `render.yaml`, so the
build command, start command, health check and non-secret variables are already
set. Render prompts for the rest:

```
GITHUB_CLIENT_ID          App Client ID                      step 2
GITHUB_CLIENT_SECRET      App Client Secret                   step 2
GITHUB_APP_ID             App ID (a number)                   step 2
GITHUB_APP_PRIVATE_KEY    the whole .pem, BEGIN/END lines     step 2
GITHUB_APP_SLUG           from the App URL                    step 2
GITHUB_APP_WEBHOOK_SECRET the secret you generated            step 2
GITHUB_CALLBACK_URL       https://<this>.onrender.com/api/github/oauth/callback
SUPABASE_URL              Project URL                         step 3
SUPABASE_ANON_KEY         anon key                            step 3
SUPABASE_JWT_SECRET       JWT Secret                          step 3
CORS_ORIGIN               https://<vercel-app>.vercel.app     step 5
ALPHA_ADMINS              LloydLim1        ← delete once the admins team exists
```

`ALPHA_SESSION_SECRET` is generated by Render. **Do not set `PORT` or `HOST`** —
Render supplies the first and cloud mode resolves the second.

Deploy. Then go back to step 2 and correct the App's Callback and Webhook URLs
with the real Render hostname.

### Check it came up

```bash
curl https://<render-app>.onrender.com/api/health     # {"status":"healthy",...}
curl https://<render-app>.onrender.com/api/projects   # 401 "Sign in with GitHub"
curl https://<render-app>.onrender.com/api/me         # {"authenticated":false,"signInUrl":"..."}
```

A `signInUrl` in the third means the GitHub credentials arrived. The logs
should say `CLOUD mode` and `runner, runtime discovery and local scaffolding
are disabled`.

---

## 5. Vercel — 5 minutes

Import `alpha-fe-main`. `vercel.json` pins the build; nothing to choose.

```
VITE_API_URL            https://<render-app>.onrender.com/api
VITE_SUPABASE_URL       step 3
VITE_SUPABASE_ANON_KEY  step 3
```

Leave `VITE_WS_URL` unset — the raw WebSocket is not created in cloud mode.

Deploy, then put the resulting origin into Render's `CORS_ORIGIN` and redeploy
the API. For preview deploys as well:

```
https://<vercel-app>.vercel.app,https://<project>-*-<your-team-slug>.vercel.app
```

A bare `https://*.vercel.app` is **refused at parse time and logged**.
`vercel.app` is a shared apex — anyone can deploy to it — so that pattern is
not an allowlist, it is every tenant on Vercel, and the API sends credentials.

---

## 6. Verify end to end

1. Open the Vercel URL → sign-in screen with a GitHub button.
2. Sign in → GitHub consent → back to the app.
3. You land on the **PM workspace** (you are in `project-managers`).
4. Sign in as a `developers` member → the **desktop download** page instead.

The board will be **empty and will reset on every deploy**. That is expected
and not yet fixed: `workspaceRegistry` and `sqliteService` still use SQLite on
Render's ephemeral disk. The store-driver change moves them to Postgres.

---

## Troubleshooting

### Everyone is refused with "no team"

Almost certainly the organisation has third-party application restrictions on
and the App is not approved, so `user/teams` returns empty for everyone. Check
the App is **installed on the organisation** with `Members: read`.

The server log distinguishes the two cases:

> `No role for <login> in <org>: 0 team(s) matched. Either they are in no team,
> or this token cannot read org teams.`

One person refused = a genuinely missing team. Everyone refused = the org
setting.

### Sign-in returns to `#alpha_error=oauth_failed`

Callback URL mismatch. It must be exactly
`https://<render-app>.onrender.com/api/github/oauth/callback` — note `/oauth/`
in the path.

### Browser console shows a CORS error

`CORS_ORIGIN` on Render does not include the Vercel origin, or the API has not
been redeployed since it was set.

### The deploy is marked unhealthy

Check `PORT` or `HOST` were not set manually. If `HOST` was set to loopback the
log says so explicitly and binds `0.0.0.0` anyway.

### Cloud writes are rejected

`SUPABASE_JWT_SECRET` missing. The log says so once:

> `SUPABASE_JWT_SECRET is not set, so cloud writes carry no identity and row
> level security will reject them.`

---

## Later, not blocking

**Publish a GitHub Release for `alpha-desktop`.** The 86 MB installers already
exist in `alpha-desktop/release/` from the Sept 6 build, and `release/` is
gitignored because the files exceed GitHub's 100 MB per-file limit for commits.

Until a release exists, `electron-updater` checks against nothing and **no one
ever receives an update**. The developer gateway's download link also still
points at a stale 333 kB source zip; that needs the release plus an
authenticated proxy so a private release can be fetched.

**Once the `admins` team exists**, delete `ALPHA_ADMINS` from Render.

**Before showing a real client**, narrow the OAuth scope by role. A client
signing in to read a specification is currently asked for `repo` — read and
write on all their private repositories.
