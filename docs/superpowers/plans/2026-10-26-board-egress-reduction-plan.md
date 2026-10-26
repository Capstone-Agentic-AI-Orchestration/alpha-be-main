# Reduce Supabase Egress from Alpha Board Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop routine Alpha clients from downloading the full shared board, while keeping online updates quick and reconnects complete.

**Architecture:** Write a compact, workspace-scoped change record in the same database transaction as each board change. Realtime sends only a cursor marker; authenticated clients request bounded pages after their own cursor, and use one full snapshot only for a new or expired cursor. Desktop applies each page into its SQLite mirror using the existing shared-board merge rules; hosted clients apply it to their workspace cache.

**Tech Stack:** TypeScript, React, Vite, Express, Supabase Data API and Realtime, PostgreSQL, SQLite, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-10-26-alpha-board-egress-design.md`

## Global Constraints

- Track `projects`, `issues`, `issue_comments`, `agents`, `squads`, `workspace_squad_owners`, `workspace_squad_projects`, and `workspace_project_assignments`.
- Keep the change log append-only, workspace-scoped, and free of row contents; use a transactionally updated per-workspace counter and a 30-day default retention, pruned at most once per day for active workspaces.
- Keep the existing private `workspace:<id>:board` channel; broadcast only a cursor marker with `realtime.send(..., 'board_changed', topic, true)`.
- Keep RLS enabled for any new public table exposed through the Data API, grant only the needed access, and fetch changed rows through the caller's existing permission path.
- Do not expose a service-role key to a client, create another Supabase project, or alter an already-applied migration; add a new migration and replace the existing trigger function there.
- Keep the explicit Sync button, its GitHub behavior, local-only mode, and workspace-membership refresh. Do not add automatic GitHub polling.
- Store browser cursors per workspace and desktop applied cursors in SQLite; represent PostgreSQL `bigint` cursors as decimal strings in TypeScript.
- Preserve `sharedBoard.ts` merge rules for machine-local resources and runner-owned issue fields.

## Review Focus

- A cursor from another workspace or beyond that workspace's current watermark must be rejected without returning rows; test it in the backend route tests.
- A cursor older than the retained window must request one bootstrap snapshot, then resume from its watermark; test it in the backend route tests and browser sync tests.
- Deletes, workspace moves, and comments whose workspace comes from their parent issue must be applied without leaving stale local rows; test the migration and desktop apply path.
- A role that cannot read issues/comments must not receive their changed rows; test both Postgres route scoping and desktop user-token reads.
- Repeated notices, replayed pages, or a failed local cache write must not duplicate rows or advance a cursor past unapplied data; test desktop and browser page application.

---

## File Structure

### `alpha-be-main`

- Create a Supabase CLI-generated `supabase/migrations/<timestamp>_workspace_board_changes.sql` for the cursor, change log, RLS/grants, eight triggers, retention, and cursor-only Realtime broadcast.
- Create `src/store/postgresBoardChangeStore.ts` for bounded workspace/cursor queries and batch reads of changed Postgres rows.
- Create `src/services/boardChangeSync.ts` for shared cursor/page/bootstrap contracts and source orchestration across hosted Postgres and the desktop's authenticated Supabase client.
- Modify `src/services/sharedBoard.ts` to expose the authenticated Data API source and apply incremental pages using existing merge helpers.
- Modify `src/services/supabaseService.ts` to provide the signed-in Data API source to the sync service.
- Modify `src/controllers/dataController.ts` with `GET /board/bootstrap` and `POST /board/changes`, including capability and workspace checks.
- Modify `src/services/sqliteService.ts` to store the desktop's applied cursor per workspace and apply table-specific removals safely.
- Modify `src/store/testDatabase.ts` to stub `realtime.send()` in the same way it currently stubs `realtime.broadcast_changes()`.
- Create `src/services/boardChangeLog.test.ts` and `src/store/postgresBoardChangeStore.test.ts`; extend `src/services/sharedBoard.test.ts`, `src/services/rlsPolicies.test.ts`, `src/controllers/boardRoutes.test.ts`, and `src/controllers/teamBoardRoutes.test.ts`.
- Create `src/services/boardSyncMetrics.ts` for aggregate-only snapshot/page/row/byte logging.

### `alpha-fe-main`

- Create `src/shared/types/boardSync.ts` for the browser's cursor, bootstrap, change, and page types.
- Create `src/shared/services/boardSync.ts` for idempotent row application and cursor-last browser persistence.
- Modify `src/shared/services/apiService.ts` and `src/shared/services/serverSync.ts` to fetch a bootstrap or cursor pages instead of full project/agent/issue lists when a valid cursor exists.
- Modify `src/shared/lib/storage.ts` so page application can detect a failed synchronous local-storage write.
- Modify `src/app/AppContext.tsx` to use incremental catch-up on hydration, workspace switch, Realtime notice/reconnect, and visibility restore; keep manual Sync separate.
- Create `src/app/boardSyncCoordinator.ts` to debounce notices and serialize catch-up; create `src/app/boardSyncCoordinator.test.ts` for duplicate notices and reconnect behavior.
- Modify `vite.config.ts` to define the client version used for aggregate rollout metrics.
- Create `src/shared/services/boardSync.test.ts` and `src/shared/services/serverSync.test.ts`; extend `src/shared/services/apiService.test.ts` and add focused storage assertions.

### `alpha-desktop`

- Modify `scripts/prepare.mjs` to pass the desktop package version into the renderer build, so server metrics can distinguish installed desktop releases.
- Extend `tests/appearance-prepare.test.cjs` to assert the renderer build receives the version value.

## Interfaces

Use these identical API data shapes in the backend and frontend types:

```ts
export type BoardTable =
  | 'projects' | 'issues' | 'issue_comments' | 'agents' | 'squads'
  | 'workspace_squad_owners' | 'workspace_squad_projects' | 'workspace_project_assignments';

