# Orchestrator recovery, project chat, and Live Build Room

Status: the planned recovery, chat, review-handoff, final-validation repair, and Live Build Room source changes are implemented. Frontend and backend typechecks/builds passed, along with 414 frontend tests. Windows v2.0.46 is published with setup, portable, blockmap, and updater metadata; its release notes identify the source branches and include installer checksums. The package is unsigned. Browser visual acceptance and installed-app update verification remain outstanding.
Source review: 2026-10-21, Asia/Manila. This describes the checked-out source, not a verification of the installed desktop app.

## Implementation status

Implemented in source:

- Builds are bound to their originating project chat. Recovery episodes, actions, and milestones are persisted; the backend exposes available actions and checks run revisions, authorization, idempotency, attempt limits, and recovery age before acting.
- Project chat and Live Build Room share recovery actions. The UI can explain a failure, accept bounded developer guidance, retry eligible work, recheck supported prerequisites, resume a saved checkpoint, keep a build paused, or cancel it.
- Project-code recovery uses bounded retries, detects repeated matching failures, and escalates for developer guidance. Recovery messages are attached to the build's project chat.
- Reviewers receive the accepted change set and, for an empty change set, a small set of readable source/test files limited to approved task paths. If Alpha cannot supply safe review material, it blocks before launching a reviewer.
- Reviewer instructions point to the available read-only inspection tools and do not rely on shell commands. The review process stays unable to edit files, change Git state, publish, or deploy.
- Alpha records field-level report errors and the bounded original response. A malformed or incomplete report can be returned to the same specialist for a bounded read-only correction; it does not use a code-work attempt or create an implementation-owner task.
- The Live Build Room separates **Orchestrator build** from **Live agent workflows & actions**, keeps the recovery notice and detailed report evidence readable, and directs artifact actions to the producing agent when known. Plan tasks can open their exact attempt; the inspector can return to the linked task.
- Live work renders one interactive node per assigned specialist, including agents that have not started. Arrows follow task dependencies and recorded handoffs; a running node has a traveling border trace, while active handoffs animate along their edge. Retry history stays in the build plan. Opening an older plan task can show its exact run in the inspector without creating a duplicate node.
- Task retry eligibility is projected by the backend from the run state, task state, desktop capability, and work-attempt count. Chat and Live Build Room use that value for the button, while the retry endpoint checks the state and limit again before dispatch.
- Natural-language requests such as “rerun the build” stay attached to the exact saved build and use its authorized recovery action; ambiguous or missing build context is surfaced instead of being sent to a regular chat agent that cannot run the build.
- A report with the common `requirement`/`requirementId` key mismatch is safely normalized when unambiguous. If a report still fails after Alpha’s automatic format correction, the result details show the exact error and offer one additional user-authorized, read-only correction from the same specialist.

Implemented in source during this completion:

- Process-start transport failures have a separate, bounded retry count and do not consume code-repair attempts. Elapsed-time, optional token/cost, and recovery-window limits are checked before another handoff; packaged builds receive the allowlisted settings.
- Restart recovery checks that the prior writer is confirmed stopped and that the saved worktree, branch, clean state, and accepted checkpoint still match. It never silently resets or cleans a mismatched workspace; unsafe or ambiguous work remains blocked for inspection.
- Final-validation evidence can create a versioned correction chain routed to the accepted code owners, followed by a different reviewer and fresh final validation. Missing or unassignable evidence remains blocked for human inspection.
- Live Build Room has persistent Orchestrator build and Live agent workflows & actions tabs, one graph node per assigned agent, exact task-to-attempt and inspector-to-task navigation, producer-aware artifact targeting, bounded long content, keyboard-operable graph controls, and reduced-motion support. The graph implementation and artifact reflow are in frontend source; source visual acceptance remains outstanding.
- A separate source test-file expectation was updated for the current task-package version. The frontend suite passed (414 tests), and the 2.0.46 package passed its staged Electron runtime and Supabase checks. Browser visual acceptance and installed-app update scenarios were not run in this task.

Remaining acceptance gate:

- Exercise the documented end-to-end recovery scenarios and responsive/keyboard behavior in the packaged Windows app; these acceptance checks were not run. The published package has no code-signing certificate, so Windows will identify it as unsigned.

## Product outcome

A failed specialist should leave the build recoverable. Alpha should diagnose the problem, send a focused repair to the appropriate implementation owner, verify the result, and continue the same build. If repair cannot proceed or keeps failing, Alpha should explain the evidence and accept developer guidance in project chat. The user should not need to cancel the build, create another build, or leave Alpha to understand an ordinary project-code failure.

Live Build Room should provide two coordinated views: an Orchestrator build view for the plan and decisions, and a live agent view for execution, tools, files, and artifacts. Both views should use one coherent visual system and remain readable without file or log content expanding the page horizontally.

