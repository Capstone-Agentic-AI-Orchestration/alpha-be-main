# Kanban build reliability and wording plan

Audit date: 2026-11-04. Implementation follow-through: 2026-11-05. Status: implemented locally; final validation and release are in progress. The original audit was documentation-only.

This is the focused follow-up to `KANBAN_BOARD_ORCHESTRATION_PLAN.md`. It supersedes conflicting proposals about build controls, status wording, retries and plan revision in that earlier document. It does not replace unrelated implemented board work.

## Outcome and constraints

Give a developer one clear path from an assigned task to a reviewed change, with a useful next action whenever work cannot proceed. Reduce avoidable stops, duplicate runs and destructive restarts. Genuine failures, requested pauses, approval gates and exhausted budgets must remain visible and enforceable.

- PMs manually create, assign and review tasks and post team comments. They cannot prompt AI or invoke agents, including through direct APIs.
- Developers prompt in the board's right-side Alpha panel or task-specific build instructions. Manual comments remain distinct from AI instructions.
- Keep the existing Orchestrator, specialists, role contracts, scoped tools and independent Security & Code Quality review. Do not introduce a second execution engine.
- Keep Chat hidden by default; restoring it later must reach the same task, thread and orchestration records, actions and permissions.
- Keep project tabs on the title row and the yellow attention row removed. Put compact state and actions on the relevant card and drawer.
- No commit, push, release, run mutation or automatic recovery is performed by this planning pass.

## Verified incident and limits

Read-only inspection of the local test profile database, `C:/Users/Lloyd/.alpha-kanban-test/alpha.db`, confirms:

| Task | Current orchestration record | Consequence |
| --- | --- | --- |
| CAP-101 | Cancelled, revision 7 | Historical cancellation is real; it is not an active build. |
| CAP-102 | Cancelled, revision 13 | Its previous build is cancelled, but a new request can still conflict with another task's repository reservation. |
| CAP-103 | Blocked, revision 20; last update 2026-11-04 09:14:03 UTC | Its backend step has exhausted four recorded work attempts. Its unfinished orchestration can reserve the repository even without a live agent process. |

CAP-103 also has three separate prototype runs awaiting approval with no orchestration parent, created at 09:04:48, 09:04:49 and 10:38:13 UTC on November 4. These are not retries recorded inside its original orchestration. The source has a route that can produce such independent retries, but this audit does not establish the actor or exact click that created each record.

Earlier attempt logs distinguish a 900-second hard deadline from a later 120-second quiet-output timeout. The original endpoint edits were archived before retry rather than supplied in that retry's working checkout. Those are execution/recovery problems, not just misleading text.

Local safeguards already implemented before this audit: a 300-second quiet-output allowance for orchestrated execution within the existing 900-second hard deadline; backup and retention of candidate edits on eligible same-task retries; tracked/untracked content hashing; and bounded timeout repair. Earlier focused checks passed 70 tests in six suites, with typecheck/build passing. These are historical local results, not a fresh successful CAP-103 build. The old archived edits have not automatically been restored, and the four-attempt budget has not been reset.

## Source audit: causes to fix first

Paths below are relative to the named worktree. Line anchors describe this dirty local snapshot and can move.