export interface BoardCursor {
  workspaceId: string;
  value: string; // decimal PostgreSQL bigint
}

export interface BoardChange {
  cursor: string;
  table: BoardTable;
  rowKey: Record<string, string>; // primary-key columns; supports composite keys
  operation: 'insert' | 'update' | 'delete';
  row: Record<string, unknown> | null; // null only for delete; inaccessible changes are omitted
}

export interface BoardChangeLogRow {
  cursor: string;
  table: BoardTable;
  rowKey: Record<string, string>;
  operation: 'insert' | 'update' | 'delete';
  createdAt: string;
}

export interface BoardChangeLogPage {
  rows: BoardChangeLogRow[]; // at most `limit`; query one additional row to calculate hasMore
  hasMore: boolean;
  oldestCursor: string | null;
  currentCursor: string;
}

export interface BoardState {
  projects: Project[];
  agents: Agent[];
  issues: Issue[];
}

export interface BoardSyncResult {
  state: BoardState;
  cursor: BoardCursor;
}

export interface ServerSyncResult {
  snapshot: Partial<ServerSnapshot>;
  board: BoardSyncResult;
}

export interface BoardChangePage {
  workspaceId: string;
  nextCursor: BoardCursor;
  hasMore: boolean;
  resetRequired: boolean;
  changes: BoardChange[];
}

