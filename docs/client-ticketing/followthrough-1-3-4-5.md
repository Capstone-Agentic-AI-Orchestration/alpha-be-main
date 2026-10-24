# Ticketing follow-through fixes

- A PM may link a project before inviting the inquiry contact. This remains an
  organizational link: it does not approve work or grant client project access.
  Invitation issuance and both delivery paths allow that link, while rejecting
  already-authorized work and preserving contact/email verification.
- Missing email credentials no longer disable existing password sign-in,
  client sessions, granted ticket reads, conversations, or document access.
  New invitations stay unavailable until a sender is configured. Recovery keeps
  its generic response and sends nothing when email is unavailable.
- Shared inquiries have pending and handled views. Active workspace PM access
  is checked for both. Accepted and declined records remain discoverable without
  granting access to another workspace's regular tickets.
- New shared-inbox declines atomically queue a generic outcome email. PM notes
  are never email content. Old declines are not backfilled. The existing inquiry
  email worker and sender process receipts and outcomes using bounded retries,
  leases, a persisted send key, and provider/recipient identity checks. Provider
  acceptance is not claimed as confirmed inbox delivery.

## Release

Apply `supabase/migrations/20261024185727_ticketing_inquiry_outcomes.sql`
before deploying this backend, then deploy the corresponding frontend branch.
The migration creates a private RLS-enabled outcome outbox and handled-list index.
It was exercised locally against PostgreSQL through the migration test database;
this work does not apply migrations to the live project or change Render settings.

No new environment keys or email providers are added. Inquiry outcomes use the
existing inquiry-email sender and existing inquiry-email enable setting. Missing
or disabled delivery leaves the recorded outcome visible in the PM handled view;
it never rolls back a saved inquiry decision. This adds no PM/client chat emails.

Preview/deployment validation (#6) is unchanged. Client-portal New Request remains
deferred. Database tests use synthetic contacts and mocked provider calls.