1. **Two execution control paths are exposed for one task.** In `alpha-fe-kanban-board/src/features/issues/TaskDetailDrawer.tsx:390`, the Build tab renders `AgentRunProgress` alongside `TaskBuildPanel`. The former selects a prototype run by issue and exposes legacy retry/cancel controls. `src/app/AppContext.tsx:2237` retries through `apiService.retryRun`. In `alpha-be-kanban-board/src/controllers/runController.ts:423`, the retry endpoint starts a new `runnerService.startRun` with the old agent and plan, without passing orchestration context. It does not delegate to the orchestration retry policy. The direct start route has the same boundary to audit. Non-orchestrated runner execution can follow a different commit/push/PR path. Hiding a duplicate button alone is insufficient.
2. **A specialist outcome can override the parent task.** FE `src/app/AppContext.tsx:1691` excludes squad member outcomes from generic issue completion but does not similarly exclude orchestration members. A member completing can move a task to Review before the parent build is ready. The failure, cancellation and derived inbox paths need the same ownership audit.
3. **Readiness ignores another task's reservation.** FE `src/features/issues/IssuesView.tsx:160` checks this issue's state; `src/features/issues/taskFlow.ts` can advertise Ready to build without knowing another task owns a selected repository. BE `src/services/sqliteService.ts:4323` intentionally treats blocked, paused, approval and recovery states as unfinished repository owners. An empty physical execution-lock table does not make that reservation invalid.
4. **The conflict response loses the actionable owner.** BE `src/services/projectBuildOrchestrator.ts` returns conversational text directing users to Build review instead of a structured blocking task/run and board action. A rejected request is also called blocked, conflating contention with a failed build.
5. **Changing a plan first cancels it.** FE `src/features/board-build/TaskBuildPanel.tsx:189` cancels the old orchestration before requesting its replacement. If planning fails, the previous usable plan is already cancelled.
6. **The planning success message precedes acceptance.** FE `src/app/AppContext.tsx` returns a thread from `startIssueBuild` while the send is still asynchronous; `IssuesView` can announce planning before the server accepts it. Independent clicks can produce distinct requests.
7. **Different projections count different things.** Board column projection, `BuildChip`, progress stages, task next-step copy and prototype events disagree about active, building, completed and cancelled. Stored Review/Done can mask a conflicting build state. A held or blocked run can be counted as building, while a member-driven Review transition can hide it from the count.
8. **Recovery entry points differ.** Same-task retry retains candidate edits, but `orchestrationService.verifyRecoveryCheckpoint`/resume still needs reconciliation with that policy. A generic continue instruction can be shown when task attempts or global budgets prevent continuation. Saved-change inspection is not consistently reachable from the task recovery panel.
9. **Transport failures can look like product state.** `useBuildConversation` treats load failures as private-thread access; `useTaskBuild` can retain an older actionable snapshot and its polling can stop after an unchanged failure; ignored build-status fetch failures can look like no build. Authentication, network errors, stale state and no record must be distinct.

## Wording and action inventory

The following is the audited board/build surface, not a claim that every string elsewhere in Alpha has been reviewed. Implement a final repository-wide search for the same terms and inspect each relevant occurrence before closing the copy phase.