export interface BoardBootstrap {
  workspaceId: string;
  cursor: BoardCursor; // watermark read before the snapshot
  projects: Project[];
  agents: Agent[];
  issues: Issue[]; // includes each issue's visible comments
}
```

- `GET /api/board/bootstrap` requires the active workspace and `project.read`; it returns `BoardBootstrap` after reading the watermark and then the snapshot.
- `POST /api/board/changes` requires the active workspace and `project.read`; its JSON body is `{ cursor: BoardCursor, limit?: number }`, with a maximum page size of `100`; it returns `BoardChangePage`.
- The backend returns `400` when `cursor.workspaceId` does not match the authenticated workspace. It returns `resetRequired: true` with no rows when the cursor is ahead of the current watermark or older than retained history. The client ignores that page and bootstraps again.
- A change page advances `nextCursor` to the last scanned log row, even if an existing capability hides that row's data. Coalesce repeated changes to the same `table + rowKey` to the latest operation in the page; fetch current values only for surviving insert/update entries.
- Omit a changed row entirely when the caller cannot read it under current capabilities or RLS; still advance the page cursor past its log record. Return `row: null` only for an authorized delete marker.
- On desktop, `sharedBoard.applySharedBoardChanges(workspaceId: string, page: BoardChangePage): Promise<void>` applies the page to SQLite, then stores `page.nextCursor`. A failure leaves the cursor unchanged so replay is safe.
- In the browser, `applyBoardChangePage(state: BoardState, page: BoardChangePage): BoardState` updates projects, agents, issues, and nested comments by stable IDs. Persist those changed arrays first and `board_cursor:<workspaceId>` last; if any write fails, leave the cursor at its previous value.

---

## Before implementation

Confirm all three checkouts are clean. Keep the backend documentation branch; create one feature branch in each sibling that is still on `main`:

```powershell
# alpha-be-main: remain on codex/alpha-board-egress-design
git status --short --branch

# alpha-fe-main
git switch -c codex/alpha-board-egress

