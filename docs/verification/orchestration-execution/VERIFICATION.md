# Orchestration execution verification

Date: 29 October 2026 (Asia/Manila).
Implementation branch: `feat/orchestration-execution-20261028`.
Comparison baseline: `3c02196` (a local snapshot of the existing preview/chat integration, based on `383ff7d`).

## Results

| Run | Result | Evidence |
| --- | --- | --- |
| Pre-change baseline | 51 passed / 5 files | [baseline](baseline-tests.log) |
| New regression tests before fixes | 15 failed / 1 file, as expected | [red phase](red-tests.log) |
| First implementation check | 32 passed / 4 files | [first checks](first-tests.log) |
| Real subprocess and grounding fixtures | 13 passed / 2 files | [runtime](runtime-tests.log) |
| Broader regression | 276 passed / 16 files | [regression](regression-tests.log) |
| Runner prompt, deadline and newline additions | 40 passed / 3 files | [focused](final-focused-tests.log) |
| Final command compatibility and runtime checks | 34 passed / 3 files | [final preflight](preflight-final-tests.log) |
| Final production TypeScript build | Exit 0 | [build](final-build.log) |

Counts overlap across runs; they must not be summed as unique tests. Initial TypeScript checking exposed test-fixture typing and a regex-token array inference issue. Both were corrected; the final production build includes all source and test TypeScript.

## Commands

All tests ran in `C:/Users/Lloyd/Documents/Projects/Capstone/Alpha-v2/alpha-be-execution-redesign`.
Dependencies were reused through a node_modules junction to the baseline checkout. No packages were added.

Broad regression:

```powershell
npm test -- --no-file-parallelism src/services/verificationExecution.test.ts src/services/verificationExecution.integration.test.ts src/services/repositoryExecution.test.ts src/services/verificationService.test.ts src/services/projectPlaybook.test.ts src/services/processManager.test.ts src/services/taskFileAccess.test.ts src/services/taskAcceptanceService.test.ts src/services/orchestrationRecoveryPolicy.test.ts src/services/orchestrationService.test.ts src/services/orchestrationFinalization.test.ts src/services/acceptedWebsitePreview.test.ts src/services/localPreviewCheckpoint.test.ts src/services/localPreviewService.test.ts src/services/cliRunner.test.ts src/services/runnerWorkspaceLifetime.test.ts
```

Focused final runs:

```powershell
npm test -- --no-file-parallelism src/services/runnerWorkspaceLifetime.test.ts src/services/verificationExecution.test.ts src/services/processManager.test.ts
npm test -- --no-file-parallelism src/services/repositoryExecution.test.ts src/services/verificationExecution.test.ts src/services/verificationExecution.integration.test.ts
npm run build
```

## What was actually exercised

- Preflight refuses common servers, watchers, nested local script aliases, pre/post check hooks, background commands and alias cycles before spawning installation or verification.
- Bounded builds/tests remain allowed, including quoted command-like text, Jest worker counts, disabled watch flags and stderr redirection.
- Missing required scripts and forced timeouts cannot be recorded as passing.
- Execution context uses the declared manager, refreshes after manifest changes, and reaches a real RunnerService invocation (provider subprocess stubbed).
- Real npm/node fixture commands fail with observed stderr, then pass after a fixture edit.
- A real Node HTTP server starts on loopback inside an npm check. A shortened three-second test deadline stops the process tree; HTTP fails afterward and the run is no longer active.
- Existing acceptance/recovery tests cover scope, independent findings, bounded retries, targeted diagnostic feedback and stale results.
- Existing preview tests cover commit pinning, changed HEAD, authorization, cancelled runs and acceptance filtering.
- Existing provider adapter tests preserve scoped native-tool restrictions.

## Verification limits

The real process fixture runs on this Windows host with Node/npm. Other provider adapter tests do not make live AI calls. Preview service tests are not a new Electron visual QA run. No production/remote deployment, desktop activation or paid model task was performed. Script preflight is an operational guard, not a complete shell parser or OS security sandbox.
