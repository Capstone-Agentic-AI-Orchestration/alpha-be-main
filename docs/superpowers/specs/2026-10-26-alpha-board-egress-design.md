# Reduce Supabase Egress from Alpha Board Sync

**Status:** Draft for user review. The approach is selected; implementation has not started.

## Intent

Stop repeatedly downloading the entire shared Alpha board from Supabase while keeping changes visible quickly and allowing a desktop that was offline to catch up safely. The fix should scale with the number of changes, not with the number of open app windows multiplied by the size of every board table.

The user selected the durable change-log approach described below. A separate Supabase project is out of scope: projects in the same organization share the egress allowance, and moving to another organization would add operational work without reducing the traffic itself.

## Current behavior and evidence

- `alpha-fe-main/src/app/AppContext.tsx` calls `syncBoard()` every 60 seconds while the app is visible, and when it becomes visible again. In a shared-board desktop, `syncBoard()` calls `POST /api/board/sync`.
- In that desktop mode, `alpha-be-main/src/controllers/dataController.ts` calls `pullSharedBoard()`. `supabaseBoardSource()` in `src/services/sharedBoard.ts` paginates and downloads every visible row from projects, issues, issue comments, agents, squads, squad owners, squad projects, and project assignments. The app then merges the snapshot into its local SQLite board.
- `issue_comments` has no `workspace_id`; the current source reads it without a workspace filter and relies on the table's RLS policy through the parent issue. Any incremental path must keep that permission check and explicitly scope work to the active workspace.
- The existing private Realtime channel is triggered only by issues and projects. Its trigger uses `realtime.broadcast_changes`, which sends old/new row data. The frontend treats the message as a notice and re-reads through the API, but the desktop handler calls `syncBoard()` and therefore downloads the full snapshot after a board write too.
- Projects, agents, squads, and comments do not all have `updated_at`; timestamp polling would also miss deletes. A durable change record is needed to represent inserts, updates, and deletes consistently.
- The observed row counts were small (for example, 192 comments and 32 issues), while sampled Edge logs showed roughly 477–480 REST requests per board endpoint in the prior 24-hour window. The database reads, rather than Storage downloads, were the main measured source. These request counts are not an exact billing-period total.
- `POST /api/board/sync` has different behavior in the shared-board desktop and cloud GitHub-sync modes. The new incremental path must not change the cloud writer's GitHub synchronization behavior or local-only mode.

## Goals

1. Replace repeated full shared-board downloads with one initial snapshot and small incremental catch-up reads.
2. Keep online changes near real time through the existing private workspace channel.
3. Recover changes after disconnects, app restarts, and missed Realtime messages using a per-workspace cursor.
4. Represent deletes and related-table changes, including comments and workspace bindings.
5. Keep the existing row-level permissions and local merge behavior. Realtime notices must never become a source of row data or authorization.
6. Make the egress reduction measurable through counts of snapshots, delta pages, changed rows, and response bytes, without logging row contents.

## Non-goals and anti-goals

- Do not create another Supabase project or move the database.
- Do not change GitHub import/sync semantics, local-only mode, workspace membership refresh, or the user's board permissions as part of this egress change.
- Do not expose a service-role key in the frontend or bypass the existing workspace and row-level checks.
- Do not broadcast row contents, fetch the full board after every Realtime event, or use timestamps as the only change cursor.
- Do not claim that this restores egress already consumed in the current billing period. It reduces future traffic; plan and quota remediation is a separate operational decision.

## Approaches considered

### A. Realtime notices with full snapshots only at startup or reconnect

Use Realtime to avoid polling during normal operation, but keep a full snapshot whenever a client reconnects or returns after being offline. This is the smallest change and can reuse existing channel infrastructure. It still downloads every table after reconnect and has no durable record of which changes an offline client missed.

### B. Durable change log, Realtime wake-up, and cursor-based catch-up — selected

Record each board change in the same database transaction as the write. Realtime carries only a small workspace change marker. The client asks the authenticated API for changes after its own cursor, applies only affected rows, and advances its cursor after the local update succeeds. Use a full snapshot only when there is no usable cursor or its history has expired. This takes more work, but it handles reconnects and deletes without repeating full reads.

### C. Increase the polling interval or buy more egress

This can reduce immediate request volume or raise the limit, but it leaves the full-table pattern in place and makes changes less timely. It is not the long-term design. A second project in the same organization also does not add an independent egress allowance.

## Proposed design

### 1. Record durable, workspace-scoped changes

Add an append-only change table and a per-workspace counter. Each record should contain only the workspace, a commit-ordered cursor, entity/table name, row ID, operation (`insert`, `update`, or `delete`), and a timestamp for retention and diagnostics. It must not copy row contents.

Database triggers should record changes for all eight tables currently read by `pullSharedBoard()`: projects, issues, issue comments, agents, squads, workspace squad owners, workspace squad projects, and workspace project assignments. For comments, resolve the workspace through the parent issue. If an entity can move between workspaces, record a removal for the old workspace and an addition for the new workspace; otherwise make workspace ownership immutable. A parent issue deletion must not leave comment rows on a client.