| Current text or behavior | Problem | Replacement or rule |
| --- | --- | --- |
| Ready to build | No cross-task repository readiness or freshness check | No build planned; use **Plan build** when permitted. Show **Waiting for CAP-103** for a verified conflict; **Checking build status** when unknown. |
| Plan a build / Plan a new build | Old cancelled result appears beside an apparently active next step | One primary **Plan build** action, with previous cancelled build under History. |
| Build not started; paused and needs you | Refused request, blocked owner and intentional pause are conflated | **Waiting for CAP-103**; explain its actual state and offer **Open CAP-103**. |
| Use this conversation's Build review tab | Sends users toward hidden Chat | **Open task build** with a direct task/run link. Existing Chat entry resolves to that same record. |
| Planning a build | Can appear before backend acceptance | **Requesting plan** while submitting; **Preparing plan** only after acknowledged acceptance. On refusal show the actual outcome. |
| Nothing building | Can conceal blocked, paused or waiting work | **No agents running**, with separate compact counts for waiting/action-needed work when nonzero. |
| N building | Includes non-executing holds or excludes active parent due to card state | Count unique parent builds actually executing; label **N builds running**. |
| Waiting for your direction | May be a timeout, missing setup or exhausted budget | **Recovering step**, **Setup needed**, **Paused by developer**, or **Recovery limit reached**, based on typed reason. |
| Provide direction to continue | Guidance cannot bypass the fourth-attempt cap | Show the allowed action: guidance for an eligible retry, otherwise **Review saved work** and an explicitly reviewed recovery restart. |
| Ready to continue | No guarantee allowed action, fresh checkpoint or budget | Show only after server validates continuation; disable with the exact unmet prerequisite. |
| Fix and continue | Unclear whether setup, code or approval is needed | **Retry failed step**, **Update setup**, **Provide guidance**, or **Review recovery plan** as applicable. |
| Retry run | Can launch detached work for an orchestrated issue | Remove from managed-task controls. Use the parent's **Retry failed step**; preserve attempt history read-only. |
| Run restarted with a clean workspace | Wrong for retained candidate recovery | Report actual behavior: **Retrying the step with saved, unverified edits** or **Starting from the accepted checkpoint**. |
| Run completed / Completed / 100% | A specialist is not the whole build; report-only work has no PR | **Step finished** for a member; parent-specific completion text. Stage markers represent observed states, not an invented total percentage. |
| Plan → Approve → Build → Review → Pull request | Can mark stages complete for a planning-time cancellation or report-only result | Derive each stage from persisted events/evidence. Exclude inapplicable PR stages for report-only tasks. |
| Built | May imply code exists for an analysis-only task | **Changes ready for review** or **Report ready for review**, according to output. |
| Work passed its checks | Can refer to an old revision or individual attempt | Use only for current accepted scope and validation revision. Otherwise **Validation needed** or **Previous validation**. |
| Checklist N of M with evidence | Old accepted attempt evidence can imply current delivery acceptance | Separate current verified criteria from previous evidence; show invalidated items explicitly. Checklist evidence is not acceptance. |
| Change plan | Currently terminates the previous plan first | **Revise plan**, implemented as a replacement prepared before superseding the old plan. |
| Stop / Cancelled | Pause, user abandonment, revision and process interruption get mixed | **Pause build** when supported; **Stop build** for confirmed terminal stop; **Plan superseded** for revision; **Interrupted** for an unconfirmed process outcome. |
| Cancelled by an authorized project member | Lacks actor, time and reason; cannot explain an automated revision | Show recorded actor/time/reason when known. Preserve unknown historical attribution; do not invent it. |
| Request changes | PM comment/state change differs from AI correction dispatch | PM: **Request revisions** with a team comment. Developer: **Request build changes**, with explicit scoped instructions. |
| Publish | Ambiguous PR versus deployment | **Open pull request** for that operation. Show the repository/branch and final approval before it runs. |
| Done | Can be confused with member completion, PR creation or an unchecked manual move | Reserve for the applicable project review/acceptance policy. Code and non-code tasks have different evidence requirements. |
| Assigned project tasks | Includes unassigned project work | **Project tasks**; retain **Assigned to me** as the separate filter. |
| Send / Leave comment | Can be mistaken for an agent prompt | **Post comment**, marked team-visible. Developer Alpha composer uses **Ask Alpha** or a clearly selected planning action. |
| Manager Agent / Orchestrator / takes about a minute | Exposes internal routing and promises an unverified duration | **Drafting tasks** / **Preparing plan** with factual progress. Internal role details remain available in technical activity. |
| Private conversation after any load error | Network/server failures are mislabeled as authorization | Use access-denied wording only for confirmed authorization results; connection errors get retry and stale-state messaging. |
| Open desktop to plan/approve for every persona | Suggests PMs can invoke AI there | Role-aware hint; PM sees manual assignment/review instructions, developer sees desktop execution instructions. |
| Two-attempt limit with a three-attempt condition | Recovery text can contradict the actual threshold | Generate attempt counts and remaining allowance from the same policy result; distinguish total attempts from automatic repairs. |
| Raw multiline error / environment variable advice | Buries the next step and leaks implementation detail into the default flow | Short cause plus actionable recovery/setup control. Expand technical details on demand; keep audit evidence. |

## Proposed architecture: one lifecycle owner

### 1. Fence all task execution paths first

- Classify managed board tasks server-side. Direct start/retry/cancel/approve endpoints must refuse an orchestration member or managed-task bypass and return its canonical parent/action, subject to access checks. Apply this even to historical or terminal parent records; a new managed build goes through planning.
- Do not silently convert a legacy run or its branches into accepted orchestration evidence. Keep historical records readable and offer an explicit reviewed reconciliation path.
- Show one `TaskBuildPanel` for managed tasks. If attempt details are useful, render them inside its activity/history with no independent execution or publication controls.
- Parent orchestration events/read models own shared task build state. Member events update attempt activity only. Audit socket handlers, refresh hydration, comments, notifications and server paths for conflicting writes.
- Preserve legitimate unrelated legacy behavior only where explicitly outside this managed-task policy. Test the backend boundary rather than relying on hidden UI.

### 2. Use one compact authoritative build summary

Extend the existing build-status/project snapshot rather than polling full transcripts. Include task work status, current orchestration ID/revision, current phase, execution activity, repository ownership, required developer action, allowed actions, freshness and last successful synchronization time. Keep prior run results in History rather than using them as the current action state.

