# Alpha Backend — Local AI Execution Engine

The daemon that runs Alpha's agents. It detects the coding CLIs installed on this
machine, spawns them against a local repository, parses their event streams into
Alpha's five run stages, and broadcasts progress over WebSocket.

It is **not** a cloud service. It runs on the developer's own workstation, beside
the code the agents edit.

## Other documents

- [DESKTOP_APP.md](DESKTOP_APP.md) — how to install Alpha, sign in, and how it
  keeps itself updated; and, for maintainers, how to publish a release
- [SETUP.md](SETUP.md) — standing the whole deployment up from nothing
- [CONFIGURATION.md](CONFIGURATION.md) — every setting, where it comes from, and
  what breaks without it

## Shipping a change

Your change reaches people in one of two ways, depending on which app they use.

| You changed | Web app (browser) | Desktop app (installed) |
|---|---|---|
| `alpha-fe-main` | Live a few minutes after the PR merges to `main` (Vercel deploys it) | Only after a desktop release |
| `alpha-be-main` | Live a few minutes after the PR merges to `main` (Render deploys it) | Only after a desktop release |
| `alpha-desktop` | Not affected | Only after a desktop release |

The desktop app carries a copy of the frontend and backend taken on the day it
was built. Merging a fix does not change it; publishing a new release does.
Installed copies update themselves on launch and every six hours.

### Every change: branch, PR, merge

1. Branch off an up-to-date `main`: `git checkout main && git pull && git checkout -b fix/short-name`.
2. Commit, push, and open a pull request into `main`.
3. Wait for the checks to pass (`verify`, and on the frontend the Vercel preview).
4. Merge. Never push to `main` directly.

For the web app you are done at step 4. For desktop users, someone then
publishes a release.

### Publishing a desktop release

