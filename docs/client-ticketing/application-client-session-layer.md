# Plan 3 — separate client session boundary

Local application/transport checkpoint. This follows the existing
`src/controllers`, `src/services`, `src/store`, `src/ticketing`, and
`docs/client-ticketing` folders. It does not connect Supabase, send email,
change environment configuration, or mount a route. The controllers described
here are deliberately not registered in the server entry point.

## What the boundary does

- `src/services/ticketClientSessionService.ts` accepts a provider credential
  only through an injected server-side verifier. The verifier must validate the
  issuer, signature, audience, expiry, stable user ID and verified-email claim.
- Sign-in succeeds only for a provider identity with a previously established
  active client-service grant. An identity with no Alpha grant gets the same
  generic denial as an invalid provider credential; this service never creates
  a provider account, Alpha account, workspace membership or ticket grant.
- A successful exchange creates a fresh 32-byte Alpha cookie secret and a
  separate 32-byte CSRF secret. Only purpose-separated SHA-256 hashes, provider
  user ID and timestamps enter the store. Raw credentials/secrets are returned
  only to the transport long enough to set cookies and are not logged.
- Every future request must resolve the current session hash from the store;
  there is no process cache. Ticket services still recheck the current client
  service/ticket grants on each operation. Session identity does not itself
  authorize access to any ticket.
- `src/controllers/ticketClientSessionController.ts` defines `POST
  /client/auth/session`, `GET /client/session`, and `POST
  /client/session/logout`. It is cloud-only, requires an exact configured web
  Origin for state-changing requests, requires an injected sign-in admission
  limiter, rejects request-body identity fields, and never uses Alpha's GitHub
  `req.session` or desktop `gh` identity. The limiter must derive client network
  identity from the socket or explicitly trusted proxies, not raw
  `X-Forwarded-For`.
- `src/controllers/ticketClientActivationController.ts` defines a separate,
  unmounted `POST /client/auth/activate` boundary. It requires an exact allowed
  Origin, a trusted admission limiter, an invitation token in the JSON body, and
  the provider credential in the Authorization header. It returns only
  `{ activated: true }`; activation does not start a session or return ticket,
  workspace, contact, or provider identity data.
- `src/controllers/ticketClientApiController.ts` defines the unmounted client
  ticket transport: authorized queue, create/recovery, safe detail, public
  conversation, message replies, and workflow commands. Unsafe requests require
  the dedicated client cookie, exact Origin, and CSRF cookie/header match.
  Client queue/detail/message DTOs are rebuilt from explicit allowlists; no
  internal notes route exists in this controller. The workspace ID in a queue
  URL is only a selector; the queue service/store must recheck the client's
  current workspace service grant and ticket grants for every query. Invalid or
  missing access remains non-enumerating.

## Cookie and CSRF boundary

- The production session cookie is `__Secure-alpha_client_session`,
  `HttpOnly; Secure; SameSite=Lax; Path=/api/client`, host-only, with no Domain.
- A separate CSRF cookie is `alpha_client_csrf`, `Secure; SameSite=Strict`,
  readable by the web client and `Path=/`. The client entry is served from the
  SPA root (`/#/client`), so a narrower `/api/client` path would make the token
  unreadable to its own JavaScript. The CSRF value is not an authentication
  credential; unsafe requests must send it in `X-CSRF-Token`, match the cookie
  in constant time, and match the session's stored hash.
- Insecure cookies use different `_dev` names and are accepted only with an
  explicitly configured loopback HTTP origin. The controller still refuses
  service outside cloud mode; the current UI preview remains the local path.
- `GET /client/session` returns only whether the current session is valid and
  its expiry. Logout requires the exact Origin and CSRF proof, revokes only the
  matching client session, and clears only the dedicated client cookies.

## Still pending

- A durable session/grant store and database constraints; no session records are
  currently created by the application.
- A durable rate-limit adapter and policy for provider-session exchange. The
  transport requires an admission guard and fails closed without one.
- Real provider verification, cookie-key/origin configuration and the frontend
  provider sign-in/exchange flow. No provider is configured by this contract.
- Mounting these client routers before internal `sessionContext` and
  `workspaceContext`, handling unknown client routes without falling through to
  internal handlers, and binding their application methods to durable stores.
  The current PM queue/detail transport remains separate and unmounted.
- Durable storage and app composition binding the workspace-selector endpoint
  to live client-service grants. It returns only explicitly approved choices;
  knowing a workspace ID never grants access.
- Durable storage and app composition for intake-context lookup and published
  project options; the client receives an opaque handle, not an internal project
  ID or direct repository access.
- Session cleanup/retention policy and production recovery/rotation rehearsal.

The session store contract is in `src/store/ticketClientSessionStore.ts`.
Typechecks and whitespace checks passed for this checkpoint; tests were not run.
The contract is not proof of provider validation, atomic storage, CSRF behavior,
or hosted authorization. Supabase/Auth work remains deferred to the final
integration phase.
