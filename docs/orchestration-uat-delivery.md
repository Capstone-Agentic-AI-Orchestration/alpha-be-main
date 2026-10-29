# Orchestration delivery through UAT

Implemented locally on 2026-10-29. This document describes source behavior, not a published desktop release or a completed live deployment.

## Authority and workflow

Build completion means the approved code was published as PRs. A separate SQLite delivery record tracks CI, integration into `dev`, promotion to `uat`, the deployed commits, and HTTP smoke evidence for every selected repository.

A developer with project build access can select **Deliver to UAT automatically** for a published, reviewed build. This grants the backend authority for those source commits only. The backend then monitors and merges the feature PRs, waits for `dev` CI, prepares `dev -> uat` PRs, waits for their checks, merges them, and verifies UAT. **UAT does not require PM/admin authorization.** This incorporates the user's explicit correction to the earlier proposed approval policy.

An existing publication approval continues to mean publication. It does not silently acquire permission to merge: the delivery control explicitly grants that additional scope, and a developer can grant it without asking a PM. There is no additional approval at the UAT stage.

Production (`uat -> main`) remains governed by its separate release capability. UAT readiness does not accept a delivery, close a client ticket, or authorize client handoff. PM review and client handoff remain separate product workflows.

## Agent and human boundaries

- The Orchestrator assigns a bounded CI repair plan. Implementation owners edit only the original authorized repository paths. The server overrides model-proposed repair scopes and excludes `.github/workflows/**`.
- Security & Code Quality remains the independent lead reviewer; Validation follows the implementation. Delivery requires accepted review and validation attempts after the latest accepted implementation in every repository.
- A repair requires the existing plan approval, review and publication flow. Two repair proposals are allowed across a linked delivery chain; fresh source commits need a fresh delivery grant.
- Models cannot grant permissions, waive checks, approve their own review, or merge through a specialist tool. GitHub operations belong to the backend delivery service.
- Authorization records identify the acting account and exact source commits. Each remote action rechecks current membership/project access, current branch heads, required CI and PR identity. The GitHub token is pinned for that operation and its login must match the authorized actor.
- Delivery can be paused or resumed by a project developer. Pausing prevents the next scheduled action; a GitHub operation already in progress can finish. Three unsuccessful automatic actions pause further attempts.
- The audit ledger persists actor, action and commit evidence across desktop restarts. It does not persist credentials or raw CI logs. The panel shows recent evidence; the project-scoped events endpoint provides older entries.

## CI and deployment gates

Both `dev` and `uat` need configured required status checks with strict/up-to-date integration enabled. Those checks must also apply to administrators, or an active ruleset must expose a verified empty bypass list. Rulesets and legacy protection are read. App-bound check names must match their configured GitHub App. Conflicting app bindings, missing checks, skipped/neutral/cancelled checks, unavailable evidence and API permission errors cannot produce a passing gate. Ruleset bypass metadata can be unavailable to an account without ruleset write access; unknown bypass policy blocks delivery rather than silently assuming it is empty. See [GitHub's rules API](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset).

PR source and synthetic merge checks are inspected. GitHub receives the expected source SHA on every merge. Strict branch checks enforce target integration if the base moves between inspection and GitHub's merge operation. Workflow-changing PRs are withheld for separate human handling; this implementation does not modify workflow YAML or bypass branch rules.

All repositories are preflighted before remote changes. GitHub cannot atomically merge multiple repositories; a network failure can leave partial progress. Per-repository checkpoints and GitHub re-reads reconcile successful operations without merging them twice. Deployment readiness requires all repositories, not just the first one.

Hosting verification uses the existing Render/Vercel clients. The provider must identify this repository, the `uat` branch and the exact expected UAT SHA. Render's `/health` and the Vercel deployment's HTML root are checked over provider-issued HTTPS URLs, with a timeout and redirects disabled. A frontend HTTP smoke check is **not a browser/Playwright acceptance test**. Browser acceptance remains visible as a separate review requirement.

## Runtime and rollout

Delivery uses the desktop's authoritative executor and SQLite store. The executor must remain running and signed in as the account that granted delivery; current project access is rechecked. Restarting resumes records and grants. Signing out or losing access prevents further actions. Standalone cloud execution of this local orchestration is not introduced here.

Live read-only preflight of `e-commerce-fe` and `e-commerce-be` found no required status checks on either `dev` or `uat`. The delivery adapter correctly reports those four missing policies as blockers. Configure named required checks and strict integration through GitHub before using either repository for a live delivery pilot. No live branch protection, workflow, PR or deployment was changed for this implementation.

The automated fixture covers the complete two-repository lifecycle and failure cases with fake GitHub/hosting services. A live pilot is still required after release and repository configuration. Its acceptance evidence should include PRs, workflow run URLs/SHAs, promotion merge commits, provider deployment SHAs, smoke results and a real pause/restart exercise.

## API

- `GET /projects/:projectId/orchestrations/:runId/delivery`: inspect fresh evidence and permitted controls; never writes to GitHub.
- `GET /projects/:projectId/orchestrations/:runId/delivery/events?afterRevision=0`: workspace/project-scoped durable audit entries.
- `POST /projects/:projectId/orchestrations/:runId/delivery/actions`: versioned, idempotent delivery control. `enable_uat`, `pause_delivery`, `resume_delivery`, `prepare_repair`, and controlled merge/preparation actions require project build access. None can target production.
- The existing repository promotion endpoint grants `dev -> uat` to developers through `project.promote_uat`; `uat -> main` still requires `project.promote`.

## Validation

Focused tests cover automatic developer delivery without PM permission; denied client access; stale revisions, changed heads and changed bases; CI policy/provider identity; rejected skipped checks; workflow edits; source-scoped repair plans; bounded retries; multi-repository readiness; network-loss reconciliation; account/project boundaries; restart persistence; and provider/SHA/HTTP failures. Full regression and UI results are recorded in the task's final response.

Local results: broad backend regression 3,493/3,493 tests (251 files); final focused backend regression after the UAT policy and gate changes 203/203 tests (13 files); final frontend regression 608/608 tests (69 files). Backend TypeScript build and frontend production build passed. The frontend build retains its existing large-chunk warning. A local browser fixture verified the developer delivery control without a PM prompt and readable evidence at desktop and 390-pixel container widths. No live UAT promotion was performed.
