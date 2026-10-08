# PM ticket API composition checkpoint

Date: 8 October 2026. Plan 3; application-first sequence. The PM route is now
split into an opt-in, read-only mounted slice and a still-unmounted mutation
slice. The read slice uses the PostgreSQL queue/detail adapters and is disabled
by default.

## What was missing

The PM queue, detail, conversation reads, workflow commands, and invitation
issuance each had a controller, but there was no PM endpoint for sending a
public reply or saving a private note, and no composition factory exposing the
PM page as one route boundary. The one-page PM Tickets UI therefore had no
complete transport contract for its conversation actions.

## What this checkpoint adds

- `src/controllers/ticketMessageController.ts`: PM-only `POST /:ticketId/messages`
  and `POST /:ticketId/notes`. Workspace and actor are derived from the existing
  authenticated request context. Replies and notes use the existing message
  service, strict command input, operation identity, safe receipt projection,
  desktop-to-cloud relay, and service authorization. Notes stay internal.
- `src/controllers/ticketPmRouter.ts`: composes queue, detail, messages, notes,
  workflow commands, command-receipt lookup and invitation issuance under one
  PM namespace. Unknown routes terminate with a private no-store 404.
- `src/controllers/ticketPmRouteFactory.ts`: injects the existing service/store
  contracts into that router. No singleton database, environment key, Auth
  provider, email sender, or runtime configuration is created here.
- The PM boundary also composes `POST /:ticketId/scopes`, which writes the
  client-visible scope summary and private developer brief as one immutable
  version together with the existing `propose_scope` transition. See
  `application-scope-layer.md` for its idempotency and post-authorization rules.

The intended mount point is `/api/tickets`, **after** existing internal session
and workspace middleware. The queue and every ticket ID are scoped from that
authenticated workspace, not from caller-supplied workspace/body fields.
Desktop PM requests continue to relay to the cloud authority; they never use a
local ticket database. Before production wiring, all injected stores must share
one durable authority and atomic operation/audit namespace.

The existing frontend now mounts a PM-only Tickets view and consumes the typed
transport. It presents queue/detail, separates public conversation from private
notes, distinguishes ordinary updates from the workflow's `request_details`
action, and follows queue/message cursors. The PM queue projection includes
`clientAccessActive` for display gating; server-side message, note, and workflow
authorization remains authoritative. The page does not offer invitation sending
because no email delivery is connected.

## Read-only slice and remaining work

The read-only factory is mounted in `index.ts` after existing session and
workspace middleware only when `ALPHA_TICKETING_READS_ENABLED=1`. The default-off
boundary preserves desktop-to-cloud relay behavior without local ticket
persistence. The complete PM factory (commands, replies/notes, invitations,
scopes and delivery operations) remains unmounted because its durable
transaction stores are incomplete. Public intake and email delivery are also
not connected. Invitation issuance at the service boundary does not send email.
Do not enable the read flag against a database without the ticket migrations.

Verification for this source checkpoint: backend and frontend
`npm run typecheck` passed. No tests were added or run, no environment values
were read, and no Supabase, deployment, invitation, or repository push was
touched.
