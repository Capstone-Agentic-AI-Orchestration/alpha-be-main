# Plan 3 — client activation and ticket API transport

Local, unmounted HTTP boundary checkpoint. The implementation follows the
existing `src/controllers`, `src/services`, `src/store`, `src/ticketing`, and
`docs/client-ticketing` structure. It does not connect Supabase, send email,
change environment settings, or register routes in the server.

## Added transport files

```text
src/controllers/
  ticketClientActivationController.ts  # invitation redemption boundary
  ticketClientApiController.ts         # authenticated client ticket endpoints
  ticketClientRouteFactory.ts          # provider/store-injected service composition
  ticketClientRouter.ts                # isolated router + terminal 404 boundary
  ticketClientSessionController.ts     # session, origin, cookie helpers
src/services/
  ticketClientIntakeContextService.ts  # authorized context and project choices
  ticketClientWorkspaceService.ts      # authorized workspace choices
src/store/
  ticketClientIntakeContextStore.ts    # client-scoped context lookup contract
  ticketClientWorkspaceStore.ts        # client-scoped workspace lookup contract
docs/client-ticketing/
  application-client-api-layer.md
```

The activation controller uses the same validated exact-origin policy as the
client session boundary. It requires an injected limiter that derives request
identity from the socket or explicitly trusted proxy configuration. It accepts
only the invitation token in JSON and a provider credential in the Authorization
header, then asks the injected activation service to verify the identity and
consume the one-time invitation. Its only success response is
`{ "activated": true }`. It neither creates a login session nor reveals the
ticket/workspace/contact identity.

The client API controller has a separate application interface and does not
reuse `req.session`, GitHub identity, internal workspace middleware, or the PM
ticket controllers. It uses the client session cookie and, for writes, exact
Origin checking plus the dedicated CSRF cookie/header. It sets private no-store
headers and is cloud-only. The controller currently defines:

| Method | Relative route | Purpose |
| --- | --- | --- |
| GET | `/workspaces` | List only this signed-in client's explicitly granted, client-visible workspace choices |
| GET | `/workspaces/:workspaceId/intake-context` | Resolve the client-safe creation handle and only published shared-project choices |
| GET | `/workspaces/:workspaceId/tickets` | Client's authorized ticket queue and minimal counters |
| POST | `/tickets` | Create using an approved `intakeContextId`; the service resolves the workspace |
| GET | `/tickets/operations/:operationId?intakeContextId=…` | Reconcile create after an uncertain response |
| GET | `/workspaces/:workspaceId/tickets/:ticketId` | Client-safe ticket detail |
| GET | `/workspaces/:workspaceId/tickets/:ticketId/messages` | Public PM/client conversation only |
| POST | `/workspaces/:workspaceId/tickets/:ticketId/messages` | Client reply or supported message action |
| POST | `/workspaces/:workspaceId/tickets/:ticketId/commands` | Client workflow decisions accepted by the workflow service |
| GET | `/workspaces/:workspaceId/tickets/:ticketId/operations/:operationId` | Reconcile a ticket-scoped write |

Routes are relative to the eventual `/api/client` mount. For example, the queue
would be `/api/client/workspaces/:workspaceId/tickets`. The workspace ID is a
selector only; the workspace and intake-context services resolve only active
client-service grants, and each queue/ticket service/store must recheck the
current client service grant, exact ticket grant, session binding, workspace,
and write mode. The intake endpoint omits internal project IDs and returns only
active options deliberately published to that client. Do not populate the
selector from an organization-wide project/repository list.

Queue and conversation query shapes are passed to the application service for
validation only after its transaction has rechecked authorization. Response
objects are explicitly reconstructed: PM-only queue context, internal notes,
private identities, arbitrary row fields, and provider/database values cannot
be serialized through these client routes. There is no client notes route.
Creation's `intakeContextId` is separated from the strict create payload; it is
not treated as a workspace ID or authorization by itself. Writes use existing
operation IDs for retry reconciliation rather than encouraging a second ticket.

## Still not operational

- No controller is mounted. The new router wrapper is designed to be mounted
  after CORS/body parsing but before the local-token, workspace, GitHub-session
  and internal API middleware. `index.ts` is deliberately unchanged until real
  app dependencies are ready. The wrapper terminates unknown client paths with
  a JSON 404 so they cannot fall through to internal handlers.
- `ticketClientRouteFactory.ts` composes the existing application services
  from injected stores/verifier/policies, but does not instantiate or verify
  those adapters. All persistence adapters must share the same durable
  ticket-operation/audit namespace and transaction semantics.
- No durable application/store adapters are wired to these interfaces. The
  current services are not callable through a production client endpoint.
- There is no real provider identity verifier, active session/grant persistence,
  admission limiter, approved web-origin configuration, email delivery, or
  invitation-link frontend flow.
- There is no file upload/download or live preview API. The current API carries
  only the safe result metadata that the read projection already supports.
- The frontend now has a production client portal in the existing
  `alpha-fe-main/src/features/ticketing/ClientPortal.tsx` feature folder and it
  consumes the isolated client API transport. The portal remains unavailable
  for real users because no route is mounted and no active client session can
  yet be issued; the local UI rehearsal remains a separate prototype.
- Supabase/Auth/schema, RLS, migration and SMTP work remain intentionally
  deferred to the final integration phase against the isolated staging project.

This checkpoint is transport code only. Backend and frontend typechecks passed;
no tests were added or run. It does not prove cookie behavior, authorization,
tenant isolation, provider verification, store atomicity, or email delivery.
