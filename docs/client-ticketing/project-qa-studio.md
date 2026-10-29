# Project QA Studio

Implemented locally on `feat/client-project-qa-studio`. This is a project-owned PM/client UAT review module. It does not dispatch builds, merge branches, authorize agents, accept deliveries or close tickets.

## Required order

1. PM opens the selected project's **QA Studio** and selects a frontend and an eligible client.
2. The server verifies a ready Vercel deployment whose GitHub ref is exactly `uat`, whose hosting project belongs to the attached repository, and whose source SHA exists. Attached backend repositories require their ready Render `uat` deployment and commit too.
3. PM saves an internal checklist draft. The client cannot list it or open its preview through the portal.
4. PM reviews the actual UAT preview, explicitly marks that build reviewed and ready, then hands it off to the selected client.
5. Client opens **Projects → selected project → QA Studio**, records each check, optionally attaches screenshots, and submits the saved review.
6. PM records private correction/clarification/new-scope triage, optionally links an existing issue in the same project, and prepares a new round after fixes reach UAT. Every new round needs its own PM review and handoff.

Existing project feedback remains private per recipient. Client feedback drafts are keyed by workspace/project. Published definitions and submitted results remain frozen; draft edits clear PM readiness. Publishing supersedes that recipient's prior open round while preserving its findings.

## Authority and provenance

- All records use composite workspace/project/client keys. Client reads, mutations, receipt lookup and evidence downloads recheck the session, active service grant, actual visible linked ticket and exact active ticket grant.
- PM authority uses the authenticated workspace and active PM membership. Payload role/workspace/client assertions never replace it.
- Provider calls occur outside database transactions. Commands then reauthorize and lock the project/round before writing. Versions prevent lost updates; actor-scoped operation receipts reconcile unknown outcomes.
- The selected frontend uses its immutable deployment URL. Writes and publication revalidate the current frontend/API manifest. Any deployment/commit change requires PM review and a new round. The old build and findings remain historical evidence.
- Configuration-only project/ticket preview URLs are no longer returned to clients. Only an explicitly PM-reviewed, published UAT round can supply client preview shortcuts. Historical `main` records are retained for internal compatibility; new preview writes accept only `uat`.
- Backend deployment URLs are mutable. Runtime configuration and test data are not versioned by this module. Commit provenance and provider snapshots do not guarantee a hermetic application environment.

## HTTP contracts

PM, through the existing authenticated `/api/tickets` surface:

- `GET /projects/:projectId/client-preview` repairs the existing settings read.
- `GET /projects/:projectId/uat/targets`
- `GET /projects/:projectId/uat/preview?repository=owner/repo`
- `GET /projects/:projectId/uat/rounds?clientId=...&before=...`
- `POST /projects/:projectId/uat/rounds` with `{operationId,clientId,repository,title,items:[{title,steps,expectedResult,required}]}`.
- `GET /projects/:projectId/uat/rounds/:roundId`
- `PUT /projects/:projectId/uat/rounds/:roundId` with `{operationId,expectedVersion,title,items}`; drafts only.
- `POST /projects/:projectId/uat/rounds/:roundId/commands` with `{operationId,expectedVersion,action:'ready'|'publish'|'withdraw'}`.
- `POST /projects/:projectId/uat/rounds/:roundId/items/:itemId/triage` with `{operationId,expectedVersion,classification:'correction'|'clarification'|'new_scope',note,issueId:string|null}`.
- `GET /projects/:projectId/uat/operations/:operationId`
- `GET /projects/:projectId/uat/rounds/:roundId/evidence/:evidenceId/content`

Clients, through `/api/client/projects/:workspaceId/:projectId/uat` using the existing client cookie session:

- `GET /rounds?before=...` and `GET /rounds/:roundId`; no internal drafts or other recipients.
- `PUT /rounds/:roundId/items/:itemId/result` with `{operationId,expectedVersion,status:'not_tested'|'passed'|'failed'|'blocked',notes,reproduction,device}`.
- `POST /rounds/:roundId/submit` with `{operationId,expectedVersion}`.
- `POST /rounds/:roundId/items/:itemId/evidence` with raw PNG/JPEG bytes and the existing URI-encoded `X-Alpha-Ticket-Document` metadata `{operationId,filename,contentType}`.
- `GET /rounds/:roundId/evidence/:evidenceId/content` and `GET /operations/:operationId`.

Every client write requires the existing allowed Origin and CSRF token. Unknown schema fields are rejected. Failed checks require notes and reproduction; blockers require notes. Required untested checks block final submission. Submission determines `passed`, `changes_requested` or `blocked` from saved results; it invokes no ticket workflow commands.

## Rollout

Apply both additive migrations before deploying this backend:

1. `20261028110000_client_project_uat.sql`
2. `20261028110100_client_uat_evidence.sql`

Deploy the backend and frontend together using their existing procedures. No workflow files were changed. The PM router retains the existing `ALPHA_TICKETING_TRIAGE_ENABLED=1` gate, authenticated workspace/session and desktop cloud relay. The existing client portal composition and grant/write-mode gates remain in effect. No new environment variable is introduced.

For an application rollback, disable the existing client ticketing/triage surface before restoring older application versions, so older preview-sharing behavior cannot bypass the PM-first rule. Preserve the additive QA tables and private evidence. Do not drop populated tables or remove retained objects as part of an application rollback.

Hosting verification uses the existing server-side Vercel and Render configuration. The browser receives no provider token or backend environment variables. Commit manifests are restricted to the PM; client responses carry only the review version and safe preview projection. Actual provider metadata, deployment protection and framing behavior must be verified in the target environment; a preview that cannot be framed retains an external-link fallback.

## Screenshot storage and retention

Reuse the existing private `alpha-ticket-documents` bucket and server-only Supabase storage adapter. No public Storage policy is added. UAT files live in a separate hashed namespace with per-round/item metadata in `client_uat_evidence`; browser roles cannot query it. Each check allows at most 10 screenshots, each PNG/JPEG up to 3 MB. Signature/type and SHA-256 checks run before an attachment becomes available; download rechecks authority and integrity and returns bytes, never a reusable Storage URL.

Upload reserves a pending record, writes/verifies the private object, then reauthorizes and finalizes it. Retry the same operation ID/file after uncertainty. Pending records are never listed or downloaded. A failed, superseded or withdrawn upload can leave a pending private object. There is no automatic deletion job: do not delete available evidence while a review is retained. Operational cleanup must reconcile pending metadata with the corresponding exact storage path before removing abandoned objects; deleting a project cascades database metadata but does not delete Storage objects. Retention/deletion scheduling remains an operational rollout decision, matching the existing ticket document storage boundary.

## Verification limits

PGlite tests run the actual complete migration schema and validate PM-first handoff, scope/recipient isolation, freshness, frozen rounds, revisions, replay, evidence integrity and private triage. Provider tests use injected provider clients. The frontend browser rehearsal uses synthetic HTTP fixtures and blocks external requests; it exercises real components, desktop/mobile layout, client draft preservation, handoff, screenshots, triage and retest.

These checks are local evidence. They do not prove production migration application, deployed router/feature-gate settings, provider credentials, real storage permissions or a live client's UAT session. Automated Playwright execution and production promotion remain outside this feature.