Return structured conflicts containing accessible blocking task ID/key, run ID/revision, actual state, conflicting repositories and allowed next action. A start request waiting for ownership is not itself a failed orchestration. Do not expose private prompts or unauthorized task details in blocker summaries; return a generic restricted-owner explanation when necessary.

All surfaces use this summary: card badge, next-step strip, Alpha panel, header count, timeline and toast. Unknown/loading/stale data never means ready. Mutating requests still revalidate permissions, current issue/spec/run revision and repository reservations atomically; a preflight result is advisory until dispatch.

### 3. Acknowledge and deduplicate requests

Make `startIssueBuild` await an explicit server outcome rather than only thread creation. Represent submitting, accepted, waiting, refused and failed separately. Use a stable idempotency key for one user submission; repeat clicks, reconnect replay and retry after a lost response resolve to its existing request.

Keep task selection and developer instructions visible until acceptance. Do not claim planning started when only a conversation was created. A durable accepted request remains recoverable after reload.

### 4. Offer waiting without requiring cancellation

Default contention UI: **Waiting for CAP-103** with **Open CAP-103**. Add an explicit **Queue plan** option in the subsequent phase, backed by a durable request record. This queue does not mean agents are already running and does not consume execution attempts or hold an empty worktree.

- Reuse the existing coordinator; the in-memory per-working-directory runner queue is not a durable project-build queue.
- Dispatch only when all required repository ownership checks can succeed. Acquire multiple repositories atomically or in a consistent ordered transaction with no partial retained reservation.
- Bind to canonical repository identities and relevant local checkout identities, not project display names alone. Different projects sharing the same repository must conflict correctly.
- Recheck developer execution rights, ownership/access, selected scope and task/spec revisions at dispatch. Changed requirements require review rather than silently running stale instructions.
- Queueing a plan authorizes planning when resources become available. It does not approve a later generated execution plan or open a PR.
- Display waiting reason and queue position only when determinable. Desktop offline/closed means waiting for its executor; do not imply a global cross-device execution guarantee.
- Cancel queue request removes only that request. Never automatically cancel a different task, steal its reservation or delete lock rows because no agent PID exists.

### 5. Revise plans without cancel-first behavior

Prepare and validate a replacement draft while preserving the old usable plan. Supersede atomically with an expected-revision check only after preparation succeeds. Preserve lineage, actor, reason and history. If replacement fails, keep the original plan and offer retry.

Restrict simple revision to an appropriate non-executing state. Revising already-executed scope needs explicit pause/checkpoint handling and invalidation of affected downstream acceptance. Execution approval does not carry to a materially changed plan. Plan revision is not user abandonment and should not create a generic cancellation warning.

### 6. Recover the failed step with evidence and finite budgets

Use typed causes: transient transport/provider, configuration, task code failure, malformed report, repository conflict, explicit pause/stop, interrupted executor and exhausted budget. Choose automatic retry only where the existing policy permits it; communicate what is happening and the remaining allowance. Do not repeat configuration failures as if the code needs rebuilding.

Unify retry and resume worktree preparation. Back up candidate contents before mutation, keep eligible same-task edits, verify accepted checkpoint/branch/task scope, hash tracked and untracked content, and reject changed candidates before launch. Archives produced under the old policy need explicit inspected restoration, not an assumption that retention has restored them. Retained code remains unverified until new checks and acceptance.

For exhausted task attempts, add a **reviewed recovery restart**: show saved diff, failure history, changed condition and proposed remaining steps; require a developer decision; create a linked, separately bounded recovery episode for the failed step. Preserve immutable attempts and cumulative cost/time limits. If a cumulative budget is exhausted, require its existing explicit authorized budget decision; do not reset it by creating an episode.

Keep accepted prerequisites only when their checkpoint and evidence remain valid. Invalidate dependent code/review/validation evidence when changes affect it. Continue through independent Security & Code Quality review and final validation; do not force-accept to unblock a task. Report correction must not create new unsupported evidence or gain file-write permissions.

Use observed tool/process activity to distinguish active work from quiet output where available. Never manufacture heartbeat text to defeat a watchdog. Retain finite idle/hard deadlines and cancellation responsiveness; increasing a deadline alone is not a recovery strategy.

Reconcile executor interruption after reconnect/restart: confirm whether a process remains active, adopt a verified outcome once, or present interrupted recovery. Do not infer success or deliberate cancellation from a lost connection. Release execution resources only after verified process termination and preserve logical ownership until the state machine safely releases it.