Resume means continuing from saved work and evidence, not restoring a model's exact internal state. A new agent invocation may be needed, but it must receive the same run identity, repository, branch, task history, relevant patch, and failure evidence.

## What the source does today

| Situation | Current behavior | Gap |
| --- | --- | --- |
| A recognized runner verification failure | Saves structured recovery evidence and can dispatch a bounded repair to the same task owner. Repeated matching failures stop automatic repair and ask for guidance. | Detection still relies partly on verification-stage evidence and text; every provider-specific failure still needs scenario coverage. |
| The repair fails again | Keeps attempts in the same build, stops automatic repair on repeated evidence or configured budget exhaustion, and offers bounded developer guidance when eligible. | Usage/cost caps are optional and require measured provider usage; Alpha does not estimate missing usage. |
| Other execution failures | Persists a categorized recovery episode and offers actions based on the error type, build state, and user role. Process-start retries are separate from code repair; restart reconciliation preserves but blocks mismatched/uncertain workspaces. | Dirty, unexpected, or missing workspace state requires human inspection rather than automated repair. |
| A submission fails acceptance | Preserves the report and field-level errors; a common unambiguous report-key alias is normalized, and a malformed report receives one automatic plus one explicit read-only correction at most. Review findings remain routed through owner correction and independent review. | Other unexpected acceptance categories still need additional scenario coverage. |
| Independent review finds a code defect | Can append owner correction tasks, a fresh independent review, and new validation gates. | This existing mechanism should be reused rather than rebuilt. |
| Final validation fails | Blocks the run, retains check evidence, and can append a versioned owner-correction, independent-review, and fresh-validation chain when the failed evidence maps safely to accepted code owners. | Evidence that does not identify safe owners remains blocked for human inspection. |
| App restart or paused build | Saves state and provides explicit recovery/resume in supported states. Restart resume confirms the old writer stopped and checks the exact branch and accepted checkpoint before dispatch. | A process that cannot be confirmed stopped or a workspace mismatch must be reconciled by a person. |
| Error visibility in chat | The bound build message has a recovery panel and durable milestone updates. The Live Build Room separates current recovery from the saved task/attempt history. | Verify all chat reconnection and historical/resolved-failure cases in end-to-end testing. |
| Independent code changes requested through chat | Agent calls refuse to modify a repository reserved by an active orchestration. | Recovery must be an operation inside the owning orchestration; removing this lock would permit conflicting writers. |

Source anchors:

- `src/services/orchestrationService.ts`: `handleRunnerFailed`, `failActiveAttempt`, `retryFailedTaskUnlocked`, `retryTask`, `resume`, and `createTaskPackage`.
- `src/services/taskAcceptanceService.ts`: acceptance rejection, review routing, and final validation.
- `src/services/orchestrationReviewWorkflow.ts`: versioned correction/review/validation amendments.
- `src/services/orchestrationRuntime.ts`: runner event handling and restart reconciliation.
- `src/controllers/orchestrationController.ts` and `src/controllers/liveBuildRoomController.ts`: task actions, recovery projection/actions, run binding, and Live Build Room data.
- `src/services/orchestrationRecoveryPolicy.ts` and `src/services/orchestrationRecoveryService.ts`: failure classification, bounded action policy, persistent recovery episodes, milestones, and guarded actions.
- `src/services/agentCallService.ts`: `assertNoActiveOrchestration`.
- `src/services/chatService.ts`, `chatWriteThrough.ts`, and `orchestrationEventDelivery.ts`: build messages, durable chat writes, and committed event notifications.
- Frontend `src/features/chat/ChatView.tsx` and `src/features/chat/OrchestrationRecoveryPanel.tsx`: build binding, recovery explanation, and authorized recovery actions.
- Frontend `src/features/live-build-room/OrchestrationWorkflowPanel.tsx` and `src/features/live-build-room/LiveBuildRoomView.tsx`: task/attempt history, exact task-to-run navigation, the per-agent roster, latest-run inspector, and artifact targeting.

## Recommended behavior

1. Capture the failure as structured evidence and preserve the current work.
2. Identify whether it is project code, acceptance/reporting, temporary infrastructure, configuration/access, workspace integrity, or an Alpha application problem.
3. Repair automatically when it is within the approved build scope and the configured budget.
4. Re-run the relevant checks and acceptance gate. A repair agent's claim of success is not sufficient.
5. Continue the next eligible task only after acceptance. Keep completed work in unrelated repositories.
6. If blocked by configuration, exhausted budget, or repeated lack of progress, send a durable explanation to the originating chat and expose the appropriate action there.
7. Treat developer guidance as a recovery request for that same run. Recheck the current run revision and repository state before acting.

### Recovery policy

