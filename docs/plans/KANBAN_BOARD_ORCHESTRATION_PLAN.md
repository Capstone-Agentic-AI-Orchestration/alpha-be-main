# Kanban Board Orchestration Plan

Status: proposed, not started
Date: 2026-11-03 (revised the same day after a gap review)
Grounded in: alpha-fe origin/main 926a23c, alpha-be origin/main dafbc73

## Goal

Make the project Kanban board the place where a person creates and builds a system with Alpha's agents. The standalone Chat tab gets hidden. The orchestration engine (planner, specialists, validation, review, pull request), the agents, and their permissions stay exactly as they are and run behind the board. Bringing the Chat tab back later must be a flag change with no data or behavior side effects.

Decisions already made in conversation:

1. Orchestration logic stays the same. The board calls the existing engine; it does not get its own copy.
2. Agents, autonomy levels, skills, role capabilities, project agent access checks, path scopes, required checks, and human approval gates stay the same.
3. The Chat tab is hidden, not removed. It must come back cleanly.
4. The orchestration machinery (agent names, handoffs, task graph, 3D scene) is hidden from the board's default view. People see a simple build track and the decisions that need them.
5. A requirements step that writes user journeys, epics, and a feature checklist gives every downstream agent a goal and a checklist to satisfy.

## What the code does today

The board and the chat already share one engine. Every orchestration run is anchored to a board task: StartOrchestrationInput.issueId is required (alpha-be src/services/orchestrationService.ts). When chat starts a build, projectBuildOrchestrator.ts either links the given task or creates one labelled alpha:chat-build.

Chat is the entry point and the decision surface:

- chatService.sendMessage with a buildRequest calls startChatBuild, which calls startProjectBuildBatch (src/services/projectBuildOrchestrator.ts).
- In auto mode, chat routing decides whether a message is a question (answer it), a specialist request (route into plan approval), or a build (start the Orchestrator). Questions never start builds.
- Free-text approvals ("yes, go ahead") are interpreted by a bounded, tool-free model turn (src/services/chatBuildIntent.ts) and then executed by executeOrchestrationDecision. Non-approval messages during a pending decision get an answer instead.

The engine depends on the chat thread more than it first appears. A run stores originChatThreadId, and these features require it:

- CI repair after publication refuses without it: "Open this project in chat before preparing a CI repair." (orchestrationDeliveryRuntime.ts)
- Milestone notices are delivered into the thread and are silently dropped if the thread, its owner binding, or the original build message is missing (orchestrationRecoveryService.flushPendingMilestones).
- Local previews and accepted website previews are scoped to the thread (localPreviewService.ts, acceptedWebsitePreview.ts).
- Recovery bindings record the thread and its owner.
- Model usage is attributed per thread, and attachments are stored per thread (chatAttachmentService).

Chat threads are private. ChatThread.ownerId makes a thread visible only to the developer who started it; project managers see the work without the prompts. Card comments are different: addCommentAndShare (boardWriteThrough.ts) shares them with the team through Supabase.

Decisions have direct endpoints in src/controllers/orchestrationController.ts: start (approve plan), approve (publish), pause, resume, cancel, tasks/:taskId/retry, recovery/actions, audit-plan, plus read endpoints for plans, events, diff, live changes, and delivery. Recovery actions are structured, including provide_guidance with up to 2,000 characters of direction.

The engine has only three build decisions: start, approve (publish), and retry_publication. There is no "change this plan" or "revise these changes" action. In chat, changing a plan today means withdrawing the unstarted plan and asking again.

The board cannot finish a build without chat. In alpha-fe src/features/issues/taskFlow.ts, nextStepFor sends every build decision (plan approval, final review, blocked, paused) to "Open in chat". The "Work on this in chat" handoff (IssuesView.tsx, taskHandoffMessage) also depends on chat.

The plan contract already carries goals and checklists. orchestrationPlanSchema (orchestrationContract.ts) has requirements (REQ ids), 2 to 6 milestones for larger work, and per-task acceptanceCriteria. Specialist reports return requirementCoverage and criteriaEvidence, and the Validation agent checks against them.

The requirements agent exists but is buried. The Manager Agent template (officialAgentTemplates.ts, v5) turns a request into testable requirements and acceptance criteria. The planner assigns it only "for material ambiguity or an explicit requirements step", at most once per plan, and its output stays inside the run. The planner accepts a locked approvedRequirements list, but only for milestone continuations, and passing it forces a single-stage plan with no milestones (orchestrationPlanner.ts).

