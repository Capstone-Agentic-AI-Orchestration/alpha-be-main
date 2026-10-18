# Plan 3 — immutable PM scope proposal

Local application checkpoint: 8 October 2026. This follows the backend's
existing `src/ticketing`, `src/services`, `src/store`, and `src/controllers`
layout. It does not install a database adapter or mount a route.

```text
src/ticketing/scopeProposal.ts             # strict versioned proposal input
src/store/ticketScopeStore.ts              # same-transaction persistence contract
src/services/ticketScopeService.ts         # scoped authorization, proposal, replay
src/controllers/ticketScopeController.ts   # PM-only POST /:ticketId/scopes
src/controllers/ticketPmRouteFactory.ts    # injects scope store into PM boundary
```

The PM submits two distinct text fields:

- `publicSummary`: the work the client is being asked to agree to.
- `developerBrief`: private implementation notes; it is not part of a client
  read projection and is only eligible for a developer with project access after
  client agreement and separate PM work authorization.

One request creates a new immutable scope version and applies the existing
`propose_scope` workflow transition in the same transaction. The transaction
also records the audit, change signal, command receipt and proposal-specific
idempotency record. Retries with the same operation ID and same content return
the original receipt; reusing the ID for different content is rejected. The
response contains only the ticket/operation/version/status and new scope version
ID. No project, Issue, run, invitation, email or release is created here.

The PM detail projection may separately load the current developer brief as an
internal field. Client reads use only the public summary; the read model rejects
a client projection if the adapter supplied the PM-only brief.

Scope can be proposed or revised while a ticket is under review or awaiting the
client, before work authorization. After a project or Issue manifest is
authorized, this ticket's scope is locked: new or changed work must use a linked
ticket, while defects against agreed work use the existing targeted-correction
path. The proposal command therefore cannot clear authorization while existing
Issues are queued or running. This prevents the ticket from appearing to restart
or orphaning active work.

## Not live yet

The store is an interface only. There is no production adapter, database schema,
mounted PM route, client invitation email, or UI connection to a running ticket
service. The backend typecheck passed; no tests were run. The UI/API contract is
local application work and must not be described as a live submission path until
those separate integration gates are completed.
