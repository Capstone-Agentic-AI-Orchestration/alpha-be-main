# Plan 3 — atomic replies and private PM notes

Local checkpoint: 8 October 2026. Application-first work only; no hosted database,
Auth/SMTP configuration, real email, environment switch or deployment.
This is a service foundation, not an enabled client messaging API.

## Existing structure followed

```text
src/
  ticketing/
    communication.ts                   # strict text/action input contracts
    workflow.ts                        # existing lifecycle rules, reused
  services/
    ticketMessageService.ts            # atomic public reply / private note
    ticketMessageService.test.ts       # colocated shared-service test fixture
    ticketOperations.ts                # common retry identity and safe receipts
    ticketCommandService.ts            # reuses operations; unified lookup
  store/
    ticketMessageStore.ts              # extends existing transaction contract
    ticketCommandStore.ts              # command/message/note operation outcome
docs/client-ticketing/
  application-communication-layer.md
```

No new app, runner, runtime mock database or desktop authority. Public and private
reads reuse the existing read service. Frontend stays in `src/features/ticketing`.

## Implemented behavior

- Reauthorize the exact scoped ticket and trusted caller before validation or
  operation lookup. Existing PM web-session/verified desktop-bearer identities
  are retained; clients require their separate persisted session and ticket grant.
- Accept bounded plain text, expected workflow version and an operation ID.
  The server assigns author, audience, message identity, timestamp and tenant.
  Caller-supplied roles, attachments, timestamps, facts or status are rejected.
- PM public replies may explicitly request details or answer-and-close an
  answer-only request. Ordinary updates do not silently request client action.
  Clients may reply or send correction feedback against the exact current shared
  delivery. Existing workflow rules decide the outcome; no second lifecycle.
- Detailed public conversation requires an activated, authorized client. PM may
  record private intake notes before activation; pre-activation email handling
  remains a later integration, not a fake successful message send.
- A public message, its workflow decision, public/internal clocks, private audit,
  minimal outbox signal and operation outcome save in one transaction. Failure
  rolls them all back. Client correction feedback goes to PM triage; messaging
  never launches, resumes or reopens Issues, completes projects or releases code.
- Private notes save only the private message, internal clock, private audit and
  operation outcome. They cannot change public timestamps, shared workflow
  version, client conversation, requested action or public notification signals.
  Multiple append-only notes may share a workflow version; a stale decision
  version or terminal ticket still refuses new notes.
- Commands, replies and notes share the same tenant/ticket/actor/operation key.
  Category and validated content are fingerprinted. Reusing an ID across actions
  conflicts; identical retries return the original allowlisted receipt without
  duplicating messages. Message receipts add only message ID to the four command
  receipt fields. No body, author identity, internal project/asset fields or
  arbitrary stored fields can leak through reconciliation.
- A lost COMMIT response propagates as uncertain; the existing shared lookup
  reconciles the same ID with fresh authorization. It does not automatically
  resubmit. Lookup remains available with writes off; new/replayed writes obey
  the current feature gate. Private note outcomes are PM-only and actor-scoped.

## Real adapter and UI obligations — still pending

The test-only serialized adapter is inside the test file and proves service
behavior, not SQL locking, RLS, hosted authentication or durable delivery.
A production adapter must use one database transaction with scoped queries,
immutable insert-only messages/operations, current grant/session/member checks,
coherent evidence and compatible authorization/lock ordering. Operation categories
must not create separate uniqueness namespaces. Retain outcomes for safe recovery.

Database-authoritative clocks must remain monotonic. Public updates advance public
and internal clocks; notes advance only internal clocks. Terminal decisions must
atomically retain closure metadata. No future note query, queue counter, public
cursor or notification may indirectly expose a private write.

No router, runtime store or frontend hookup is mounted. The subsequent
[queue checkpoint](application-queue-layer.md) adds list/counter contracts.
The [creation checkpoint](application-creation-layer.md) also adds signed-in
request/recovery contracts. Authentication/CSRF, message transport/rate limiting,
public inquiry writes, private file scanning,
approved email sender/outbox worker, execution/review safeguards and recovery
remain mandatory. Emails require a later authorized provider integration; an
outbox signal alone is not evidence that any recipient received a notification.
The eventual conversation UI must render escaped plain text, handle pagination,
preserve a pending operation ID on uncertain responses and refetch current detail
after reconciliation. The current UI scene selector is not a business command.

## Verification

Focused checks: 100 communication tests, 50 command tests, 70 read tests,
78 workflow tests and 12 error-handler tests passed (310 total).
Typecheck and build passed. The stable-source full two-worker backend regression
passed: **120 files / 1,902 tests**, including all 100 communication tests.
Local tests do not satisfy the required cross-persona staging demo.

Tests cover rollback at each mutation, stale updates, duplicate/concurrent sends,
cross-endpoint ID conflicts, unknown commits, scoped recovery, corrupted stored
evidence, private clocks/notes/outcomes, inactive clients, revoked access, feature
gates, exact-delivery feedback, holds/withdrawal and read-only retained history.
The first focused run caught a test comparing JSON property order rather than
object values; deep equality fixed that assertion, with no production workaround.
