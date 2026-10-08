# Staging sign-in setup: owner confirmation needed

Checkpoint: 8 October 2026. This is a read-only inspection checklist, not
permission to change provider settings or send invitations. The user is unsure
whether custom SMTP has already been configured.

Target: **Alpha Ticketing Staging**, project `pvbppmajgsbkrnvxlzrn`.
Never use shared/live `gupmckxxaaxlameekihy` for this exercise.

## What the owner should check

1. Open staging Authentication → Email → SMTP. Report only whether custom SMTP
   is enabled; do not share the host credentials, password, API keys or screenshots
   containing secrets. If enabled, confirm that its sender is approved for tests.
2. Open staging Authentication → URL Configuration. Confirm the intended client
   web origin and exact callback allowlist. Do not broaden a wildcard or replace
   the live site's URLs. Local browser tests and coworker-accessible hosting are
   different environments; do not present localhost as an externally usable URL.
3. Choose an approved test recipient. Default Supabase SMTP only delivers to
   organization-team addresses; do not invite a client to the Supabase organization
   merely to bypass this restriction. External recipients need a custom sender.
4. Confirm whether any emails may be sent and to whom before running a real
   invitation/sign-in exercise. No test email has been sent by this implementation.

Installed MCP tools cannot read or change Auth/SMTP configuration. Database
health, schema parity and local tests do not establish email readiness.

## Implementation boundaries

- Existing PM/developer GitHub login and internal cookies remain unchanged.
- Client identity gets its own session, CSRF and grant checks; no workspace
  membership, repository access or Alpha internal database-token exchange.
- Initial inquiry stays the same ticket after approved invitation activation.
- Returning passwordless sign-in explicitly disables automatic user creation.
  Initial activation is a distinct, server-approved invitation flow.
- Verify provider proof server-side; never authorize from user-editable metadata
  or a supplied workspace/project ID. Recheck live grants and revocation.
- Auth email and application ticket-update email are separate integration paths.
  Configuring Supabase SMTP does not implement the application's notification worker.
- Public intake remains text-only; documents require authenticated authorized
  ticket access and the later private quarantine/scan/versioning pipeline.

Before activation, complete the remaining Phase 1 isolated configuration/recovery
and operational gates in `phase-1-contracts.md`. Do not enable a partial public
login to work around missing configuration.

Sources: [SMTP](https://supabase.com/docs/guides/auth/auth-smtp),
[passwordless login](https://supabase.com/docs/guides/auth/auth-email-passwordless),
[redirect allowlist](https://supabase.com/docs/guides/auth/redirect-urls).
