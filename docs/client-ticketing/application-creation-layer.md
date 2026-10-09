# Plan 3 — authenticated request creation and inquiry validation

Local checkpoint: 8 October 2026. Application-first work only. No hosted database,
Auth/SMTP setting, real email, environment switch or deployment. These services
remain unmounted and the UI rehearsal is not connected to them.

## Existing structure followed

```text
src/ticketing/intake.ts                    # strict small input contracts
src/services/ticketCreationService.ts      # client create and recovery
src/services/ticketCreationService.test.ts # colocated test-only adapter
src/services/ticketOperations.ts           # shared safe operation receipts
src/store/ticketCreationStore.ts           # scoped transactional persistence
src/store/ticketCommandStore.ts            # create outcome in shared namespace
docs/client-ticketing/application-creation-layer.md
```

No separate app, runner, desktop ticket authority or runtime in-memory database.
Existing read/command services can authorize/read the created ticket and resolve
its creation operation through the same ticket-scoped recovery path.

## Signed-in client request behavior implemented

1. Only a verified external client subject enters this service. Resolve an
   approved intake-context handle to its exact current session, service grant,
   client and workspace before parsing the body. The handle is a selector, not
   authorization or an internal workspace/project picker. The future controller
   must extract it through a narrow route/input contract and validate live access.
2. Refuse new/replayed writes if feature mode is absent/off/maintenance or new
   intake is disabled. Retained authorized lookup remains available. Neither
   creating a request nor selecting a company grants internal workspace membership.
3. Accept title, description, operation ID and optional authorized follow-up link,
   desired calendar date and project preference. Inputs cannot supply author,
   email identity, status, timestamp, reference, grant, internal project ID or
   attachments. Defaults and trimmed text are canonicalized for duplicate checks.
4. Serialize the create-operation key even when absent. Its uniqueness covers
   workspace/client/operation ID; changing approved contexts in the same workspace
   is not a duplicate-creation escape hatch. Context and content are fingerprinted.
5. A matching existing outcome requires fresh access to the created ticket before
   returning the original receipt or revealing a changed-payload conflict. Later
   status changes do not rewrite that original creation outcome. The dedicated
   `ticket_creation_operations` row is both the idempotency key and recovery
   index; the ticket, grant, audit, signal and row commit atomically.
6. New linked tickets require access to the exact same-workspace, same-client
   original. Closed history can be referenced but is not changed. A follow-up
   inherits no project, scope, Issue manifest, agreement or work authorization.
7. Shared-project preferences resolve only through active explicitly published
   client options. New project/Not sure needs no repository access. This records
   a preference for PM review: it does not link/create projects, authorize work,
   grant project access, start agents or promise a requested deadline.
8. Generate the opaque ticket ID and atomically allocate the reference on the
   server. Never use browser/list counts. Insert Received workflow/header and
   submitted preferences, create the exact client-ticket grant, and verify access
   before saving minimal private audit, change signal and operation records.
9. Ticket, grant, audit, signal and creation-operation row commit in one store
   transaction. Any failure rolls them all back; reference sequences may
   legitimately have gaps. Different operation IDs are intentional new requests,
   not guessed duplicates based on matching titles or email addresses.
10. A lost COMMIT propagates as uncertain. The client must retain its operation ID
    and reconcile, not invent another ID and resubmit. Recovery returns only
    ticket ID, reference, original version/status and operation ID, never body,
    contact, internal actor/project IDs or arbitrary stored extra fields.

Creation outcomes use the dedicated `ticket_creation_operations` table in the
reviewed schema; that row also enables recovery when the browser never received
the generated ticket ID. The command store checks this row when validating a
client operation ID, so an ordinary command cannot reuse a create ID for that
ticket. This is one logical operation namespace, not duplicate persistence.

## Public inquiry — local service boundary, not yet operational

The public input contract requires full name, email, title and description, with
optional company and desired date. Contact email remains unverified and cannot
grant access, select a workspace or bind an account. Files and caller-owned
workspace/client/project/status fields are rejected. Calendar dates are checked
for actual validity, including leap years, rather than accepted as arbitrary text.