# alpha-desktop
git switch -c codex/alpha-board-egress
```

Expected: no existing work is overwritten, and frontend/desktop implementation commits stay off `main`.

---

### Task 1: Add the durable workspace change log

**Files:**
- Create: `alpha-be-main/supabase/migrations/<timestamp>_workspace_board_changes.sql`
- Create: `alpha-be-main/src/services/boardChangeLog.test.ts`
- Modify: `alpha-be-main/src/store/testDatabase.ts`
- Modify: `alpha-be-main/src/services/rlsPolicies.test.ts`

**Interfaces:**
- Produces `public.workspace_board_cursors(workspace_id, last_cursor, last_pruned_at, retention_days)` and append-only `public.workspace_board_changes(workspace_id, cursor, table_name, row_key, operation, created_at)`.
- The trigger increments `last_cursor` by updating the workspace counter row in the same transaction, so the counter row lock serializes committed changes for that workspace. The first retention value is `30` days; the trigger prunes older log rows at most once per day per active workspace using `retention_days`.
- Each trigger appends the change record and sends `realtime.send(jsonb_build_object('cursor', cursor::text), 'board_changed', 'workspace:' || workspace_id || ':board', true)`; it sends no row, table name, or row ID.

- [ ] **Step 1: Write failing trigger and RLS tests**

Add tests asserting all eight board tables create insert/update/delete records; concurrent writes to one workspace receive ordered committed cursors; rollback removes both the counter increment and log row; moving an entity records a delete in the old workspace and an insert in the new one; comments resolve workspace from their parent issue; the Realtime stub receives only the cursor marker; authenticated users cannot read another workspace's log or cursor.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run from `alpha-be-main`: `npm test -- src/services/boardChangeLog.test.ts src/services/rlsPolicies.test.ts`

Expected: FAIL because the new tables, triggers, and marker function do not exist yet.

- [ ] **Step 3: Create the additive migration file**

Run from `alpha-be-main`:

```powershell
npx --yes supabase migration new --help
npx --yes supabase migration new workspace_board_changes
```

Expected: Supabase CLI creates one timestamped SQL file in `supabase/migrations/`; use that generated filename for the rest of this task.

- [ ] **Step 4: Implement the tables, triggers, RLS, grants, retention, and marker**

Use a non-exposed `alpha`-schema trigger function with an empty `search_path`; revoke direct execution, enable RLS on both public tables, grant authenticated `SELECT` only, and scope reads to `alpha.workspace()`. Do not edit `0012_live_board.sql`; replace its function and add the six missing table triggers in this new migration. Keep the Data API table grants explicit because newly created tables are not automatically exposed in every project configuration. Use the documented [`realtime.send()` signature](https://supabase.com/docs/guides/realtime/broadcast), without creating or altering objects in the locked `realtime` schema.

- [ ] **Step 5: Run migration tests and the local migration audit**

Run from `alpha-be-main`:

```powershell
npm test -- src/services/boardChangeLog.test.ts src/services/rlsPolicies.test.ts
npm run audit:migrations -- --baseline-only
```

Expected: both focused suites pass; the baseline audit reports no historical migration source drift.

- [ ] **Step 6: Commit the schema unit**

```powershell
$migrationPath = (Get-ChildItem supabase/migrations -Filter '*_workspace_board_changes.sql' | Sort-Object Name | Select-Object -Last 1).FullName
git add -- $migrationPath src/services/boardChangeLog.test.ts src/store/testDatabase.ts src/services/rlsPolicies.test.ts
git commit -m "feat: record workspace board changes"
```

---

### Task 2: Read bounded change pages in hosted and desktop modes

**Files:**
- Create: `alpha-be-main/src/store/postgresBoardChangeStore.ts`
- Create: `alpha-be-main/src/store/postgresBoardChangeStore.test.ts`
- Create: `alpha-be-main/src/services/boardChangeSync.ts`
- Modify: `alpha-be-main/src/services/sharedBoard.ts`
- Modify: `alpha-be-main/src/services/supabaseService.ts`
- Modify: `alpha-be-main/src/controllers/dataController.ts`
- Modify: `alpha-be-main/src/controllers/boardRoutes.test.ts`
- Modify: `alpha-be-main/src/controllers/teamBoardRoutes.test.ts`

**Interfaces:**
- `PostgresBoardChangeStore.watermark(workspaceId: string): Promise<string>` and `readAfter(workspaceId: string, after: string, limit: number): Promise<BoardChangeLogPage>` always filter by the active workspace.
- `supabaseBoardChangeSource(client: SupabaseClient): BoardChangeSource` reads the cursor log and current changed rows through that signed-in user's Data API token; it never uses a service-role key.
- `BoardChangeSync.bootstrap(workspaceId: string): Promise<BoardBootstrap>` reads the watermark before the snapshot. `BoardChangeSync.changes(workspaceId: string, cursor: BoardCursor, limit: number): Promise<BoardChangePage>` validates, pages, coalesces, and filters records.
- Register `GET /board/bootstrap` and `POST /board/changes` in `dataController.ts` with the request/response shapes in the plan-level Interfaces section.

- [ ] **Step 1: Write failing store and route tests**

Assert pages are ordered, capped at `100`, and advance to the last scanned cursor; repeated keys coalesce to their latest operation; current values are fetched only for changed rows and remain workspace-scoped; wrong-workspace cursors return `400`; stale/future cursors request reset; callers without `issue.read` receive no issue/comment change entries.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run from `alpha-be-main`: `npm test -- src/store/postgresBoardChangeStore.test.ts src/controllers/boardRoutes.test.ts src/controllers/teamBoardRoutes.test.ts`

Expected: FAIL because the store and routes do not exist yet.

- [ ] **Step 3: Implement the Postgres and signed-in Data API sources**

Batch current-row lookups by table. For issues and comments, keep `workspace_id` filters and the existing issue capability/project scoping; fetch comments through their parent issue. Retain explicit `workspace_id` predicates in the hosted store because its database-owner connection bypasses RLS.

- [ ] **Step 4: Implement bootstrap and bounded-page routes**

Read one row beyond the requested page to set `hasMore`; compare the cursor with the workspace watermark and retained floor; return a reset page without rows when history is no longer usable. Keep `POST /board/sync` unchanged as the explicit Sync path.

- [ ] **Step 5: Run the focused backend tests**

Run from `alpha-be-main`: `npm test -- src/store/postgresBoardChangeStore.test.ts src/controllers/boardRoutes.test.ts src/controllers/teamBoardRoutes.test.ts`

Expected: all page-order, bounds, row-scope, capability, and reset tests pass.

- [ ] **Step 6: Commit the backend read path**

```powershell
git add src/store/postgresBoardChangeStore.ts src/store/postgresBoardChangeStore.test.ts src/services/boardChangeSync.ts src/services/sharedBoard.ts src/services/supabaseService.ts src/controllers/dataController.ts src/controllers/boardRoutes.test.ts src/controllers/teamBoardRoutes.test.ts
git commit -m "feat: serve workspace board change pages"
```

---

### Task 3: Apply desktop pages safely to SQLite

**Files:**
- Modify: `alpha-be-main/src/services/sqliteService.ts`
- Modify: `alpha-be-main/src/services/sharedBoard.ts`
- Modify: `alpha-be-main/src/controllers/dataController.ts`
- Modify: `alpha-be-main/src/services/sharedBoard.test.ts`
- Modify: `alpha-be-main/src/controllers/teamBoardRoutes.test.ts`

**Interfaces:**
- `sqliteService.getBoardSyncCursor(workspaceId: string): string | null` and `setBoardSyncCursor(workspaceId: string, cursor: string): void` use a new SQLite `board_sync_cursors` table.
- `sharedBoard.applySharedBoardChanges(workspaceId: string, page: BoardChangePage): Promise<void>` applies the page with the existing merge-field helpers and stores the new cursor only after every local write succeeds.
- The desktop bootstrap and explicit team-board pull read a watermark before the full pull and store that watermark in SQLite only after the snapshot is applied. The client then replays changes after the watermark and persists its own cursor only after applying each returned page.

- [ ] **Step 1: Write failing desktop apply tests**

Assert duplicate pages are idempotent; delete markers remove the matching shared row and issue comments; a deleted issue leaves no local comments; project `local_path`/`local_dir` resources survive; running issue fields remain runner-owned; and a simulated write failure leaves the saved cursor unchanged.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run from `alpha-be-main`: `npm test -- src/services/sharedBoard.test.ts src/controllers/teamBoardRoutes.test.ts`

Expected: FAIL because SQLite cursor storage and incremental application do not exist yet.

- [ ] **Step 3: Add the per-workspace SQLite cursor and safe row removals**

Create `board_sync_cursors` during SQLite schema setup. Add table-specific removal methods only where incremental delete markers need them; preserve local-only project resources and existing run references.

- [ ] **Step 4: Apply each page with existing merge rules, then save its cursor**

Apply parent rows before dependent inserts and parent deletes before their dependent comments/bindings. Replays must be safe; a failed page must leave the previous cursor so the next request retries it.

- [ ] **Step 5: Run desktop apply and route tests**

Run from `alpha-be-main`: `npm test -- src/services/sharedBoard.test.ts src/controllers/teamBoardRoutes.test.ts`

Expected: all merge, delete, replay, and cursor-order tests pass.

- [ ] **Step 6: Commit desktop mirror support**

```powershell
git add src/services/sqliteService.ts src/services/sharedBoard.ts src/controllers/dataController.ts src/services/sharedBoard.test.ts src/controllers/teamBoardRoutes.test.ts
git commit -m "feat: apply board changes to desktop mirror"
```

---

### Task 4: Add cursor-aware browser hydration and page application

**Files:**
- Create: `alpha-fe-main/src/shared/types/boardSync.ts`
- Create: `alpha-fe-main/src/shared/services/boardSync.ts`
- Create: `alpha-fe-main/src/shared/services/boardSync.test.ts`
- Create: `alpha-fe-main/src/shared/services/serverSync.test.ts`
- Modify: `alpha-fe-main/src/shared/services/apiService.ts`
- Modify: `alpha-fe-main/src/shared/services/serverSync.ts`
- Modify: `alpha-fe-main/src/shared/services/apiService.test.ts`
- Modify: `alpha-fe-main/src/shared/lib/storage.ts`

**Interfaces:**
- `apiService.getBoardBootstrap(): Promise<BoardBootstrap>` calls `GET /board/bootstrap`.
- `apiService.getBoardChanges(cursor: BoardCursor, limit = 100): Promise<BoardChangePage>` calls `POST /board/changes`.
- `fetchServerSnapshot(workspaceId: string, cachedCursor: BoardCursor | null): Promise<ServerSyncResult>` keeps the existing non-board endpoint hydration and uses bootstrap or deltas for projects, agents, and issues.
- `catchUpBoard(workspaceId: string, cachedCursor: BoardCursor | null): Promise<BoardSyncResult>` reads only board-change pages for Realtime, visibility, and post-manual-Sync catch-up; it bootstraps only when the cursor is missing/expired and never calls the other snapshot endpoints.
- `applyBoardChangePage(state: BoardState, page: BoardChangePage): BoardState` upserts/deletes by stable primary keys and updates nested issue comments by `issue_id` and comment ID.

- [ ] **Step 1: Write failing transport, reducer, and persistence tests**

Assert a missing cursor calls bootstrap; a valid cursor calls only the delta endpoint; `resetRequired` performs one bootstrap; duplicate pages preserve one row; delete markers remove rows/comments; and a failed local-storage write does not persist the next cursor.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run from `alpha-fe-main`: `npm test -- src/shared/services/boardSync.test.ts src/shared/services/serverSync.test.ts src/shared/services/apiService.test.ts`

Expected: FAIL because the cursor types, endpoints, and reducer do not exist yet.

- [ ] **Step 3: Add shared browser types and API methods**

Use the exact data shapes in the plan-level Interfaces section; validate cursor workspace IDs before sending them and cap requests at `100` changes.

- [ ] **Step 4: Implement cursor-aware hydration and idempotent persistence**

Use the cached cursor key `board_cursor:<workspaceId>`. Persist each affected board array synchronously before saving the cursor; on any write failure, retain the old cursor so the page replays safely.

- [ ] **Step 5: Run the focused frontend tests and typecheck**

Run from `alpha-fe-main`:

```powershell
npm test -- src/shared/services/boardSync.test.ts src/shared/services/serverSync.test.ts src/shared/services/apiService.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit browser sync services**