Permissions differ by action: starting a build needs agent.run, approving a plan needs squad.run, publishing needs build.publish, and recovery control needs squad.run, plus project build access and per-agent project access.

Chat visibility is already partly gated. ROLE_NAV is derived from ROLE_NAV_ALL filtered by AI_FEATURES_BY_ROLE in src/config/features.ts. On main, only the dev role has 'chat' in ROLE_NAV_ALL.

## Core design: each task gets a private build conversation

Every task that gets built has a hidden, private chat thread owned by the developer who started the build. The board talks to the engine through that thread with the same chatService.sendMessage path chat uses today. Decision buttons call the existing decision endpoints with that thread id.

This keeps the orchestration identical, because the engine sees exactly what it sees from chat. CI repair, milestone notices, previews, recovery bindings, attachments, and usage tracking keep working. Developer prompts stay private to their owner, the same rule chat follows today.

ChatThread gets two optional fields: surface ('chat' | 'task', default 'chat') and issueId. The Chat thread list excludes surface 'task' threads. When chat is re-enabled, "Open in chat" on a card opens that task's thread instead of creating a new one.

## Where the developer types

| Place | What the developer writes | What runs underneath |
| --- | --- | --- |
| Board header: "New feature" / "Describe a system" | What they want built, with optional attachments | Feature spec step (Phase 4), then a build through the task thread |
| Epic card: spec editor | Edits to journeys, checklist, exclusions; answers to open questions; "Revise the spec" requests | Manager Agent spec turn, read-only |
| Task drawer: build conversation box | Questions about the plan or changes, "change the plan to…", direction while blocked | chatService.sendMessage on the task thread, the same routing and intent checks chat uses |
| Task drawer: decision buttons | No typing: Approve plan, Publish, Pause, Resume, Retry, Cancel | Existing decision and recovery endpoints, with expectedRevision |
| Task drawer: recovery prompt | Direction when a build is blocked (up to 2,000 characters) | recovery/actions provide_guidance |
| Task drawer: review "Send back" | What to change in finished work | Correction tasks on the same build, through the existing final-validation correction path |
| Project board: "Ask Alpha" | General questions about the project | Private project-level thread in answer-only mode; cannot start a build |
| Card comments | Notes for teammates | Shared with the team; never sent to agents |

## Gaps found and how the plan handles them

1. Builds depend on a chat thread. Without one, CI repair fails, milestone notices disappear, and previews do not start. Fix: the private task thread in the core design.
2. No "change the plan" action exists. Fix: "Change plan" on the card withdraws the unstarted plan and starts a new build on the same task with the developer's feedback added to the request. This matches what chat does today. A first-class revise action in the engine can come later.
3. No "revise finished changes" action exists. Verified: at final review, chat can only publish or answer questions. The engine already plans correction tasks on top of finished work when final validation fails (recovery action plan_final_validation_corrections, category final_validation). Fix: add a human_review recovery category so "Send back" records the reviewer's feedback as evidence and runs that same correction path on the same branch and worktree. The work stays in place, the run keeps its repository lock, and the fixes go through review and validation again.
4. Approved requirements force a single-stage plan. Fix: add a separate approvedSpec planner input that fixes requirement IDs and wording but still allows a milestone roadmap. Do not reuse approvedRequirements.
5. Prompts would leak if they went into card comments, because comments are shared with the team. Fix: prompts live in the private task thread; the card shows outcomes, decisions, and the checklist.
6. A shared card has a private conversation. A second developer opening the card sees status, checklist, and decision buttons, but not the first developer's conversation. Rule: the build owner is whoever started it. Others can act on decisions their role allows (the decision endpoints do not require thread ownership), and the card shows who owns the build.
7. Different actions need different permissions. Fix: the board shows each button from the matching capability (agent.run, squad.run, build.publish) plus project build access, not from the role name. Project managers get a read-only build view.
8. Only one build can be active per project repository. Fix: the card shows "Waiting for PROJ-12 to finish", and "Build all" for epics queues builds instead of starting them together. Chat and board compete for the same lock, which is correct.
9. Milestone notices only reach the thread. Fix: the drawer shows the task thread's build_milestone messages as a short timeline, and the card badge updates when one arrives.
10. Attachments and previews are thread-scoped. Fix: the board composer uploads into the task thread, and the drawer gets a Preview button scoped to it.
11. Developers lose general questions not tied to a task while chat is hidden. Fix: the "Ask Alpha" box on the project board.
12. Free-text approval on the board would be weaker than buttons. Fix: approvals are buttons only, sent with expectedRevision and enabled only once the plan or diff has loaded (the chat equivalent of evidenceReady).
13. The spec goes stale if the card description changes after approval. Fix: version the spec, mark it stale on edit, and require re-approval before the next build.
14. Older desktop releases still say "Open in chat". Fix: ship Phases 1 and 2 in the same desktop release.
15. Builds are desktop-only (IS_CLOUD, ALPHA_ORCHESTRATION_ENABLED). Fix: the web board shows build status read-only with "Open in the Alpha desktop to build".
16. Epics and specs do not sync to GitHub. Keep kind, parentId, and specs in Alpha's data for now; check that GitHub-side edits to a mirrored issue do not overwrite them.