### 7. Keep stops intentional and explainable

Store typed stop reason, actor where known, timestamps and superseding/recovery lineage. Show **Stopping** until the backend confirms termination. Failed stop requests reconcile to observed state, not optimistic Cancelled. Respect publishing's existing irreversible-operation boundary; stopping cannot pretend to undo remote changes already made.

A future **Park build and switch tasks** feature is optional, not an initial shortcut: it would need verified process exit, durable checkpoint/backup, explicit ownership release and full base/scope revalidation on resume. Default to queueing or resolving the current owner until that policy exists.

### 8. Preserve privacy, permissions and traffic boundaries

Keep developer prompts private and shared task summaries appropriate for the team. Every direct API and queue dispatch enforces the same developer-only AI boundary and project/agent scope. Recheck authorization for retry, plan revision, recovery restart and PR actions.

Keep raw `log_chunk` streaming local. Current source still emits it locally while broadcasting stage/activity/outcome events separately. Use compact summaries, bounded status updates, cached preflight information and on-demand details; do not add full logs or report blobs to every board poll. Preserve existing audit persistence. Measure request count/payload changes before making an egress claim; this plan cannot prove billing equivalence.

## Proposed user flow

1. PM creates a task, states expected outcome/checklist, assigns a developer and moves it to Todo when ready. Backlog holds captured work not yet selected/ready; moving a card never launches agents.
2. Developer selects a task or bounded set in Alpha, asks questions or drafts tasks, and reviews suggestions before adding them to Backlog. Discussion alone creates no build or shared task.
3. Developer chooses **Plan build**, adds instructions, then sees accepted planning, an exact prerequisite, or **Waiting for CAP-103**. They may explicitly queue planning.
4. Developer reviews the generated plan and chooses **Approve plan and build**. The existing Orchestrator dispatches permitted specialists.
5. The card shows real running/recovering/waiting state. Eligible failures recover automatically within budget. Otherwise the task drawer names the failed step, saved work, cause and allowed action.
6. Current validation and independent review produce **Changes ready for review** or **Report ready for review**. Developer reviews output and explicitly opens a PR when applicable. PM review/acceptance remains a distinct project step; opening a PR does not automatically mean Done.

## CAP-103 recovery plan, not executed by this audit

1. Inspect the four original attempts and the archive under `C:/Users/Lloyd/.alpha-kanban-test/preserved/orchestration-c1c11fee-b17d-4aa7-b697-15f843bee31e/2026-11-04T09-10-28-566Z-backend-submit-message/`, including tracked patch and untracked email-delivery file.
2. Inspect the three detached prototype runs and their branches separately. Identify actual remote actions before offering any approval. Do not merge or adopt them just because their status says awaiting approval.
3. Establish one canonical recovery owner, accepted storage checkpoint, compatible candidate edits, branch/base, required file scope and checks. Ensure no conflicting process can write it.
4. After the reviewed-restart mechanism and guards exist, present a bounded recovery plan for the failed backend step. Preserve original attempts and budgets; obtain the explicit recovery decision required by that mechanism.
5. Continue the dependent frontend work, independent review and validation. Keep PR creation behind developer review. CAP-102 can wait for repository ownership; it need not be cancelled merely to wait.

## Implementation order and exit gates

| Phase | Work | Required gate |
| --- | --- | --- |
| P0: execution ownership | Fence legacy managed-task controls/API paths; parent-only task projection; acknowledged/idempotent starts; structured blocker owner | No detached retry, early Review transition or false planning success in focused integration tests. |
| P1: truthful interface | Shared summary, state-driven copy, actual stage/count rules, historical evidence separation, freshness/error recovery, role-aware actions | Board, drawer and Alpha agree through reload/reconnect; render real run/recovery components in tests and inspect desktop. |
| P2: non-destructive planning | Durable queue requests and atomic plan revision | Double submissions/restarts create one request; failed revision keeps original plan; ownership and approvals remain enforced. |
| P3: reviewed recovery | Unify resume/retention; inspected archive restore; bounded linked recovery episodes; causal stop/interruption records | Resume preserves candidate correctly, budgets cannot be bypassed, and real failure/recovery path passes. |
| P4: delivery verification | Full local developer flow, PM restrictions, measured synchronization traffic | One real task reaches validated developer review and explicitly approved PR path; no forced acceptance or hidden publication. Report unresolved limits. |