```powershell
git add src/shared/types/boardSync.ts src/shared/services/boardSync.ts src/shared/services/boardSync.test.ts src/shared/services/serverSync.test.ts src/shared/services/apiService.ts src/shared/services/serverSync.ts src/shared/services/apiService.test.ts src/shared/lib/storage.ts
git commit -m "feat: hydrate board from workspace cursor"
```

---

### Task 5: Replace automatic full pulls with Realtime catch-up

**Files:**
- Modify: `alpha-fe-main/src/app/AppContext.tsx`
- Create: `alpha-fe-main/src/app/boardSyncCoordinator.ts`
- Create: `alpha-fe-main/src/app/boardSyncCoordinator.test.ts`

**Interfaces:**
- `createBoardSyncCoordinator(catchUp: () => Promise<void>, debounceMs = 400)` exposes `notify()`, `onVisible()`, `onSubscribed()`, and `dispose()`; it serializes catch-up requests and reruns once if a notice arrives during a page fetch.
- Realtime listens for `board_changed`; it ignores marker content and asks the API for changes after the last successfully applied cursor.

- [ ] **Step 1: Write failing coordinator tests**

Assert duplicate/out-of-order notices collapse into one catch-up after `400` ms, a notice during an active catch-up schedules one more run, hidden visibility does nothing, and visibility restoration or channel resubscription catches up once.