The cursor must be safe for catch-up, not just a plain sequence that may be allocated in one order and committed in another. Use a per-workspace counter updated transactionally so writes to that workspace serialize and a client cannot advance past a lower-numbered transaction that commits later. Add indexes for workspace plus cursor and a bounded retention policy. The initial retention default is 30 days; make it adjustable if observed board activity requires a different window.

Any new table reachable through Supabase's Data API must have RLS enabled and policies consistent with the existing workspace access rules. If the change log is read through an API route instead, that route must validate the existing `project.read` capability and workspace context. Changed entity rows must still be fetched through the existing user-scoped, RLS-protected data path.

### 2. Use Realtime only as a doorbell

Keep the private `workspace:<id>:board` channel, but replace full-row broadcasts with a small marker such as the latest workspace cursor. The message tells a client to catch up; it does not contain table rows, row IDs, or data used to update the board directly.

Batch bursts of notices briefly (the current 400 ms frontend debounce is a reasonable starting point) and request the delta page after the last successfully applied cursor. Duplicate or out-of-order notices must be harmless because the client always asks for changes after its stored cursor.

### 3. Add an authenticated incremental read path

Add a shared-board-specific API operation that accepts the active workspace and the client's last cursor, returns a bounded page of change records, and fetches the current values of changed rows through the same user-scoped Supabase client used today. Return explicit delete markers for removed rows. Enforce workspace capability checks and preserve each table's current RLS behavior, including the stricter rules for issues and comments.

Coalesce repeated changes to the same row within a page when safe, then reuse the existing local merge rules in `sharedBoard.ts`. Those rules preserve machine-local project resources and runner-owned fields while applying the team's shared values; incremental updates must not replace them with blind whole-row overwrites.

Apply each page idempotently. Advance and persist the cursor for that workspace only after the corresponding local SQLite changes have committed. Each user/device keeps its own cursor; one device must not advance another device's catch-up state.

### 4. Bootstrap, reconnect, and stale-cursor behavior

For a new client, first read a workspace watermark, then take the full snapshot, then replay all changes after that watermark. This closes the gap where a write lands while the snapshot is being downloaded. Use the same sequence when a cursor is missing, too old for retained history, or invalid for the current workspace.

For a normal reconnect or return to a visible window, fetch only pages after the saved cursor. Realtime is the primary wake-up. Also catch up on channel reconnect and app visibility restoration. Keep workspace membership refresh separate from board synchronization. A lightweight watermark check may be retained as a safety net if operational evidence shows that Realtime reconnect handling alone misses changes; it must not trigger a full snapshot.

### 5. Client changes and rollout

- In `alpha-fe-main/src/app/AppContext.tsx`, route shared-board clients through the incremental operation on Realtime and reconnect. Stop using the 60-second timer to run a full shared-board pull. Preserve any separate workspace membership refresh and the existing cloud GitHub-sync behavior.
- In `alpha-be-main/src/services/sharedBoard.ts` and `src/controllers/dataController.ts`, add the change source, delta application, cursor persistence, and an additive API path. Keep the existing snapshot route as the bootstrap and recovery fallback.
- The desktop shell consumes the same frontend and local API path; verify its release packaging and minimum supported version during implementation. Older installed desktop builds will continue to use full snapshots until upgraded, so rollout measurements must distinguish old and new clients.
- Deploy the additive database migration and backend support before shipping clients that depend on the new path. Keep the snapshot path available during rollout and for stale-cursor recovery.

## Success checks

- An idle, visible shared-board client no longer downloads all eight tables every minute.
- With no board changes, shared-board sync traffic consists only of channel maintenance and, if retained, a small cursor check; response bytes do not grow with the number of board rows.
- Inserts, updates, and deletes across all eight board tables appear for authorized online clients and are caught up after reconnect or offline time within the retention window.
- A cursor outside the retention window falls back to one correct snapshot and then resumes incremental reads.
- Duplicate notices, repeated pages, and reconnects do not duplicate local rows or skip committed changes.
- A user cannot read another workspace's change records or rows, and a role that cannot read issues/comments does not gain access through the change path.
- Metrics show the number of snapshot and delta requests and bytes per workspace/client version, demonstrating that future Supabase egress falls as expected.

## Calls left to the builder

- Choose the exact cursor and API response types, pagination size, and transaction boundaries after inspecting the current SQLite persistence APIs.
- Confirm the safest storage location for per-device cursors in both browser and desktop flows.
- Implement and validate the per-workspace counter and deletion handling against the actual foreign keys and trigger order.
- Select the exact Realtime broadcast function and migration procedure using the current Supabase documentation at implementation time.
- Confirm old desktop versions and the cloud GitHub-sync branch remain compatible during rollout.

## Review gate

This document describes the design only. Do not add migrations, tables, endpoints, or product code until the user approves this written design. After approval, the next step is an implementation plan.