## Phase 0: Setup

Create fresh worktrees from origin/main for both repos. Leave the dirty alpha-be-main and alpha-fe-main worktrees untouched.

## Phase 1: Board can start and finish a build without chat

Backend (alpha-be):

1. Add surface and issueId to ChatThread in both chat stores (SQLite and Postgres) and exclude surface 'task' from GET /chat/threads.
2. Add POST /projects/:projectId/issues/:issueId/build-thread. It returns the caller's private task thread for that issue, creating it if needed, with projectId set.
3. Board builds then call the existing send-message endpoint on that thread with buildRequest.issueId set. No new start path.
4. Make the task description and comments source-aware ("Build requested from the board", no "Follow it in project chat") and add the alpha:board-build label.
5. Add a "change plan" helper that withdraws an unstarted plan and starts a new build on the same task with the feedback added, reusing the existing withdraw and start code.
6. Add the human_review recovery category for "Send back" (gap 3), reusing the final-validation correction planner.

Frontend (alpha-fe):

1. Move the build review components out of features/chat into features/build: BuildReviewTab, OrchestrationDeliveryPanel, OrchestrationRecoveryPanel, LiveChangesView, buildSteps, useProjectLiveBuild. Chat imports them from there; behavior unchanged.
2. In TaskDetailDrawer, replace every open_chat step with inline decisions: Approve plan, Change plan, Review changes, Publish, Send back, Pause, Resume, Retry, and recovery actions.
3. Add the build conversation box and the milestone timeline to the drawer, both reading and writing the task thread.
4. Change nextStepFor so decisions point at the card, keeping open_chat as a secondary action when chat is enabled.
5. Replace "Work on this in chat" with "Build" when chat is hidden.