A release is built on your own machine from the three repositories and uploaded
to [alpha-desktop's releases](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-desktop/releases).
Whatever is on your machine goes into every installed copy, so follow these
steps in order.

#### One-time setup

1. **Folder layout.** The build finds the other repositories by folder name,
   side by side in one parent folder:

   ```
   Alpha-v2/
     alpha-be-main/
     alpha-fe-main/
     alpha-desktop/
   ```

2. **Node.js 20 or newer**, and `git`.
3. **GitHub CLI signed in** with an account that has **write or admin** access to
   `alpha-desktop`: `gh auth login`, then check with `gh auth status`. Read
   access is not enough; the upload is refused.
4. **`alpha-be-main/.env`** with the settings below. The build copies them into
   the installer, so a wrong value here breaks every installed desktop. That is
   what happened in v2.0.11, when a bad Supabase key made everyone's Sync fail.

#### Required environment variables

Put these in `alpha-be-main/.env`, or set them in the terminal you build from.
All of them are public values; they end up inside the installer.

| Variable | Value | Without it |
|---|---|---|
| `ALPHA_ORG` | `Capstone-Agentic-AI-Orchestration` | **The build stops.** The app would refuse to start. |
| `SUPABASE_URL` | `https://gupmckxxaaxlameekihy.supabase.co` | The app runs with no team board or cloud sync. |
| `SUPABASE_ANON_KEY` | the **anon / public** key from Supabase → Project Settings → API (ask an admin if you have no access) | Same as above. A key Supabase rejects **stops the build**. |
| `ALPHA_CLOUD_API` | `https://alpha-fe-main.vercel.app/api` | Signing in with a saved GitHub account, database access tokens, and hosting setup from the desktop all fail. |
| `ALPHAORCH_WORKFLOW_REPO` | `Capstone-Agentic-AI-Orchestration/alphaorch-workflow` | The app refuses to create repositories. |
| `ALPHAORCH_WORKFLOW_REF` | `v1` | Same as above. |

**Never put these in a desktop `.env`:**
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_JWT_SECRET`
- `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_WEBHOOK_SECRET`
- `RENDER_API_KEY` or `VERCEL_TOKEN`

They belong only on the Render service, and anything in this file can end up
readable on a teammate's machine. Also leave `GH_TOKEN` and `GITHUB_TOKEN` unset
in your shell: they override your `gh` login, often with an expired token.

#### Steps

The commands are for Git Bash. The version below is an example; use the next
number after the
[latest release](https://github.com/Capstone-Agentic-AI-Orchestration/alpha-desktop/releases/latest).

```bash
# 1. All three repositories on the latest main, with fresh dependencies.
#    The release builds exactly what is checked out, so a feature branch here
#    ships unmerged code to everyone.
cd alpha-be-main && git checkout main && git pull && npm ci && cd ..
cd alpha-fe-main && git checkout main && git pull && npm ci && cd ..
cd alpha-desktop && git checkout main && git pull && npm ci

# 2. Raise the version. An update is offered only for a higher number.
git checkout -b release/v2.0.20
npm version 2.0.20 --no-git-tag-version
git commit -am "chore(release): 2.0.20"
git push -u origin release/v2.0.20
git tag v2.0.20 && git push origin v2.0.20

# 3. Build and publish. It takes 5 to 20 minutes, much of it with no output.
env -u ELECTRON_RUN_AS_NODE npm run release
```

In **PowerShell**, run step 3 as:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npm run release
```

`ELECTRON_RUN_AS_NODE` is set inside VS Code's terminal and makes Electron behave
like plain Node, which breaks the build. Removing it only affects that terminal.

4. Open a pull request from `release/v2.0.20` into `alpha-desktop`'s `main` and
   merge it, so `main` shows the version that was published.

#### Check the output before you walk away

While it builds, these lines must appear:

```
supabase key:    accepted by the project
baked settings:  ALPHA_ORG, ALPHA_CLOUD_API, SUPABASE_URL, SUPABASE_ANON_KEY, ALPHAORCH_WORKFLOW_REPO, ALPHAORCH_WORKFLOW_REF
runtime check:   Electron Node 20.x, team board connects
Published v2.0.20.
```

If you see `not set:`, `Warning — could not reach … Do not publish this build`,
or `team board FAILS`, the release must not stay up. Fix the setting and publish
a higher version.

Then open the release page and check that:
- it is marked **Latest** and is not a draft
- it has four files: `Alpha-Setup-<v>.exe`, `Alpha-Setup-<v>.exe.blockmap`,
  `Alpha-Portable-<v>.exe` and **`latest.yml`**

Installed copies read `latest.yml` to find the update, so a release without it
reaches nobody.

#### When it fails

| Message | Cause and fix |
|---|---|
| `v2.0.x is already released` | Raise `version` in `alpha-desktop/package.json` to a number that has not been released. |
| `Not signed in to GitHub` | Run `gh auth login`. |
| Upload refused (HTTP 403 or 404) | Your GitHub account has only read access to `alpha-desktop`. Ask an admin for write access, or ask someone who has it to publish. |
| `ALPHA_ORG is not set` | Add it to `alpha-be-main/.env` (see the table). |
| `Supabase refused SUPABASE_ANON_KEY` | Wrong or old key. Copy the anon key again from Supabase → Project Settings → API, and check that `SUPABASE_URL` is the same project. |
| `alpha-desktop/package.json is missing backend runtime dependencies` | Someone added a dependency to `alpha-be-main`. Add the same package, at the same version, to `dependencies` in `alpha-desktop/package.json`, run `npm install` in `alpha-desktop`, and include that change in your release PR. |
| `The staged daemon does not start on Electron's Node` | A backend change breaks on Electron's Node 20. Read the error, fix it in `alpha-be-main` through a PR, then release again. |
| `Frontend build produced no index.html` / `Backend build produced no dist/index.js` | That repository does not build. Run `npm run build` in it to see why; usually `npm ci` was skipped. |
| Electron opens a Node prompt or reports odd errors | `ELECTRON_RUN_AS_NODE` is still set; see step 3. |

More background, including how updating works on installed copies, is in
[DESKTOP_APP.md](DESKTOP_APP.md) §3–4.

## Design constraints

**Alpha stores no AI provider credentials.** Agents run by spawning `claude` or
`codex` — binaries the user installed and signed into themselves. Those
processes authenticate from the machine's own keychain, exactly as they do when
run from a terminal. There is no vault, no token, no OAuth flow.

The same applies to GitHub: all repository operations shell out to `gh`, using
the ambient `gh auth login` session.

Consequence: **this backend is not a trusted server.** In a packaged desktop
build every file it reads is visible to whoever holds the machine, so nothing
secret may live in `.env`. See `.env.example`.

## Requirements

| | |
|---|---|
| Node.js | 20 LTS |
| `claude` | installed and signed in (`claude auth status` exits 0) |
| `codex` | optional, for the OpenAI adapter |
| `gh` | installed and signed in, for GitHub features |
| `git` | on `PATH` |

## Getting started

```bash
npm install
cp .env.example .env      # defaults are fine for local use
npm run dev               # tsx watch on http://127.0.0.1:3001
```

| Script | Does |
|---|---|
| `npm run dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/
  config/       env + execution limits
  controllers/  Express routes (data, run, runtime, github, chat)
  services/     runner, processManager, streamParser, github, sqlite, rateLimiter
  utils/        git helpers, line buffering, logging
fixtures/       real CLI transcripts used by tests
```

Local state lives outside the repo, under `~/.alpha/`: `alpha.db`, `logs/audit.log`,
`memory/`, `runs/`.

* `ALPHA_HOME` — Relocates the whole data directory (defaults to `~/.alpha`). Tests use this to point at a temp dir to isolate state.
* `SQLITE_DB_PATH` — Overrides the database path specifically (defaults to `$ALPHA_HOME/alpha.db`).

## The stream parser, and why it has a fixture

`claude -p --output-format stream-json --verbose` emits JSONL where
`tool_use`, `tool_result`, `text` and `thinking` are **content blocks nested
inside** an `assistant` or `user` message — not top-level event types:

```jsonc
{ "type": "system",    "subtype": "init", "session_id": "…" }
{ "type": "assistant", "message": { "content": [ { "type": "tool_use", "name": "Read" } ] } }
{ "type": "user",      "message": { "content": [ { "type": "tool_result" } ] } }
{ "type": "result",    "subtype": "success", "total_cost_usd": 0.75, "usage": { … } }
```

An earlier version matched on a top-level `type === 'tool_use'` and therefore
dropped **every** event, producing runs that started and never advanced.
`fixtures/claude-stream-sample.jsonl` is a real captured transcript, and
`streamParser.test.ts` replays it. `getUnhandledTypes()` must come back empty —
that assertion is the regression guard.

**When adding a runtime adapter, capture a real transcript first.** Guessing a
schema is what caused the original bug.

## Verified CLI invocations

Flags move between releases; these were checked against the versions noted.

```bash
# claude 2.1.238 — --verbose is REQUIRED with -p + stream-json, or it exits 1
claude -p "<prompt>" --output-format stream-json --verbose \
       --permission-mode acceptEdits --max-turns 25

# codex-cli 0.144.1 — the subcommand is `exec`, not `run`
codex exec "<prompt>" --json --sandbox workspace-write
```

Never pass `--dangerously-skip-permissions` or
`--dangerously-bypass-approvals-and-sandbox`. Both disable the signals the
consent layer reads.

## Safety

Agents execute real shell commands as the current user. Before exposing this
beyond localhost, note two open defects tracked in
`../SUPABASE_AND_HOSTING_PLAN.md` §1.5.4:

* `HOST` defaults to `0.0.0.0`, and **no route has authentication**.
* CORS is hardcoded to `*` in `src/index.ts`, ignoring `CORS_ORIGIN`.

Together those let any device on the network — or any website the user visits —
trigger an agent run. Bind `127.0.0.1`, read the CORS allowlist from the
environment, and require the `X-Alpha-Token` header.
