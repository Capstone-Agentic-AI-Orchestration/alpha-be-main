# Plan 3 — protected delivery inspection checkpoint

8 October 2026. Application-first step 3, with local verification from step 4.
This is not completion of the original twelve-phase plan or a live service.
Supabase, environment files, desktop source, real accounts, email and deployment
were not touched during this checkpoint. No new branch, commit or push.

This historical checkpoint is supplemented by
`application-delivery-registration-assessment.md`: local registration and fresh PM
assessment now exist, but real stores/providers and route enablement remain deferred.

## Implemented locally

- `src/store/ticketDeliveryStore.ts`: authorized metadata transaction and private,
  version-addressed object-reader interfaces, following existing store folders.
- `src/ticketing/deliveryReadModels.ts`: exact delivery/scope/revision/asset pin
  validation; explicit public metadata allowlist; per-file and aggregate budgets.
- `src/services/ticketDeliveryService.ts`: authorization before reads, no storage
  I/O in transactions, bounded/timed object reads, exact size/SHA-256 validation,
  owned buffers, and fresh authorization/manifest comparison before releasing data.
- The existing isolated client API factory now requires these dependencies. Its
  manifest/content endpoints remain unmounted, like the other ticket routes.
- Frontend `src/features/ticketing/ClientDeliveryFiles.tsx` adds protected files
  to the existing Ticket Detail result card, using the real client-only transport.
  It verifies scope, size and digest; malformed or unavailable files cannot create
  a download. Leaving the view cancels requests. No internal API/local token is used.
- Existing GitHub login, internal Projects/Issues and runners remain unchanged.

Routes within `/api/client`:

```text
GET /workspaces/:workspaceId/tickets/:ticketId/deliveries/:deliveryId
GET /workspaces/:workspaceId/tickets/:ticketId/deliveries/:deliveryId/files/:fileId
```

Clients can read only the current deliberately shared delivery. An authorized PM
can inspect an assessed unshared delivery through the application service. PM HTTP/UI
inspection was added in the subsequent `application-result-review-loop.md` checkpoint.
Retained authorized history reads
remain possible in disabled/maintenance mode; these endpoints do not mutate work.
An old delivery ID is not a capability to inspect a superseded result.

File support at this checkpoint is non-inline attachment download for permitted
plain text, PDF, PNG and JPEG. HTML/SVG/executables are not served on the app origin.
Archives, other formats and executable web previews need their own approved
inspection/security handling; they are not represented by invented preview links.
Private object keys, storage generations, scanner metadata, Issue revisions,
internal notes, PM identifiers and repository URLs never enter the client DTO.

## Required durable integration contracts

1. Implement one durable scoped manifest store and private version-addressed
   object reader. A TypeScript `immutable`/`clean` flag is not proof that a real
   object is immutable or scanned. Registration must bind each permitted file's
   exact bytes, validated media type, digest, scan verdict/policy and object version
   to the correct ticket/scope/work manifest. Provider/scanner failure must not
   publish the file; quarantine is not a clean verdict.
2. Enforce streaming byte caps and AbortSignal cancellation inside the actual
   reader, before allocating a full object. The service also checks the complete
   body, but cannot undo an unsafe adapter's earlier unbounded allocation. Use
   private credentials/server-selected locations only; never fetch a supplied URL.
3. Serialize membership/session/grant revocation, delivery pointer changes and
   scanner invalidation with both metadata authorization transactions. The second
   check is the read's authorization decision, not a promise to recall already
   downloaded bytes after a later revocation. Test this against real staging.
4. Register immutable deliverables and connect PM assessment/sharing to the same
   exact manifest. Command `loadFacts` must verify fresh ownership, complete current
   work/review evidence and clean pinned manifest state, not infer it from a label
   or branch URL. Neither this read service nor an upload automatically assesses,
   publishes or accepts a delivery.
5. Mount only after real client sessions/grants, admission/resource budgets, the
   approved HTTPS origin, private storage/scanning and durable app stores exist.
   Test proxy compression/content headers, cancellations, oversized streams,
   storage denial, timeout, tampering and revocation. Never enable process-memory
   test fixtures as the production adapter. No public or long-lived signed URL fallback.
6. Implement immutable, isolated/authenticated application previews separately.
   Existing stable branch previews can change while work continues and are not
   automatically client-safe snapshots. No generic repo/build-room artifact API
   becomes available to clients through this feature.
7. Add PM result registration/technical assessment and execution/release guards.
   The subsequent review-loop checkpoint adds local sharing and client decision
   controls, still dependent on unmounted durable services. A visible summary or
   failed download is not treated as inspection. Document intake remains separate.

## Verification

- Backend: 129 files / **2,267 tests passed**, including 79 focused delivery service
  and HTTP-boundary tests; typecheck passed.
- Frontend: 17 files / **202 tests passed**; typecheck and production build passed.
  The existing chunk-size advisory remains. A sandbox-only Vite `realpath` denial
  was resolved by rerunning the build with permission, not changing app config.
- Optional `scripts/test-ticketing-client-delivery.mjs` exercised the real client
  detail, real same-origin transport, successful pinned download, corrupt bytes,
  revoked access, wrong scope and mobile overflow. **Zero real API requests and
  zero page errors**; every fixture is confined to the intercepted browser test.
- Desktop/mobile screenshots were inspected. Whitespace checks passed.

These checks prove local application behavior, not real hosted Auth/RLS, storage
immutability, malware detection, distributed revocation or a completed client
journey. The original acceptance and staged rollout requirements remain open.
