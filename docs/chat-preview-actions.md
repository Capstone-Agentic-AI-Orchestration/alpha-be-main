# Chat, orchestration, previews and Actions integration

This change completes the engine support for the companion frontend and desktop changes.

## Shipped behavior

- Planning receives server-verified repository, branch, base and checkpoint context. Specialists implement their scoped task instead of treating missing Git tools as a product failure. Requested safe starting branches are resolved before dispatch.
- Accepted read-only investigations with no repository edits finish as reports instead of asking to publish an empty PR. Code-changing plans cannot claim this shortcut to bypass final publication approval.
- Task worktrees remain available through acceptance and recovery. Final validation and issue synchronization distinguish reports from published changes.
- Provider usage is persisted per invocation and conversation, with incremental token updates, duration, provider-specific overlap rules and interrupted-run handling. Missing telemetry is not fabricated as zero.
- Project Actions APIs provide paginated workflow/run/job/step history, bounded logs and artifact downloads using project/workspace access checks. GitHub authentication and pagination/error conditions remain explicit.
- Local website previews run a supported saved commit in a disposable copy with a restricted environment, owned process tree, loopback listener ownership check, timeouts and cleanup. The model cannot supply arbitrary commands, filesystem paths or ports.
- Preview diagnostics capture bounded process output and browser errors/failed resources. Scoped chat investigations receive the matching preview source and commit through read-only project-file tools, with owner, thread, project and repository boundaries intact.
- An explicit stop-preview chat command confirms process shutdown without starting a model or cancelling the product build. Preview requests bypass frontend build-recovery inference.

## Companion clients

The frontend supplies tabbed build review, plans, agents and diffs; typed plan/publication decisions; compact work-usage rows; project Actions views; preview controls; independent panel handles; and running-only agent indicators.

The desktop supplies the isolated native preview surface, its narrow preload IPC, browser diagnostics, navigation/network boundaries and application-shutdown cleanup. Build the three matching sources together before distributing a desktop installer.

## Current CI and branch boundaries

The Orchestrator decides assignments. GitHub Finalization assesses branch/PR/CI readiness read-only. Security leads independent audits, implementation specialists fix their approved domain, and Validation collects independent acceptance evidence.

GitHub Actions runs are visible and available to scoped read-only agent tools, but the publication path does not automatically turn a post-push CI failure into a repair task. Workflow-configuration editing has no dedicated write owner in the current role contract.

Alpha creates a private orchestration branch and makes local checkpoints. After final validation and PM/admin publication approval it pushes the verified commit and opens or reuses a PR per repository. A requested starting branch does not select an arbitrary PR destination: publication still prefers `dev`, otherwise the repository default branch. Separate promotion endpoints cover `dev -> uat -> main` with their own capability checks.

## Validation

Use the backend Vitest suite serially on Windows (`npm test -- --no-file-parallelism`) and run `npm run typecheck`. Companion validation includes the frontend suite/build and the desktop `prepare:build` runtime probe.

Local desktop checks exercised real preview startup, captured/redacted console and HTTP errors, read-only access to the exact served source, chat submission while the server stayed up, and confirmed shutdown through chat. Generic chat-transport probes intercepted the chat endpoint to avoid paid model calls; they are not live provider-response evidence. CI and branch ownership findings were source inspection, without remote publication or CI execution.

Raw local screenshots, personal workspace paths, session databases and diagnostic payloads are not distribution inputs. No workflow files or existing role permissions are changed by this feature set.