The public-intake service accepts a published entry slug, a strict inquiry body,
and server-observed origin/address context. Its guard checks the allowed HTTPS
origin and HMACs the server-resolved address; it charges a durable
source/entry budget before parsing, then defines a single transaction for the
unactivated `Received` ticket, private contact/preference record, audit/signal,
and HMAC-fingerprinted idempotency outcome. Anonymous callers receive only a
generic `{ received: true }`; there is no ticket ID/reference, account lookup,
ticket grant, access link, email verification claim, project, or work authority.
The PM detail projection can read submitted date and explicitly labels contact
as unverified; the client projection never includes that contact. See
[the public intake checkpoint](application-public-intake-layer.md).

The cloud HTTP route is feature-gated and connected to the production database
adapter. Origin validation plus durable rate limits are not equivalent to CAPTCHA:
non-browser callers can forge Origin. Client activation persistence and email
delivery remain separate features. The provider-neutral activation transaction contract is in
`application-client-activation-layer.md`.
The inquiry stays unactivated until a later invitation flow binds the verified
client to this same ticket; it must not create a duplicate through the signed-in
New Ticket service. PM/client conversation begins only after activation. The
provider-neutral eligibility gate is documented in
`application-client-activation-layer.md`.

## Real adapter, reads and UI obligations

- Prove current session binding, service/ticket grants, context activation and
  compatible lock/check ordering with concurrent revocation. Readonly access to
  unrelated projects is never inferred from the selected option.
- Use one connection/transaction, database constraints and correct absent-key
  serialization. Keep creation-operation keys unique and insert-only; do not
  duplicate them in `ticket_operation_receipts`.
  Do not drop/prune them in a way that makes an old operation executable again.
- Bind the client intake-context/project-option lookup contract to real scoped
  storage for the client form. No fabricated company catalogue or full internal
  workspace dropdown.
- Add explicitly mapped submitted-preference/desired-date detail projections
  for PM and appropriate client display; never serialize the private request
  record or turn a preferred project into a published project link.
- Preserve the original request separately from public follow-up messages and
  immutable approved scope/documents. Authenticated file intake is still separate.
- Bind the unmounted client create/recovery route in
  `application-client-api-layer.md` to durable stores and real client
  authentication/CSRF/origin/rate-limit adapters before API enablement. Integrate
  the durable outbox with the approved sender later. A saved signal is not a
  delivered email or an approved execution instruction.
- Complete the required hosted Auth/grant/persistence/file/recovery tests and
  cross-persona web/desktop staging demo before claiming production functionality.

`PostgresTicketCreationStore` now runs against the checked-in schema in local
PGlite tests. This verifies SQL shape, transaction rollback, authorization joins,
and the dedicated creation-operation row without connecting to hosted Supabase.
It does not prove hosted RLS behavior, provider verification, multi-process
contention/load, or cross-machine operational recovery. The colocated service
fixture still covers application-level simultaneous replay and adversarial
failures.

## Verification

Focused checks passed: 108 creation/intake tests, 100 message tests, 87 queue,
70 read, 50 command and 78 workflow tests (493 total). Typecheck and build passed.
The final stable-source two-worker backend regression passed: **122 files /
2,097 tests**, including all 108 creation/intake cases. Tests include exact
grants, linked read-only history, private project options, desired-date validity,
cross-client/workspace/context isolation, key conflicts, grant/session revocation,
corrupt recovery evidence, ambiguous commit and failure at every mutation stage.

Extending the operation union exposed one prior test's broad message-only type
guard. It now narrows to message/note explicitly; runtime permission checks were
not relaxed. No actual client login, public submission or hosted email is proven
by these local tests.

The public-intake service/store and PM/client request-detail projection were
added after that regression run. The signed-in creation PostgreSQL adapter now
has a separate local PGlite suite; no public HTTP/provider integration or hosted
database connection is claimed.