| Failure category | Recommended response |
| --- | --- |
| Test, lint, type, compile, or ordinary project-code failure | Same implementation owner receives bounded diagnostics, relevant patch, failed commands, and a focused repair objective. |
| Invalid specialist report or missing evidence | Return the exact contract errors to the reporting specialist. Re-run checks if evidence is absent; never invent a successful check. |
| Independent reviewer identifies a defect | Route code changes to the implementation owner, then repeat independent review and affected validation. Keep the reviewer read-only. |
| Final integration validation failure | Map evidence to affected owners; append correction and review/validation gates in the same run. Re-run combined checks before final approval. |
| Temporary provider/network/rate-limit error | Retry with bounded backoff and any supplied retry-after guidance. Do not ask a code agent to modify source for an infrastructure failure. |
| Missing authentication, runtime, repository access, or required setting | Explain the missing prerequisite and open the relevant in-app settings. Recheck readiness after the user fixes it. Do not post credentials in chat. |
| Unexpected HEAD, dirty or missing worktree, or uncertain process exit | Preserve work, confirm the old writer has exited, inspect the saved diff, and offer a verified reconciliation action. Do not silently reset, clean, or recreate from a different base. |
| Alpha desktop/backend defect | Show the diagnostic and an in-app update/report path. A project specialist must not attempt to repair Alpha's installed engine from the project's checkout. An actual engine fix may still require an app update. |
| Unknown failure | Bounded read-only diagnosis first. If ownership or the remedy remains unclear, request developer direction with the collected evidence. |

### Suggested defaults

- Initial task execution plus up to two automatic focused repair attempts per recovery episode.
- Separate short transport retry budget so a temporary connection failure does not consume code-repair attempts.
- Enforce configurable elapsed-time and usage budgets as well as attempt limits.
- Stop early when two repairs repeat the same failing evidence without measurable progress. Compare failing checks and diagnostics; a different commit hash alone is not progress.
- Developer guidance can explicitly authorize another bounded recovery episode. Preserve cumulative attempts and usage; never reset history to evade a limit.
- A pause or cancellation request prevents further repair dispatch. Keep a repository reserved until its writer is confirmed stopped.

### Developer decision after repeated failure

This is a required stop, not an informational notification. On budget exhaustion or repeated lack of progress, persist `waiting_for_user`, keep the build blocked, and create one durable escalation in the bound chat. No timer, reconnect, application restart, new status poll, or duplicate event may silently grant another repair attempt.

The escalation must state the failing task and repository, observed error/check, repairs attempted and their results, what work/checkpoints remain saved, and the specific decision required. Offer **Explain issue**, **Provide direction and retry**, **Review patch**, **Reassign or revise plan**, **Keep paused**, and **Cancel build** when authorized. A new direction or approved plan change opens a new explicitly authorized, bounded repair episode; an explanation, elapsed time, or absence of a reply does not authorize execution.

The developer remains in project chat to make the decision. If an external prerequisite or Alpha update is required, Alpha should explain it and link to the in-app connection/update flow rather than imply that another project-code retry can fix it.

## Chat experience

Attach a compact recovery panel to the existing build message, plus durable Alpha messages for meaningful transitions: repair started, repair succeeded, developer action needed, and build continued. Avoid a new chat message for every log line.

Example automatic repair message:

> The frontend task failed type checking: `CalculatorPage.tsx` passes a string where a number is required. The completed backend task is preserved. I am sending the frontend owner a focused repair and will run type checking, tests, and review before continuing. Repair 1 of 2.

Example escalation:

> The build is waiting for your direction. Two repairs still fail the calculator keyboard test. Expected `12`, received `2`. The implementation and patch are saved. You can explain the intended behavior, review the patch, or allow another repair round.

Possible developer messages:

- "Fix the failing test and continue this build."
- "The API uses `amount`, not `value`; update the frontend and continue."
- "I reconnected the runtime. Recheck it and resume."
- "Explain this error before changing anything."

Expose actions based on backend capability data: **Fix and continue**, **Explain issue**, **Provide guidance**, **Reconnect runtime**, **Review saved changes**, or **Resume from checkpoint**. Hide unavailable actions and state why an action cannot run. Asking for an explanation is read-only. A clear instruction to fix and continue within the existing scope authorizes that repair; do not add another confirmation for it. Ask for approval when the proposed remedy changes requirements, repository scope, ownership, or other approved constraints.

The panel must distinguish a current blocker from historical failures that have already been resolved. Show a resolved failure in history, not under "Why the build stopped" while a newer task is running.

## Architecture

### Persist recovery state and identity

Add additive storage for recovery episodes and actions. Proposed episode fields:

- Recovery/run/task/attempt identity, failure source and category, error code, observed summary, confidence, evidence references, and a normalized failure fingerprint.
- Phase: `diagnosing`, `repairing`, `waiting_for_user`, `ready_to_continue`, `resolved`, or `cancelled`.
- Repair budget, consumed attempts, progress evidence, user guidance references, checkpoint references, and revision.
- Originating chat thread, build message, initiating user, and visibility scope.