Done when a developer can take a task from Todo to an opened pull request, including a CI repair, entirely from the board, and the same build is visible in chat (in the task's thread) when chat is enabled.

## Phase 2: Hide the Chat tab behind a flag

1. Add CHAT_TAB_ENABLED (or a per-role map like AI_FEATURES_BY_ROLE) to src/config/features.ts.
2. Filter 'chat' out of ROLE_NAV when it is off, the same way AI_NAV_TABS is filtered. This also stops saved tabs and deep links from opening it.
3. Keep ChatView, its NAV_ITEMS entry, routes, backend chat endpoints, and stores in place.
4. Pass onHandOff to TaskDetailDrawer only when chat is enabled.
5. Suppress or reword chat-specific toasts (for example "Build handoff: X picked up step 2 of 4" in AppContext).
6. Add the "Ask Alpha" box on the project board (gap 11).

## Phase 3: Hide the orchestration on the board

1. Card: one status chip from buildStepFor and a small checklist progress count.
2. Drawer default view: the five-step track (Plan, Approve, Build, Review, Pull request), the checklist, the one decision that needs the person, and a changed-files summary for review.
3. Put agent names, task owners, handoffs, the task graph, raw events, and the 3D scene behind a "Build details" section. Default: available to dev and admin, closed; not shown to pm or client.
4. Write user-facing text in plain product terms ("Checking the work" instead of "Validation agent running").

## Phase 4: Feature spec step (the checklist and journeys agent)

Recommendation: implement it as an upgrade of the existing Manager Agent rather than a new agent. A separate agent would overlap the Manager role and conflict with the planner rule "Assign Manager at most once; do not duplicate requirements".

1. Bump the Manager template to v6 and show it as "Product & Requirements Agent" in the UI. Extend its mission to personas, user journeys including empty, error, and permission states, epics, and a pass/fail feature checklist. Its permissions stay the same: Supervised, no tools, no product code, no added scope.
2. Add a zod-validated featureSpec schema: epic title, personas, journeys (steps), requirements (REQ id, observable behavior, acceptance criteria), exclusions, open questions.
3. Run it as a bounded, read-only structured turn before planning, modelled on interpretBuildIntent, inside the task thread so it stays private and its cost is attributed to the task.
4. Store the spec on the epic card with a version and an approved flag. The developer edits it inline. Open questions block approval until answered or removed.
5. Add approvedSpec to the planner (gap 4): requirement IDs and wording are fixed, milestones remain allowed, journeys and exclusions go into the goal and exclusions. The planner then skips its own Manager task.
6. The checklist ticks from evidence: a requirement passes when specialist requirementCoverage or criteriaEvidence references it and validation passes. Hand-ticked items for human-only work are marked as manual.

## Phase 5: Epics and checklists on the board

Data model (both alpha-be issue stores plus shared types in alpha-fe):

1. Issue.kind: 'epic' | 'task' (default 'task').
2. Issue.parentId for tasks that belong to an epic.
3. A feature_specs table keyed by issue id holding the spec, version, approved flag, approver, and timestamps.
4. Optional subtask fields: requirementId, source ('spec' | 'human'), evidence summary.

Board behavior:

1. An epic card shows persona tags, journey count, and checklist progress.
2. The orchestrator's internal tasks stay internal and show as checklist progress. A card per internal task would expose the orchestration and create a second state machine for the same work.
3. Milestones from a milestone plan appear as sections in the epic's checklist. Child cards per milestone can come later.
4. "Build all" on several epics queues them in spec order (gap 8).

## Phase 6: Describe a system from the board

"Describe a system" runs the spec step in multi-epic mode, shows the proposed epics for approval, and creates them in Backlog. Each epic then follows Phases 4 and 5.

## Egress (Supabase data transfer)

How traffic works today (origin/main): board writes record a small change entry (migration 20261026154619_workspace_board_changes.sql); Realtime sends a cursor-only "board changed" signal on the private workspace channel; every open board then downloads only the changed rows. An issue row carries its description, labels, and the whole subtasks JSON (issueRow in postgresIssueStore.ts), so each issue update is downloaded in full by every open board. Orchestration state (runs, plans, events, diffs, live changes) is stored in local SQLite and served by the local desktop API, not Supabase. Live log lines stay on the local socket, and the cloud run-activity feed is off unless ALPHA_CLOUD_RUN_ACTIVITY is set. Chat messages are uploaded to the owner's private chat tables and are not part of the board change log.

What this plan does to egress:

- No change: the orchestration engine, plan approval, review, recovery, and previews, because the board reads them from the local desktop exactly as chat does.
- No change: task threads and "Ask Alpha", because they use the same owner-only chat sync as chat today. Hiding chat moves these messages; it does not add them.
- Risk: anything that writes to shared board tables during a build, because each write is multiplied by every open board.

Rules that keep egress flat:

1. Card status chips, build progress, checklist ticks, evidence, the milestone timeline, and queue state are read from the local build snapshot. They are never written to shared tables per build event.
2. The shared issue row changes only at coarse transitions it already has today (build started, building, in review, done, pull request link) plus at most one batched checklist summary when a milestone or build finishes.
3. Evidence text stays in the local orchestration data. Shared subtasks carry only the requirement id, a done flag, and a short label, with a size cap.
4. Feature specs live in their own table outside the board change log. The drawer fetches a spec when it opens. Specs save on explicit Save or Approve, never on each keystroke, with a size cap.
5. No mirroring of milestone notices or build events into card comments. Keep the single system comment written when a build starts.
6. "Describe a system" creates its epics in one batch so open boards catch up in one page.
7. Keep ALPHA_CLOUD_RUN_ACTIVITY off by default, and subscribe to run channels only while a drawer showing that build is open.
8. Measure with the board sync counters from the egress work (snapshots, delta pages, changed rows, response bytes) before and after each release.

## Reversibility

| Concern | How it stays safe |
| --- | --- |
| Turning chat back on | Flip CHAT_TAB_ENABLED; ChatView, routes, and APIs were never removed |
| Chat history | Task threads are filtered out of the Chat list; "Open in chat" on a card opens the task thread |
| Duplicate builds | Same send-message and startProjectBuild path, same one-active-build-per-repository rule |
| Existing chat builds | Chat request keys and threads are unchanged |
| Decisions | Board and chat call the same decision and recovery functions |
| Specs and epics | New optional fields and a new table; old tasks read as kind 'task' with no spec |

## Testing

1. Backend: task thread creation is idempotent per user and issue and hidden from the thread list; a board build through the task thread produces the same run as a chat build; CI repair, milestone notices, and previews work for a board build; the change-plan helper withdraws only unstarted plans; approvedSpec keeps requirement IDs and still allows milestones.
2. Frontend: nextStepFor returns board decisions with chat off and keeps open_chat as secondary with chat on; navigation hides and restores chat with the flag; each drawer button appears only with its capability.
3. End to end on the desktop: task to pull request plus a CI repair from the board with chat hidden; the same with chat enabled, confirming the build appears under the task's thread and nowhere else.

## Suggested order

Phases 1 and 2 ship together, because they hide the tab without stranding builds. Phase 3 follows as polish. Phases 4 and 5 ship together, since the spec needs somewhere to live on the board. Phase 6 builds on them.

## Open choices (defaults in use until decided)

1. Build details for dev and admin: available, closed by default.
2. Milestones as checklist sections inside an epic; child cards later.
3. UI name for the upgraded Manager: "Product & Requirements Agent".
4. Whether teammates other than the build owner can read the build conversation: default no, matching today's chat privacy.

## Implementation status (2026-11-04, local and uncommitted)

Worktrees from origin/main on branch feat/kanban-board-orchestration: Alpha-v2/alpha-be-kanban-board and Alpha-v2/alpha-fe-kanban-board. Nothing is committed or pushed.

Built:

- Private board threads (task build thread and project Ask Alpha thread), hidden from the Chat list; Ask Alpha refuses builds server-side.
- Board builds go through the task thread with the unchanged chat build path; build wording says "from the project board".
- Send back: reviewer feedback becomes owner corrections, then a fresh review and validation, on the same branch (new request-changes endpoint, human_review origin on the shared correction path).
- Manager Agent v6 (personas, journeys, epics, checklist); unedited v5 Managers upgrade.
- Feature specs: schema, local storage, draft/revise/edit/approve/remove routes, epic proposals for a whole system.
- Planner approvedSpec input; a stale approved spec blocks the build; approval writes checklist items; publication ticks evidenced items in its existing update.
- CHAT_TAB_ENABLED flag (off); card Build tab with track, checklist evidence, plan approval and change, recovery, review with publish or send back, pause/resume/stop, build conversation, and Build details for dev/admin; spec panel; New feature, Describe a system, Ask Alpha; epic badge; handoff toasts hidden while chat is off.

Differences from the plan:

- Chat build components are imported from features/chat instead of moved; behavior is the same.
- With chat re-enabled, "Open in chat" appears only for builds started from chat; board builds stay on the card.
- "Build all" for epics is not built yet.
- The new frontend folder is src/features/board-build because the repo's .gitignore ignores any build/ folder.

Tests: backend 3,583 pass; the 16 failures are pre-existing on main (admin lacks chat permission in thread-creation and cloud-route tests). Frontend 665 tests: 4 failures, all pre-existing on main. Frontend production build passes. Live backend boot on a throwaway database confirmed the new table, the v6 Manager, and the new routes.

## Simplified board flow (proposed 2026-11-04, not built yet)

Problem: the board header offers New feature, Describe a system, Ask Alpha and New task, with no clear owner. Project managers cannot use the first three (they run the Manager Agent, and only developers run agents), so the header mixes PM and developer actions.

One rule: the project manager decides what to build on the board; a developer starts the Orchestrator from the task.

Project manager:

1. New task is the only way to add work. The dialog has title, description, acceptance checklist (one item per line), priority and assignee.
2. The task starts in Backlog. Moving it to Todo means it is ready and assigned.
3. When the pull request opens the card moves to In review by itself. The PM checks the result against the checklist, then marks it Done or sends it back with a comment (back to Todo).

Developer:

1. Todo cards assigned to them show a Start build button on the card and in the drawer. Dragging to Building does the same.
2. The PM's checklist becomes the build's fixed requirements (reusing the approvedSpec planner input), so every agent works toward that list and the card ticks items from evidence.
3. The Build tab shows the one decision needed: approve the plan, give direction, then review and open the pull request or send it back.

Removed from the board header: New feature, Describe a system, Ask Alpha. The per-task "Ask about this build" box stays. The feature spec panel is replaced by the checklist; the spec backend stays unused for now, and an optional developer-only "Suggest checklist" (Manager Agent) can come later.

Columns: Backlog = not ready yet; Todo = ready for a developer; In progress = a developer working without agents; Building = the Orchestrator is working (set by the build, never by hand); In review = pull request open, waiting for the PM; Done = accepted by the PM.

Needs-you banner: developers see build decisions on their tasks; project managers see tasks waiting in review.

## Consolidated implementation plan — 2026-11-04

This section supersedes the earlier UI proposals and status descriptions where they conflict. It consolidates the current conversation and the local implementation; it does not authorize the optional extensions below. Implementation remains local and uncommitted. A source change is not proof that the running desktop includes it or that an end-to-end build has passed.

### 1. One project workflow

PM creates a task and acceptance checklist → assigns a developer → moves ready work to Todo → developer starts a build → reviews and approves the plan → Alpha builds and validates → developer reviews changes and opens the pull request → PM reviews delivery → authorized acceptance moves the card to Done.

- Backlog: captured work that still needs clarification, priority, or scheduling. It is not a build queue and never starts agents.
- Todo: sufficiently defined work ready for a developer.
- In progress: developer work outside an active agent build.
- Building: an active build, controlled by run state rather than arbitrary card edits.
- In review: published work awaiting the required human review; a PR does not mean accepted delivery.
- Done: accepted work under the existing authorization and review rules.

### 2. Developer-only Alpha panel

Keep one Alpha button opening the right panel. Developers can select a board column and individual cards, ask about that scope, and request task suggestions. Ask remains answer-only. Suggestions are drafts until the developer explicitly adds them to Backlog. Starting orchestration stays an explicit task-level Start build action, followed by the existing plan approval.

Keep the selected scope visible and bounded to 20 tasks. Do not silently operate on other projects, other columns, or unselected cards. PMs use New task, assignment, comments, checklist editing, and review; they have no AI panel, AI suggestions, agent controls, or AI calls. Enforce this on the server as well as in the interface.

The old New feature / Describe a system / Ask Alpha header buttons are replaced by New task and the developer's Alpha panel.

### 3. Clean project layout

Use Board as the main project tab. Move project properties, ground rules, and repositories into Details. Remove the Project details dropdown and implementation-facing orchestration advertisement from the board. Keep the project header compact.

### 4. Preserve orchestration and permissions

Use the existing chat service, private task thread, planner, Orchestrator, specialist agents, review, validation, recovery, repository locks, and publication path. Do not create a second execution engine or expand agent tools, path access, autonomy, or role permissions.

Upgrade the existing Manager Agent for requirements work rather than adding a parallel agent. Keep the standalone Chat tab hidden behind its reversible flag; retain endpoints and history. Check that restoring Chat preserves board thread privacy, run identity, and decisions without duplicate builds. Current implementation keeps board builds on the card when Chat is restored; opening those threads in the Chat screen is not a completed feature.

### 5. Requirements, journeys, epics, and checklists

Retain the local feature-spec implementation: personas, user journeys, epics, exclusions, open questions, requirement IDs, and acceptance checklist. Developers may use the Manager Agent to propose/refine these; PMs can enter requirements manually without AI.

Keep this as a task-level requirements aid, not another competing board entry point. Approved specs constrain planning while retaining milestone support. Requirement edits make approval stale and require review before a subsequent build.

Implemented locally after the user's implementation approval: each open manual checklist item becomes a fixed planner requirement. Its requirement ID hashes the saved item ID and wording; an older build cannot tick edited or replaced work. Completion requires evidence from the latest accepted attempt of every current required task covering the requirement, including a validation task. A pull request opening alone is insufficient. Preserve checklist wording, manual completions, and unrelated items. Refuse checklists over the existing 20-requirement limit instead of silently dropping criteria.

### 6. Task creation and editing boundaries

Use the six existing workflow columns. Agents do not create, rename, or delete columns. Arbitrary custom columns would require coordinated workflow, permission, persistence, GitHub mapping, and migration changes, so they are outside this implementation.

Manager task proposals require a developer's Add to Backlog action. Specialists keep their existing file tools; do not give them unrestricted board editing. Existing orchestration may update status, system activity, requirement evidence, branch, and PR links through its current controlled path.

People with the existing issue-management permission can edit task title, description, assignee, priority, labels, checklist, and allowed status. Do not add comment editing/deletion or automatic agent rewriting of PM requirements in this scope. Per-project column display names remain an optional later proposal.

### 7. Decisions and recovery on the task

The Build tab provides the relevant plan approval/change, progress, guidance, retry, pause/resume/stop, changed files, final review, publish, and request-changes actions. Preserve capability checks and revision checks. Keep raw agent activity and orchestration details out of the default view.

Request changes during developer build review reuses the current correction path on the existing branch, followed by review and validation again. A PM's delivery feedback remains normal task feedback; it does not run agents. A developer explicitly starts the resulting build work.

### 8. Board correctness and data safety

Finish and verify the local fixes for the project-scoped Building count, temporary-to-persisted task ID remapping, and the drawer's displayed Building status. Validate missing/older board state, workspace-switch failures, refresh, reopening a card, failed starts, and reload/reconnect behavior. Show a useful error and preserve records rather than requiring a data reset.

Keep developer prompts in private threads; shared card comments and activity contain only appropriate team-visible outcomes. Validate authorization for thread reads, task writes, approvals, recovery, and publication.

### 9. Egress

Reuse current status synchronization and polling. Keep verbose logs local; do not replicate token streams or raw agent logs to shared storage. Bound scoped task context and fetch detail on demand. Fold checklist/status updates into the existing publication write when possible. Compare requests and payload sizes before claiming egress is unchanged; flat egress is a validation target, not a proven result.

### 10. Validation and local desktop delivery

1. Run focused backend and frontend checks for board scope, permissions, spec/checklist behavior, task identity, state transitions, and build decisions. Separate existing baseline failures from new failures.
2. Complete a real desktop build from an assigned Todo card through plan approval, execution, validation, developer review, and PR publication; confirm the card, branch, and PR links agree.
3. Exercise a blocked build and guidance/retry, request changes, repository contention, and refresh/reconnect without losing or duplicating the run.
4. Verify the PM persona cannot invoke AI directly or through API calls, and can perform the intended manual task/review flow.
5. Verify Chat hidden/restored behavior, private thread isolation, and board/backlog identity and status consistency.
6. Measure synchronization traffic and inspect Board, Details, and the right panel in the desktop app.
7. Before rebuilding/relaunching, check whether a build is active. Do not interrupt an active run without the user's direction. Bundle the latest fixes, relaunch, and verify the installed local build.

No commit, push, merge, deployment, or release publication is authorized by this plan. Do not treat historical test results or the previously running CAP-103 build as fresh verification.

### Not included without a later decision

- Custom columns or per-project column names.
- Bulk Build all / automatic epic execution.
- Removing execution timeouts or retry budgets entirely.
- New agent permissions, PM AI access, or automatic acceptance/Done.
- Backups to new remote repositories, repository visibility changes, rebranding, PDF exports, or release work from other plans.

### Implementation follow-through — 2026-11-04

The user's subsequent "okay do the implementation" authorized the remaining in-scope changes, including manual-checklist linkage. All implementation remains local, with no commit or push.

New changes in this follow-through:

- Added optional Developer instructions to the task's start-build dialog. These accompany the saved task and checklist through the existing build path; they do not replace PM requirements.
- Linked the full saved manual checklist to fixed requirements server-side, independently of the bounded conversation text. Completion is evidence-based and reconciles in the existing PR/status update; replay does not add another write.
- Added the existing project-agent visibility check before Manager Agent drafting or task suggestions.
- Restricted the new request-changes action to callers with agent execution and chat permissions, because it dispatches agent corrections. PMs retain ordinary review feedback; their normal publication capability was not broadened or removed.
- Bounded the Alpha panel to the tasks actually checked, protected against mixing project conversations on project switches, included saved descriptions, and rejected oversized scope rather than silently dropping selected tasks.
- Read-only agent reports now await human review rather than automatically marking the delivery Done. Build completion copy distinguishes an open PR from delivery acceptance.
- Bundled the latest project count, task-ID, drawer-status, Details-tab, and developer prompting changes into the test desktop and relaunched with the remembered developer account.

Verification:

- Backend typecheck and production build passed. Ten focused backend suites passed, 73 tests, covering checklist evidence and edits, planning, thread isolation, PM/admin/client AI refusals, Manager access, correction/review flow, publication replay, and existing capabilities.
- Frontend typecheck and production build passed. Focused frontend checks passed, including task scope, prompt composition, PM restrictions, navigation, task flow, and repository tabs. The full frontend run reported 666 passed and four failures in unchanged ChatHome/OrchestrationDeliveryPanel tests, matching the previously recorded baseline; subsequent focused tests cover the final scope changes.
- Live desktop: verified Board and Details, the absence of the dropdown, project Building count, and the Developer instructions dialog. A real answer-only prompt returned successfully. A real Manager Agent suggestion returned one task with an explicit Add to Backlog button; the unsaved test suggestion was discarded, leaving the shared board unchanged. No new orchestration run was created by either action.
- Desktop startup confirmed team-board connectivity, orchestration enabled, and the remembered developer identity. No executing run was interrupted.

Remaining verification limits: CAP-103 is still blocked from its previous specialist execution timeout (latest attempt reached the 900-second wall-clock limit). This follow-through did not retry it, change timeouts, publish a PR, or establish a fresh successful end-to-end live build. Recovery/correction mechanics were exercised by focused local tests. Checklist reconciliation uses one existing task update, but deployed egress equivalence has not been measured.

### Timeout and retry recovery follow-through — 2026-11-04

Subsequent user requests authorized a guided CAP-103 retry and asked for a way to prevent recurring blocks. The guided retry started correctly but then hit the existing 120-second no-output timer. Its earlier attempt had hit the separate 900-second wall-clock timer. These are different limits; a provider's quiet interval does not establish whether the model is still reasoning or stalled.

Confirmed second cause: before that retry, the adapter saved the previous endpoint edits as a patch and moved the untracked email-delivery file to the profile's preserved folder. It restarted from the accepted storage checkpoint. Thus the retry's report that the endpoint was absent was consistent with the recovery code; the files had been preserved outside its working checkout, not supplied to the retry.

Local safeguards implemented:

- Orchestrated agents get a five-minute quiet-output allowance; normal chat keeps its existing allowance. The 15-minute hard deadline remains enforced, and an idle override cannot extend it.
- For a retry of the same failed task, candidate edits are backed up and retained in place. They remain unverified. A hash fences the exact tracked/untracked contents between preparation and execution; unexpected changes still stop launch. New tasks and wrong-branch/checkpoint cases retain the original protections.
- The agent is explicitly told to inspect and continue retained candidate edits, then rerun checks. Its task scope, acceptance criteria, independent review, and publication gates are unchanged.
- A timed-out code task can use the existing bounded automatic-repair path. Repeated failures and exhausted budgets still escalate, and a requested pause still takes precedence. This is not an unlimited retry loop or a guarantee that every build can proceed without human input.

Validation: backend typecheck, production builds, and six focused suites passed, 70 tests. Coverage includes extended idle windows and hard deadlines, preserved tracked/untracked contents, altered or discarded candidate rejection, runner isolation, cancellation, and timeout retry followed by bounded escalation. The updated recovery modules were verified against compiled output and staged in the test desktop. The app was relaunched only after confirming no current build or agent was executing.

CAP-103's backend step now has four recorded attempts, exhausting its existing recovery budget. No attempt records were erased, no budget was reset, and its incomplete backend task was not force-accepted. Its previously archived edits remain under the test profile's preserved folder. The new in-place recovery behavior applies to subsequent eligible attempts; it does not automatically restore archives created under the old policy. A reviewed restart/reconciliation of CAP-103 remains separate from deploying these safeguards.

### Build reliability and wording audit — 2026-11-04

The follow-up [Kanban build reliability and wording plan](KANBAN_BUILD_RELIABILITY_AND_COPY_PLAN.md) records verified state/control inconsistencies, a copy inventory, phased implementation and acceptance gates. It supersedes conflicting proposals here about build controls, status wording, retries and plan revision. This follow-up is a documentation-only audit; its proposed queue, canonical controls and reviewed recovery restart are not implemented by writing the plan.