Apply changes additively where possible. Older clients may lack blocker summaries; show a useful refresh/update message instead of assuming readiness. Backfill historical stop reasons only from existing evidence. Do not fabricate actor attribution or rewrite cancelled history. Keep shared CI workflow files outside scope.

## Acceptance tests

- CAP-102 with a cancelled historical build and CAP-103 reserving the same repository shows **Waiting for CAP-103**, one task action and an accessible direct link. It never simultaneously claims Ready to build.
- A managed task cannot call legacy direct start/retry/cancel/approve to escape orchestration, including retries of a member or old detached record. The managed path cannot push/open a PR before final approval.
- Completing, failing or cancelling one specialist does not independently move its parent task to Review/Done or create a whole-build success notification. Rehydration and server projection agree.
- Separate issues/projects bound to the same canonical repository conflict correctly; unrelated repositories can proceed. Multi-repository requests do not deadlock or keep partial reservations.
- Double-click, timeout after server acceptance, reconnect replay and desktop restart resolve one request/run. A pending submission does not announce accepted planning.
- Waiting/paused/blocked states are not counted as running; unknown/stale status is not counted as ready. Network errors do not claim a thread is private; confirmed access errors do not leak its contents.
- Polling continues with bounded backoff after a failure even if the previous snapshot is unchanged. A mismatched task/run snapshot cannot expose mutation controls for the wrong run.
- Plan preparation failure preserves the previous plan. Concurrent revision/approve/cancel requests require matching revisions and produce a single valid transition.
- Resume and direct retry both preserve eligible tracked/untracked candidate edits, reject altered hashes/wrong branches/bases, preserve backups and rerun checks. Restoring old archives is explicitly tested rather than assumed.
- Exhausted four-attempt tasks show an inspectable saved-work action, not a disabled promise to continue. Reviewed recovery does not erase attempts or reset cumulative budgets. Guidance cannot broaden paths or remove checks.
- Pause during automatic repair prevents further dispatch. Stop waits for verified termination; lost stop acknowledgment/restart reconciles once. Publishing cannot be falsely undone by cancellation.
- A planning-time cancellation does not mark Approve/Build/Review/PR complete. Report-only completion has no completed PR stage. Invalidated checklist evidence is not current acceptance.
- PM/client/other non-developer personas cannot invoke AI through hidden controls, direct APIs or queued dispatch. They retain authorized manual task/comment/review behavior. Permission revocation before dispatch blocks that request safely.
- Real `AgentRunProgress`, `TaskBuildPanel` and recovery controls are rendered in targeted component tests; drawer tests that mock these components are insufficient coverage for this incident.
- Run focused backend/frontend checks, then desktop visual checks of title-row tabs, compact card state, task drawer and Alpha panel. Do not restart the app over an active process without the user's direction.
- Compare before/after status request volume and payload bytes. Inspect that raw logs stay outside added remote streaming; no claim of unchanged billed egress without measurement.

## Completion definition

The work is complete when one canonical build controls each managed task, all relevant surfaces show the same fresh state, developers can wait/revise/recover without routine cancellation, and local tests plus a real desktop build demonstrate the path. Zero failures or zero human gates is not a valid completion target.

## Implementation follow-through — 2026-11-05

The user explicitly selected implementation of this reliability plan before publication. The local implementation now includes managed-task API fencing, parent-owned issue state, acknowledged and deduplicated durable planning requests, cross-project repository contention, explicit queue removal, atomic unstarted-plan replacement, fresh/stale read models, inspected tracked/untracked archive restoration and bounded reviewed recovery authorizations. Board prompting still enters the existing private chat build path and retains its Orchestrator, specialists, permissions and approval gates.

Current versus historical validation evidence is separated. Build status/counters, task actions, recovery wording and team comments were aligned. Original plan versions and work attempts remain available. A maximum of two reviewed restarts per failed step supplements the existing finite task episode budget; cumulative build age, token and cost policy remain enforced. Queued plans do not approve execution. Park-and-switch remains explicitly optional and is not enabled.

Validation is recorded in the implementation PRs and release notes. The full frontend suite passed 675 tests; backend full-suite validation and desktop release checks are in progress. Do not infer a successful provider-backed application build from unit tests or the presence of a release plan.