Bind the chat to the run explicitly when the build starts. Backfill old builds only where a project-scoped build message gives an unambiguous mapping; otherwise let the user select the saved build. Do not infer permissions from a stored thread ID or copy private logs into a shared thread.

Keep existing run statuses initially. A running repair uses `executing`, a current task, and a normal persisted attempt. An unresolved recovery uses `blocked` plus its recovery phase. Recovery metadata supplies the richer UI without creating a second independent scheduler.

### Central recovery service

Introduce an `orchestrationRecoveryService` used by runner failure handling, task preparation/launch failures, acceptance rejection, review-routing failure, and final validation. It should produce a typed decision and a structured repair context, rather than relying on text matching or model promises.

The model may explain evidence and propose a repair. Deterministic code validates authorization, task scope, allowed state transitions, budgets, owner readiness, and checkpoint identity before execution.

Reuse `orchestrationService` serialization and the existing SQLite transitions. Record the failure, recovery decision, and event atomically. Launch one writer only after the decision commits. Late completion events from an old attempt must not overwrite the current attempt.

Replace scattered hard-coded two-attempt checks in the service, resume flow, and frontend with one server-owned policy and `availableActions` projection. Keep attempt numbers monotonic.

### Continue the same build

Repair the task in its existing authorized repository/worktree under the run's reservation. Independent chat agent calls remain blocked from competing writes. Do not route repair as a fresh project build.

Keep the original planning base immutable. Track the last accepted repository checkpoint separately from a failed attempt's recoverable patch/checkpoint. Before repair, preserve and inspect partial edits; only adopt changes demonstrably belonging to that run. Branch mismatch, missing checkpoints, or uncertain process ownership require reconciliation.

Retain accepted tasks and evidence. If a repair changes already accepted behavior, append an explicit correction and fresh review/validation chain. Preserve earlier evidence as history, but invalidate approval or validation evidence tied to an older commit. Invalidate only affected dependency gates, then run final cross-repository checks. Never publish or claim completion using stale validation.

A failed final-validation gate needs its own recovery entry even when there is no active task. Add either a validated "rerun checks" action when only environment readiness changed, or a versioned owner correction plan when code must change.

### Recovery actions and chat routing

Add project/run-scoped recovery read and action endpoints. An action request should include the recovery ID, expected run/recovery revisions, an idempotency key, requested action, and optional developer guidance. Reject stale actions before modifying task state.

Both chat buttons and natural-language follow-ups call the same authorized action service. Suggested intents: `explain_failure`, `repair_and_continue`, `provide_guidance`, `recheck_prerequisite`, and `resume_checkpoint`.

For natural language, have the model propose a typed intent, then validate it on the server. If multiple builds are relevant, require a selected build rather than choosing by recency. Attach the correct run's recovery context to Alpha's reply. Ordinary questions must not launch work.

### Durable events and chat delivery

Reuse the committed orchestration event/outbox pattern. Add a separate idempotent projection for user-visible chat milestones; do not make websocket delivery the sole source of recovery history. Message identity should include run, recovery episode, and event/phase so retries and restarts do not duplicate notices.

Use `chatWriteThrough` and existing ownership/sync rules. Persist bounded, sanitized evidence or references; keep raw logs and local workspace paths out of shared messages. Reauthorize evidence reads and actions on every request. A disconnected chat renderer must catch up when reopened.

## Live Build Room UI/UX workstream

### Design diagnosis and direction

The Live Build Room now separates Orchestrator decisions from live execution. The live view uses an interactive handoff graph in place of the agent card grid, with the existing agent inspector and artifact actions beside it. Artifact names and details can be long, so keep them wrapped inside a bounded, scrollable list.

