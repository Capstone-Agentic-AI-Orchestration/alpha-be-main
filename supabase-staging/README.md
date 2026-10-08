# Isolated ticketing staging baseline

This directory is a separate, staging-only migration workspace. It is **not** a
replacement for the historical `../supabase/migrations` directory and must never
be used to bootstrap or reset shared/live. No CLI project link, credentials,
application environment switch, user invitation, Storage copy or deployment has
been created here.

On 7 October 2026 the user approved matching the deployed live baseline, excluding
repository migrations 0016/0017. Read-only inspection of live supplied its 15
recorded migrations and application catalog/privilege metadata, not user records.
The isolated baseline was applied only to Alpha Ticketing Staging
(`pvbppmajgsbkrnvxlzrn`). Live (`gupmckxxaaxlameekihy`) was read-only throughout.

## What is verified

- 21 application tables, all with RLS enabled, containing zero application rows.
- 496 application catalog entries match the inspected live snapshot: columns,
  nullability/defaults, constraints, indexes, policies, application functions and
  their ACLs, tables and triggers. This is structural parity, not load testing.
- 72 effective schema/table permission entries match for anon, authenticated and
  service_role. Table privileges and RLS are separate checks.
- `baseline-manifest.json` records the applied version, SQL fingerprints and
  exact source/target identities. The CLI generated the initial filename; only
  this new file was aligned to the version actually assigned by hosted MCP.
  Neither remote migration ledger nor the historical local files was repaired.
- Local Postgres tests rehearse fresh application, replay rejection, full rollback
  on later failure, unchanged Alpha issuer isolation and catalog parity. Auth,
  Realtime and Storage provider behavior is not proven by local stubs.

`catalog.sql` and `access.sql` are read-only comparison queries. The JSON snapshots
contain schema/access metadata, not a database backup or application data.
The local harness currently uses PostgreSQL 18; hosted projects use PostgreSQL 17.
The comparison excludes duplicate not-null constraint catalog entries introduced
in 18 because nullability is already checked explicitly on every column. Other
constraints remain compared. See [PostgreSQL's constraint catalog](https://www.postgresql.org/docs/18/catalog-pg-constraint.html).

## Staging hardening — 8 October 2026

Migration `20261007160159_pin_project_owner_search_path` pins the existing invoker
trigger's search path to empty. Hosted checks confirm that its OID, body, owner,
ACL and security mode are unchanged. Of the 496 baseline catalog entries, only
`alpha.keep_project_owner()` differs intentionally; all 72 effective access entries
remain identical. All 21 application tables still contain zero records.
`hardening-manifest.json` records this separate delta; the baseline migration and
live snapshots remain immutable. Local tests verify ordinary edits, unchanged
owners, rejected reassignment/removal, caller-controlled paths and full rollback.
The fresh backend regression passed 117 files / 1,675 tests; typecheck, build,
8 offline migration audit tests and the historical baseline-only audit also passed.

The staging security advisor now reports no WARN findings. Its remaining INFO
for the private sessions table is intentional deny-by-default. Live remains
untouched; this is not approval to apply the hardening to live.

## Inherited advisor findings, not release approval

The staging copy retains the approved baseline plus the explicit hardening above;
it is not yet ready for client traffic:

- [Mutable function search path](https://supabase.com/docs/guides/observability/advisors?queryGroups=lint&lint=0011_function_search_path_mutable):
  resolved in staging by the separate tracked change above, not by rewriting the
  baseline or silently editing live. Preserve this fix in future feature migrations.
- [RLS with no policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy):
  private sessions are deliberately server-only, with schema/table access revoked
  from public/anon/authenticated. Do not resolve this informational finding by
  adding a client read policy.
- [Multiple permissive policies](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies):
  existing project SELECT policies overlap. Preserve the current access model
  while reviewing performance; do not delete one to make the advisor green.
- [Unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index):
  27 indexes have no usage on the empty staging database. Do not remove production
  indexes based on this empty workload.

## Safe next steps

1. Keep ticketing unavailable to ordinary users. The baseline creates no new
   ticket/client tables, routes or screens.
2. Complete isolated configuration, recovery coverage/rehearsal, test recipients,
   provider/origin decisions and pilot repository safeguards from Phase 1.
3. Use a new CLI-generated, reviewed additive migration for subsequent staging
   changes; record the actual applied version and verify its SQL and catalog.
   Do not blindly push the other migration directory or replay this bootstrap.
4. Supply independent staging secrets through approved ignored configuration,
   never chat, tracked SQL, manifests or browser bundles. The normal app still
   uses its existing environment; a local server is not proof of staging routing.
5. Shared/live migration history and 0016/0017 disposition still require the
   maintainer's separate release decision. Staging approval does not authorize
   live schema changes, feature enablement, real emails or production releases.
6. Email configuration is unverified (the user is unsure whether custom SMTP is
   configured). Installed MCP tools do not expose Auth configuration. An owner
   must inspect staging Authentication → Email → SMTP and confirm the approved
   sender/test recipients/origin without pasting credentials into chat.
   [Default Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp) only
   delivers to organization-team addresses and is not suitable for client use.
   Do not weaken email verification or enable sending as a workaround.

The Supabase skills informed isolation, short bounded migration execution,
preservation of managed schemas and explicit privilege/RLS verification. The
baseline uses only supported Realtime message policies; no managed Realtime
schema objects were altered. See the [Realtime schema advisory](https://supabase.com/changelog/realtime-schema-locked-down-against-modification).