- [ ] **Step 2: Run the focused test to verify it fails**

Run from `alpha-fe-main`: `npm test -- src/app/boardSyncCoordinator.test.ts`

Expected: FAIL because the coordinator does not exist yet.

- [ ] **Step 3: Implement the coordinator and wire AppContext**

Replace the desktop Realtime full `syncBoard()` call and web full `getIssues()`/`getProjects()` reread with cursor catch-up. Remove the 60-second `syncBoard()` timer. Keep workspace-list refresh on its own 60-second timer, keep visibility/channel-reconnect catch-up, and keep the manual Sync action on `apiService.syncBoard()`.

- [ ] **Step 4: Run coordinator tests and frontend typecheck**

Run from `alpha-fe-main`:

```powershell
npm test -- src/app/boardSyncCoordinator.test.ts
npm run typecheck
```

Expected: the coordinator tests pass; the workspace-list timer remains, and no automatic path calls `apiService.syncBoard()`.

- [ ] **Step 5: Commit Realtime integration**

```powershell
git add src/app/AppContext.tsx src/app/boardSyncCoordinator.ts src/app/boardSyncCoordinator.test.ts
git commit -m "feat: catch up board from realtime cursor"
```

---

### Task 6: Measure traffic and verify the packaged rollout

**Files:**
- Create: `alpha-be-main/src/services/boardSyncMetrics.test.ts`
- Create: `alpha-be-main/src/services/boardSyncMetrics.ts`
- Modify: `alpha-be-main/src/services/boardChangeSync.ts`
- Modify: `alpha-fe-main/vite.config.ts`
- Modify: `alpha-fe-main/src/shared/services/apiService.ts`
- Modify: `alpha-desktop/scripts/prepare.mjs`
- Modify: `alpha-desktop/tests/appearance-prepare.test.cjs`