Use the Orchestrator plan portion as the visual reference: its typography hierarchy, restrained violet/slate palette, surface treatment, spacing, borders, status language, and disclosure patterns. The [Nodeflow node-based UI kit](https://www.figma.com/community/file/1677318731566772022/nodeflow-node-based-ai-system-ui-kit-free-version) is a reference for clear node states and workflow canvases; keep Alpha's own components, icons, and semantic colors. Retain accessible success, warning, failure, and waiting states.

The key distinction should be between deciding what happens and inspecting what is happening. Give each view enough space and a clear purpose, with direct navigation between a planned task and its live execution.

### Two sub-tabs

Keep the room header outside both panels: project/build selectors, build identity and status, refresh/sync state, and the current actionable recovery notice. Put the sub-tab navigation immediately beneath that header.

| Sub-tab | Purpose | Content |
| --- | --- | --- |
| **Orchestrator build** | Understand the plan, dependencies, decisions, and readiness. | Goal, work plan and task ownership, assignment reasons, progress and handoff timeline, acceptance/review findings, recovery decision, required checks, and final review/publication controls. |
| **Live agent workflows & actions** | Inspect execution and its outputs. | Agent overview and status filters, active/waiting/completed assignments, selected-agent activity, handoffs, files, tools/commands, and build artifacts. |

- Default to **Orchestrator build** when entering a coordinated build for the first time. Persist the selected sub-tab and each view's selections/filters using the existing tab-session mechanism. Scope selection to the chosen project/build so unrelated runs do not inherit an invalid agent selection.
- On narrow screens, a compact visible label such as **Live agents** may be used while preserving a clear accessible name and explanatory panel heading. Do not force a long label into clipped text or a tiny touch target.
- Show meaningful running/attention counts on the live tab. A failure updates the shared recovery notice and tab indicator; it does not force-switch the developer away from what they are inspecting.
- Add **View agent activity** on a plan task. It selects the live tab, the matching execution/attempt, and the relevant inspector panel. Add a **View assigned task** link from the live inspector back to the plan.
- Opening a specific run from chat must retain that run across both sub-tabs. A recovery/chat action must target the displayed run, even after a newer build exists.
- Keep data loading and stream subscriptions at room level. Switching sub-tabs must not stop the build, create duplicate subscriptions, reset scroll/filters unnecessarily, or launch another agent.
- Preserve direct-agent and legacy-build visibility. Give the plan tab an honest empty state when there is no coordinated plan; keep execution history accessible in the live tab.
- Use proper tab/tabpanel relationships, selected state, roving keyboard focus, arrow-key and Home/End behavior, visible focus, and touch-sized controls. Inactive panels must not expose hidden controls to keyboard or assistive technology.

### Live agent graph and inspector

- Every graph node represents one assigned specialist, never a task attempt. Show the agent name/role, current status, current or next assignment, and one recent activity line; keep full activity, tools, files, and historical attempts in the existing inspector or build plan.
- Build forward arrows from actual task dependencies or recorded runtime handoffs. Show review-correction arrows back to the implementation owner only when the run records a correction cycle. Do not invent edges for independent tasks. Distinguish completed, active, waiting, and attention handoffs.
- Animate a short glowing trace around the border of a running agent node to communicate ongoing work. Animate a moving pulse along an active handoff. Keep inactive edges still, make active motion restrained, and honor the system's reduced-motion preference.
- Keep agent search and status filters in the graph toolbar. Make specialist and handoff counts visible. Use inner scrolling and fit/zoom controls when the graph is wider than its pane; keep the page itself within its parent width.
- A plan task must open that task's exact run in the inspector while highlighting the agent's single roster card. A card click returns the inspector to that agent's latest run. If its current/next task differs from the latest run's task, expose both destinations clearly so the agent assignment and inspected attempt are not confused.
- Give the selected execution a clear but restrained border/surface treatment. Keep the execution status, task acceptance status, and whole-build status distinct; a process that finished does not by itself mean its work was accepted.
- Let the graph canvas adapt to the available pane width. The inspector can sit beside the graph when there is room and move below it on narrower layouts. Do not base this change solely on viewport width.
- On wide layouts, use a readable card workspace plus a bounded inspector. On smaller layouts, use an inline detail section or an accessible sheet with close/focus-return behavior. Avoid squeezing a fixed-width inspector beside narrow cards.
- Align the inspector's Activity, Handoff, Files, and Tools controls with the plan section's disclosure/focus styling. Keep current work visible, put verbose output behind disclosure, and preserve selection while activity updates.
- Distinguish live, waiting, completed, stopped, stale/no-signal, and retrying states. Show useful empty/loading/error states without fabricated activity, timestamps, or progress.
- Support reduced motion and avoid attention-grabbing re-entry animation on every polling update. Live updates must not move focus or repeatedly announce entire log histories.

### Artifact and file overflow correction

Treat this as a layout and interaction correction, not a blanket `overflow-x: hidden` patch that conceals content.

1. Audit the complete room/grid/card/inspector hierarchy for intrinsic min-content width. Add appropriate `min-width: 0`, `max-width: 100%`, and `minmax(0, 1fr)` constraints where needed. Reflow controls and metadata before shrinking text.
2. Replace the dense artifact tile grid with a responsive artifact list or a grid that fits its actual container. Each item should show an icon/type, readable name, repository/task or producing agent, concise detail, and one clear action. Use the same spacing and surfaces as the plan.
3. Wrap long file names, branches, hashes, and URLs where useful with an anywhere-wrap rule. Use deliberate single-line truncation only when the full value remains available through an accessible details view and **Copy path/value** action; do not rely on hover alone.
4. Bound large artifact lists with progressive disclosure or pagination and a visible count. Keep filenames searchable if the recorded outputs are numerous. Do not render hundreds of file chips as a full-height wall.
5. Keep preformatted commands and logs within their own bounded scroll region, with wrapping where appropriate and preserved copyable content. Internal code scrolling may be necessary; it must not widen the page or push action buttons offscreen.
6. Scope artifacts to the selected build and execution when applicable. Label repository/producer explicitly for multi-repository builds, deduplicate repeated output references, and distinguish a changed file reference from an actual downloadable artifact or PR link.
7. Fix action targeting: the current generic **Open artifacts** action opens the selected agent's Files tab, which may not be the producer of a displayed artifact. A row action must open that artifact or select its actual producing execution. Use **View agent files** for an action that only opens an agent's file panel. Do not imply a download or file preview exists when only metadata is recorded.
8. Apply the same containment rules inside the inspector's Files, Tools, Handoff, and Activity views, including artifact titles, output values, tool arguments, and unbroken error strings.

### Recovery across both views

Keep one shared, compact notice visible when the run is repairing or waiting for a developer decision. It should show the affected task, current recovery phase, repair budget, and **Discuss in chat** or the appropriate server-authorized action. Keep the full diagnosis in the plan/recovery section and detailed command evidence in the live inspector. A live agent card must not imply work is still running when the run is actually waiting for the developer.

Chat links should preserve the originating build and recovery episode. After the developer makes a decision, both sub-tabs update from the same authoritative state; neither UI invents its own retry eligibility or resets the budget.

### Frontend implementation boundaries

- Refactor `LiveBuildRoomView.tsx` into a shared room shell plus separate build and live-workflow panels. Keep fetches, build selection, socket subscriptions, and authorized actions in the owning room/controller layer.
- Reuse `OrchestrationWorkflowPanel.tsx` as the plan view. Keep the graph in `AgentHandoffGraph.tsx`; leave live-room fetching, session state, agent selection, and authorized actions in `LiveBuildRoomView.tsx`. Keep artifact producer navigation tied to the existing inspector action.
- Use `AppContext` tab-session state for the sub-tab and appropriate view state. Add only the artifact metadata needed for correct producer/run targeting to `shared/types` and the backend projection; do not invent file-serving endpoints for this redesign.
- Keep UI work independently reviewable from recovery-policy changes, with a shared contract for recovery state and available actions.

### UI acceptance gate

1. The two sub-tabs separate the plan from live workflows; switching them preserves the selected run, filters, agent, and recorded activity.
2. The graph shows one node for every distinct assigned specialist, including not-yet-started specialists. A retry does not add a duplicate node; a task click can still open its exact attempt in the inspector, and a node click selects the matching agent activity.
3. Graph edges map to task dependencies or recorded handoffs. Review-correction arrows return to the implementation owner. Running nodes show a traveling border trace, active edges show motion, and reduced-motion settings disable those effects.
4. An artifact opens the correct output/producer rather than whichever agent happened to be selected.
5. The plan and live view share typography, surfaces, spacing, state labels, and recovery actions. Active and resolved failures are visually distinct.
6. At 320, 390, 768, 1024, 1280, and 1366 px widths, including the application's sidebar and an open inspector, the page has no unintended horizontal overflow. Also verify a larger desktop and browser zoom/text expansion.
7. Long unbroken paths, 200-character names, deep repository paths, multiline errors, large command output, and many artifacts do not obscure controls or expand the room beyond its container. The full content remains accessible and copyable.
8. Tabs, nodes, inspector controls, file details, and recovery actions work by keyboard and touch, with focus restored on close and no hidden-panel controls in the tab sequence.
9. A polling/socket refresh does not reset the sub-tab or inspector, remount the entire interaction unnecessarily, create duplicate streams, or steal focus.
10. Capture and inspect both sub-tabs on laptop and narrow layouts, with empty, running, repairing, waiting-for-developer, stopped, and completed fixtures. Record visual and interaction findings before packaging.

## Review access and agent handoff reliability

The calculator review failure shown in the run has two independent causes: the reviewer could not inspect the repository with the tools available to it, and its final report did not pass Alpha's required format. Passing test, typecheck, and lint checks does not resolve either issue; those checks do not prove that an independent review happened. Handle access failure, report-format failure, and a real code finding as separate outcomes so one does not trigger the wrong agent or a repeated, unhelpful handoff.

### 1. Check readiness before launching a reviewer

- Before a review starts, confirm the selected build, repository/worktree, branch and accepted commit, review task, and the exact accepted code tasks it depends on. Verify that the runner can expose scoped, read-only source inspection to the chosen provider.
- If the assigned workspace or a needed read tool is unavailable, stop during preparation and show the specific missing capability or path. Do not spend a specialist attempt, call it a code defect, or create an implementation-owner correction task.
- Package the accepted patch, its hash, changed paths, requirements, and acceptance evidence as review context. An empty patch is not proof that there is nothing to review: inspect the named current source and tests when the task covers existing behavior. If there is no usable patch or source context, report `review_input_missing` and return to orchestration to repair the review inputs; never claim the behavior was verified.

### 2. Give reviewers useful but strictly read-only access

- Define a provider-neutral review capability for listing, searching, and reading files inside only the run's assigned worktree. Map it to each supported runner's native file-inspection tools and test that mapping before dispatch. The review prompt must tell the agent to use those tools instead of assuming shell commands such as `rg`, `git`, or `cat` are available.
- Keep file writes, edits, repository mutations, network access, publishing, and deployment unavailable to reviewers. Do not grant broad shell or write access to work around a missing reader. If a provider cannot supply the required scoped read capability, block before launch with a clear configuration/provider diagnostic and a supported next action.
- Record the provider, capability check, attempted tool, exact denial, and safe alternative (if available) with the review attempt. Show the concrete reason to the developer rather than only “repository commands were blocked by policy.” If a safe file reader works, the reviewer should continue with it even when shell access is denied.

### 3. Make the report contract easy to follow and recover from

- Keep the report template generated from the same schema Alpha validates. For version 1, require `schemaVersion`, the exact `taskId`, `summary`, `requirementCoverage` entries using `requirementId` and `evidence`, `criteriaEvidence`, at least one `deliverables` item, and `reportedChecks`. A review report must also include `reviewFindings`, even when it is `[]`. Preserve exact field names and task/requirement IDs in the prompt.
- Validate the report as soon as the agent responds. If it is malformed, preserve the original response and return the specific field-level error to that same specialist for one automatic, format-only retry. Do not ask it to redo code, consume a code-repair budget, or make a second identical correction task. If that retry still fails, show the exact missing/invalid field and offer at most one explicit, user-authorized report-only retry; never silently loop.
- Keep Alpha's observed test results separate from the specialist's `reportedChecks`. Never turn an unrun check into a pass. Do not accept requirement coverage that has no evidence or a review report that says it inspected code when read access failed.

### 4. Gate each handoff on a clear, accepted result

- Give each attempt one explicit outcome: preparation/access blocked, report needs correction, accepted with no review findings, accepted with review findings, execution failed, or cancelled. Keep the detail and cause code with the attempt so the timeline explains what stopped and what should happen next.
- Route a report-format correction to the reporting specialist. Route a verified code defect to the implementation owner and then to a different reviewer. Route unavailable tools or missing review input to orchestration/provider preparation. Do not convert any of these into another category.
- Allow only one active attempt for a task; make dispatch, retry, and acceptance idempotent across clicks, reconnects, and restarts. Start the next eligible agent only after the prior task's report and acceptance gates pass. Preserve accepted work and evidence, and do not repeat a correction already assigned for the same unresolved cause.
- In the build timeline, show which specialist and task stopped, what capability or report field failed, whether Alpha's checks passed, and the next eligible action. Keep historical failed attempts visible as history, separate from the current blocker.

### Implementation order for this issue

1. Add stable failure codes and attempt evidence for review preparation/access and report validation; surface the exact report error already captured by the backend.
2. Add and verify provider-specific, scoped read-only review access. Add a preflight that prevents dispatch when it is unavailable, and update the reviewer instructions to use the available file readers.
3. Generate and validate the response template from the report schema, then add one report-only correction path that reuses the same specialist and does not create a duplicate implementation task.
4. Verify review-to-owner-to-independent-review-to-next-handoff transitions, including empty-patch and restart/retry cases, before enabling the path by default.

## Implementation phases

| Phase | Deliverable | Main code areas | Exit criteria |
| --- | --- | --- | --- |
| 1: Reliable diagnosis | Structured failure/recovery records, evidence extraction, error categories, available actions, and additive migrations. Include provider, denied tool/capability, review-input state, and field-level report errors. | State machine, SQLite persistence, runner adapter, runner failure handler, task acceptance. | Every blocker has an accurate cause and next action; an unavailable reviewer is stopped before dispatch; a malformed report names the exact correction. |
| 2: Bounded repair | Shared policy, progress/budget tracking, focused repair context, owner routing, final-validation repair amendments, and a separate report-only correction path. | New recovery service; orchestration service/runtime; acceptance service; review workflow. | Access/report failures go to the right recovery path; actual code defects go to the owner; accepted work survives and the same run advances once gates pass. |
| 3: Recovery in chat | Explicit run/thread binding, durable milestone projection, typed recovery actions, developer-guidance routing, and explanation context. | Project build entrypoint, chat service/controller, chat write-through, event outbox, recovery routes. | Developer can explain, guide, repair, and continue the selected build from project chat without starting a new build. |
| 4: Shared UI and Live Build Room redesign | Recovery panel/actions in chat; two Live Build Room sub-tabs; live agent visual alignment; artifact/file containment and correct output targeting. | ChatView, OrchestrationWorkflowPanel, LiveBuildRoomView, extracted live-agent/artifact components, tab-session state, API/types, live room projection. | Both surfaces share recovery state/actions; tabs preserve context; artifacts target the right output; responsive/keyboard and long-content gates pass. |
| 5: Package and verify | Integration checks, installed-desktop exercise, backward compatibility, and release evidence. | Backend/frontend checks and desktop build preparation/package. | The packaged app, not just source tests, passes the recovery scenarios below. |

Implement recovery execution behind a capability flag. The Live Build Room tab/layout work can proceed independently once its state/action contract is agreed; use an explicit unavailable state for recovery actions the installed backend does not support. Older desktop versions should keep reading saved builds and display an update action when they cannot execute a recovery operation. Migrate existing runs additively and keep legacy squads separate.

## Required acceptance scenarios

1. A code task fails type checking; its owner repairs it, real checks pass, and the same build reaches independent review and validation.
2. A second task fails after the first is accepted; repair leaves the first task and its repository checkpoint intact.
3. A preparation failure occurs before an attempt starts; it is reported in chat and does not consume a code-repair attempt.
4. Acceptance rejects an invalid report; the reporting agent receives concrete errors and repairs its evidence without claiming nonexistent checks.
5. Independent review returns a defect; the implementation owner fixes it and a different reviewer rechecks it.
6. Final cross-repository checks fail with all tasks accepted; recovery appends affected corrections and fresh gates, then reruns combined validation.
7. Repeated identical failures exhaust the policy and produce one useful chat escalation. An explanation request launches no writer; explicit new guidance permits a new bounded episode.
8. A disconnected/reopened chat or restarted app restores recovery history without duplicate notices or silently launching extra attempts.
9. A retry button and a chat command arrive together; one action wins and one specialist launches.
10. The old process completes late; its event cannot accept work for the replacement attempt.
11. Pause, cancel, missing runtime, authentication, rate limit, dirty worktree, unexpected HEAD, and missing checkpoint each produce the appropriate recovery path.
12. A resolved failure is shown as history, not as the active reason a later successful build allegedly stopped.
13. Project/member visibility changes block stale evidence reads and recovery actions. Sensitive diagnostics never appear in an unauthorized thread.
14. Final approval/publication remain tied to the currently validated commits. Recovery does not auto-merge, deploy, or modify Alpha's installed engine.
15. Both Live Build Room sub-tabs preserve the same build identity; task-to-agent and artifact-to-producer navigation opens the exact selected execution.
16. Artifact/file/log stress fixtures pass the responsive and accessibility checks in the UI workstream with no unintended page overflow.
17. Review preflight confirms the selected worktree and that hash-bound patch/source material is present before dispatch; missing material produces a preparation blocker without spending a specialist attempt.
18. A reviewer can inspect the supplied patch/source material directly, or use scoped read tools when needed, while attempts to write, edit, mutate Git, publish, or deploy remain denied. A shell denial alone does not stop review when its assigned evidence is already included.
19. An empty accepted patch is reviewed only when the task includes usable source/test context; otherwise the run reports missing review input and does not claim independent verification.
20. A report using an unambiguous alias such as `requirement` instead of `requirementId` is normalized. Other malformed report fields are shown precisely and can receive one automatic plus one explicit, read-only correction from the same specialist, with no implementation-owner correction or duplicate finding.
21. A valid review report with `reviewFindings: []` passes the review gate and hands off to the next eligible task once. A real blocking finding goes to its code owner and then to a different reviewer.
22. Alpha checks may pass while reviewer access fails; the build still identifies the review blocker and does not present passing checks as completed review.
23. Duplicate retry clicks, reconnects, and late completions do not start two specialists, duplicate corrections, or advance the run from a stale result.
24. The live roster shows each distinct agent assigned to the selected build exactly once, includes planned agents with no run yet, summarizes the current/next task, and keeps the latest run selected by default. Opening an older plan task temporarily shows its exact run without adding a second roster card.

## First implementation slice: verification priority

The source now includes the vertical review-recovery slice: an accepted code task is packaged with scoped context; a reviewer uses read-only inspection, returns a structured report, and Alpha handles missing access or a malformed report through separate recovery paths. Verification should exercise the failure drills—deny a required read tool before launch; submit a malformed report and verify normalization or the bounded same-reviewer correction path; and check that natural-language rerun requests act on the selected build rather than regular chat—plus a real finding routed to its implementation owner and a different reviewer. Continue acceptance work across project verification, preparation, provider, acceptance, restart, and final-validation failures, then confirm repeated-failure escalation and a developer "fix and continue" follow-up.
