# Alpha Backend — Local AI Execution Engine

The daemon that runs Alpha's agents. It detects the coding CLIs installed on this
machine, spawns them against a local repository, parses their event streams into
Alpha's five run stages, and broadcasts progress over WebSocket.

It is **not** a cloud service. It runs on the developer's own workstation, beside
the code the agents edit.

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