**Interfaces:**
- `recordBoardSyncMetric({ workspaceId, clientVersion, kind, changedRows, responseBytes }): void` logs only aggregate values for `snapshot` and `delta` responses; it never logs entity IDs or row bodies.
- The frontend sends `X-Alpha-Client-Version`; web builds use the frontend package version and desktop builds pass the desktop package version to Vite.

- [ ] **Step 1: Write failing metric and packaging assertions**

Assert snapshot/page counts, changed-row count, response bytes, workspace, and client version are present; serialized log output contains no row keys or row values; the desktop renderer build receives the version in `alpha-desktop/package.json` (currently `2.0.67`).

- [ ] **Step 2: Run the focused test to verify it fails**

Run from each repository:

```powershell
# alpha-be-main
npm test -- src/services/boardSyncMetrics.test.ts

# alpha-desktop
npm run test:appearance
```

Expected: FAIL because aggregate metrics and desktop version propagation do not exist yet.

- [ ] **Step 3: Add aggregate metrics and version propagation**

Measure response bytes from the serialized API response. Read only the client-version header for grouping; do not log request bodies, row keys, or row contents. Pass the desktop package version through `scripts/prepare.mjs` while web builds fall back to `alpha-fe-main/package.json`.

- [ ] **Step 4: Run metrics tests and build/package checks**

Run from the indicated repository:

```powershell
# alpha-be-main
npm test -- src/services/boardSyncMetrics.test.ts
npm run build

# alpha-fe-main
npm run build

# alpha-desktop
npm run test:appearance
npm run prepare:build
```

Expected: focused tests pass; both TypeScript builds complete; desktop preparation packages the current renderer and backend and verifies the version marker.

- [ ] **Step 5: Commit measurement and packaging support**

```powershell
# alpha-be-main
git add src/services/boardSyncMetrics.ts src/services/boardSyncMetrics.test.ts src/services/boardChangeSync.ts
git commit -m "feat: measure board sync traffic"

# alpha-fe-main
git add vite.config.ts src/shared/services/apiService.ts
git commit -m "feat: report board sync client version"

# alpha-desktop
git add scripts/prepare.mjs tests/appearance-prepare.test.cjs
git commit -m "build: tag desktop renderer version"
```

---

## Rollout order

1. Merge and deploy the additive database migration and backend endpoints first.
2. Release the frontend and desktop builds after those endpoints are available.
3. Keep bootstrap available for old desktop builds and expired browser cursors.
4. Compare snapshot count, delta pages, changed rows, and response bytes by workspace/client version. Confirm idle clients no longer download all eight tables every minute.
5. Confirm inserts, updates, deletes, reconnects, and the existing manual GitHub Sync path work before removing the old full-snapshot fallback.
