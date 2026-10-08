# Plan 3 — immutable registration and PM assessment

8 October 2026. Application-first step 3, with step 4 verification. This is a
local implementation checkpoint, not a live service or a completed release.

## Existing app integration

PMs stay on the existing internal portal's single **Tickets** page. Its detail
now offers prepared-result inspection, assessment and separate sharing. No new
PM app, Messages page, task engine or project management flow was introduced.
Developers continue using existing Projects, Issues and runners.

## Application flow

1. Technical readiness records the complete current reviewed Issue manifest.
2. The new internal registration service requires a trusted artifact verification
   reference resolved by its store, current completed/reviewed work, committed
   readiness and an exact immutable clean scanned bundle. It inserts a protected
   candidate, private audit and stable operation outcome atomically. It does not
   assess, share, notify the client, change the public clock or start work.
3. Authorized PMs list and inspect only candidates matching that ticket's current
   tenant, project, agreed scope and exact Issue revisions. Candidate DTOs exclude
   private provenance, object keys, scan metadata and internal identities.
4. PMs inspect all files and acknowledge review in the existing Tickets detail.
   Inspection is a UI safety prompt, not proof that a human read the content.
   The explicit assessment command independently rechecks current evidence,
   registration and scan state in its transaction; earlier inspection is not
   authority for a stale approval. The command requires a bounded read policy.
5. Sharing remains a separate PM action. Clients cannot read candidate files or
   assessed-but-unshared results through their protected delivery service.
6. Client acceptance or same-ticket agreed-work feedback follows existing review
   rules. Acceptance does not close the ticket or complete the project. PM closure
   is separate; corrections do not automatically restart runners.

Both candidate and existing delivery content use one bounded reader. Storage I/O
stays outside metadata transactions; exact length/digest verification and a second
fresh authorization/manifest check precede byte release. PM content uses bounded
base64 JSON for the existing desktop cloud relay. Clients retain separate
same-origin binary reads. Neither receives signed URLs or arbitrary URL fetching.

## Folder ownership

- `src/ticketing/technicalReadiness.ts`: canonical exact revision manifest helpers.
- `src/ticketing/deliveryReadModels.ts`: shared immutable bundle validation.
- `src/store/ticketDeliveryRegistrationStore.ts`: trusted artifact/atomic insert contract.
- `src/store/ticketDeliveryAssessmentStore.ts`: scoped fresh candidate read contract.
- `src/services/ticketDeliveryRegistrationService.ts`: internal registration/recovery.
- `src/services/ticketDeliveryAssessmentService.ts`: PM-only candidate inspection.
- `src/services/ticketDeliveryContent.ts`: shared bounded and reauthorized content reader.
- `src/services/ticketCommandService.ts`: fresh assessment evidence in the write transaction.
- `src/controllers/ticketPmDeliveryCandidatesController.ts`: scoped paginated PM endpoint.
- `src/controllers/ticketPmRouteFactory.ts`: dependency-injected existing namespace composition.

Frontend controls follow `src/features/ticketing`; regression/browser scripts
stay under existing test conventions and `scripts`. The serialized in-memory
fixture in `src/test` is test-only and must not be used as a runtime adapter.

## Gates still open

- These factories remain unmounted in `src/index.ts`; no real ticket operation is enabled.
- Implement trusted persisted artifact verification and real immutable storage/
  scanning. TypeScript subjects and `clean`/`immutable` flags alone prove nothing.
- Implement durable stores with shared lock order for tenant grants, revocations,
  revisions, reviews, scan invalidations and claims. Enforce insert-only operation
  and exact-bundle uniqueness. Do not hold a database transaction across provider I/O.
- Connect trusted readiness/artifact events without discarding temporarily
  ineligible events or replaying ambiguous commits as new operations.
- Complete actual runner claim/release safeguards without changing unrelated work.
- Complete client provider authentication/activation, document intake, email,
  isolated authenticated previews and admission/resource controls.
- Supabase stays last: staging-only persistence and cross-persona concurrency,
  revocation, compatibility and security acceptance precede enablement approval.

## Verification

- Backend full suite: **134 files / 2,410 tests passed**; typecheck passed.
- Frontend full suite: **21 files / 257 tests passed**; typecheck/build passed
  (existing production chunk-size advisory).
- Real-component browser rehearsal passed corrupt-file refusal, all-file PM
  inspection, uncertain-assessment recovery, separate sharing, client acceptance
  recovery, explicit closure, same-ticket correction and no automatic restart.
  Zero real API calls/page errors; mobile overflow checks passed and PM desktop/
  mobile captures were inspected.
- Local tests cover authorization, manifest/scan drift, duplicate operations,
  rollback/CAS, unknown commits and protected reads. They do not prove real
  distributed locks, hosted identity, malware detection or absence of regressions.
- No Supabase, environment, desktop source, email, deployment, branch, commit or
  push changes at this checkpoint. Shared/live database remains untouched.
