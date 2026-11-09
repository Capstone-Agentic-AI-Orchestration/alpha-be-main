# Client project portal backend

These routes are additive. Ticket chat and document routes keep their existing
semantics. Shared-project ticket creation now links the request to the selected
project when it is created. Apply the accompanying migration before deploying
this backend. No environment variables are added.

## Client API (client cookie session)

- `GET /api/client/projects` -> `{items:[{workspaceId,projectId,intakeOptionId,name,updatedAt,preview}]}`.
  Preview is `{repository,branch:'main'|'uat',url}` or null. The option ID is
  exactly the existing intake-context option for this client/workspace/project.
- `GET /api/client/requests?limit&after&search&filter`
- `GET /api/client/projects/:workspaceId/:projectId/requests?limit&after&search&filter`
  Both return `{items,nextCursor,counters}`. Items contain the existing client
  ticket queue fields plus `workspaceId`, `projectId`, `projectName`,
  `requestedProjectName` and `projectLinkStatus:'linked'|'pending_review'|null`.
  Actual project fields are null unless that ticket's actual link is visible.
  A new request that selects an existing shared project is linked to it during
  creation, so it appears in that project's request list immediately while the
  PM review status remains `received`. `not_sure` and `new_project` requests stay
  unlinked. Older pending preferences remain labeled separately and can appear
  in project requests only while another visible linked ticket authorizes this
  client's access; otherwise they remain in global requests with project metadata hidden.
  Filters: `all` (default), `open`, `history`, `needs_client`. Limit 1–100,
  default 25. Search matches ticket reference/title. Sort is public update time
  descending, then workspace ID and ticket ID descending. Cursors are opaque
  encoded workspace/ticket pairs; invalid,
  inaccessible or out-of-filter cursors return 404. Counters cover all authorized
  tickets in the endpoint scope, independent of search/filter/page.
- `GET /api/client/projects/:workspaceId/:projectId/preview/messages?limit&before`
  -> `{items:[{id,author:'pm'|'client',body,createdAt}],nextCursor}`.
  Returns the newest page in chronological display order; `before` loads older
  messages. Limit 1–100, default 25.
- `POST /api/client/projects/:workspaceId/:projectId/preview/messages`
  body `{schemaVersion:1,operationId,body}` -> `{messageId,operationId}`.
  Requires the existing allowed origin and CSRF token. Body is trimmed, 1–4000
  characters; operation ID is 1–200 trimmed characters. Unknown fields rejected.
- `GET /api/client/projects/:workspaceId/:projectId/preview/messages/operations/:operationId`
  -> prior `{messageId,operationId}`; 404 when absent or no longer authorized.

Project access requires an unexpired client session, active service grant and
an active, unrevoked exact ticket grant for a ticket actually linked to that
workspace/project with `project_client_visible=true`. A preference, option ID
or preview row never grants access. Returned project names come from currently
authorized project records; no internal task data is returned.

## PM API (selected authenticated workspace)

- `GET /api/tickets/projects/:projectId/client-preview`
  -> `{preview:{repository,branch,url}|null}`.
- `PUT /api/tickets/projects/:projectId/client-preview`
  body `{preview:{repository,branch,url}|null}` -> `{preview}`.
  Uses existing HTTPS Vercel URL and `main`/`uat` constraints. A null value
  removes the project-level preview without deleting historical feedback.
- `GET /api/tickets/projects/:projectId/client-preview/messages?clientId&limit&before`
- `GET /api/tickets/projects/:projectId/client-preview/clients`
  -> `{items:[{clientId,displayName}]}`. Only clients currently authorized by
  active grants on actual visible linked tickets are listed, once per client.
  PM message items additionally include `clientId`; client items omit it.
- `POST /api/tickets/projects/:projectId/client-preview/messages?clientId`
  Same message request/response as client POST.
- `GET /api/tickets/projects/:projectId/client-preview/messages/operations/:operationId?clientId`
  Same receipt lookup contract as the client endpoint.

Every PM route rechecks current PM membership in the selected workspace and
the project's workspace ownership. Desktop calls use the existing cloud relay.
Feedback is per client. `clientId` may be omitted only when exactly one client
currently qualifies for this project; multiple clients return 400
`project_thread_client_required`. A supplied inaccessible client returns 404.
PM and client replies share only that client's project thread, never other
clients' messages. PM service/ticket eligibility is rechecked on every call.

## Retry and frontend integration

Message IDs are unique per workspace/project/client/author/operation. Retrying
the same operation and normalized body returns the original receipt; changed
body reuse returns 409. Receipt lookup is scoped to the authenticated sender.
Read/lookup remain available when writes are disabled, as long as access remains.
An uncertain production COMMIT uses the existing `transaction_outcome_unknown`
response with `reconciliationRequired:true`.

The frontend should wrap POST plus the new lookup in its existing
`withOperationRecovery` helper. Retain the same operation ID and payload during
reconciliation and retry; assign a new ID only for a new send. No frontend files
are changed in this backend slice.

For a client-created request under a shared project, load the existing workspace
intake context and select that project's exact `intakeOptionId`; submit it as
`projectPreference:{kind:'shared_project',optionId:intakeOptionId}`. Existing
server authorization rechecks the option and atomically links the new ticket to
that already-shared project. The ticket appears in the project's request list
immediately, still awaiting PM review. The project link is organizational: it
does not authorize work or grant new project access. `not_sure` and `new_project`
requests remain unlinked for PM review. The frontend exposes this project-scoped
New Request action only when the existing intake context allows creation.
This does not create a second ticket workflow or authorize work.

## Persistence and compatibility

`alpha_private.client_project_previews` stores project-level previews.
`alpha_private.client_project_messages` stores isolated client feedback and
idempotency keys. Both are server-only, RLS-enabled, with browser-role grants
revoked and composite workspace/project foreign keys.

Existing per-ticket previews are deliberately retained and not copied into
project-level previews: promoting a client-specific ticket preview to every
client on a project requires an explicit PM decision. Project previews start
null until set by the new PM endpoint. Existing ticket preview links keep working.
These APIs do not add iframe hosting, delivery acceptance, notifications or
automatic work authorization. New Request remains limited to an existing shared
project and its existing intake option.
