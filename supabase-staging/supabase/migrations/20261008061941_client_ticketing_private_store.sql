-- Additive, staging-only persistence for the lightweight client ticket portal.
-- Keep ticket authority and client PII out of the public Data API. Existing
-- Issues remain the executable work records; the binding table points to them.
-- This migration does not create users, send email, create storage buckets, or
-- change the existing RLS policies/Issue workflow.

-- Composite keys let private ticket records prove that a linked project/Issue
-- belongs to the same workspace. IDs are already primary keys; the additional
-- unique constraints do not change their identity or existing write behavior.
ALTER TABLE public.projects
  ADD CONSTRAINT projects_workspace_id_id_ticket_unique UNIQUE (workspace_id, id);

ALTER TABLE public.issues
  ADD CONSTRAINT issues_workspace_id_id_ticket_unique UNIQUE (workspace_id, id);

CREATE TABLE alpha_private.ticket_service_grants (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  client_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  display_name text NOT NULL,
  accepts_new_requests boolean NOT NULL DEFAULT true,
  write_mode text NOT NULL DEFAULT 'enabled' CHECK (write_mode IN ('enabled', 'disabled', 'maintenance')),
  time_zone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, client_user_id),
  UNIQUE (workspace_id, id)
);

CREATE INDEX ticket_service_grants_client_status_idx
  ON alpha_private.ticket_service_grants (client_user_id, status, workspace_id);

CREATE TABLE alpha_private.ticket_intake_entries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  slug text NOT NULL UNIQUE,
  company_label text NOT NULL,
  published boolean NOT NULL DEFAULT false,
  write_mode text NOT NULL DEFAULT 'disabled' CHECK (write_mode IN ('enabled', 'disabled', 'maintenance')),
  policy_version text NOT NULL,
  per_source_max integer NOT NULL CHECK (per_source_max BETWEEN 1 AND 10000),
  per_entry_max integer NOT NULL CHECK (per_entry_max BETWEEN 1 AND 100000),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX ticket_intake_entries_published_idx
  ON alpha_private.ticket_intake_entries (published, workspace_id, slug);

CREATE TABLE alpha_private.ticket_client_project_access (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  client_user_id text NOT NULL,
  project_id text NOT NULL,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  client_visible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, client_user_id, project_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_client_project_access_visible_idx
  ON alpha_private.ticket_client_project_access (workspace_id, client_user_id, active, client_visible);

CREATE TABLE alpha_private.ticket_contacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  email text,
  company text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE alpha_private.tickets (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  client_safe_company_label text NOT NULL,
  source text NOT NULL CHECK (source IN ('public_inquiry', 'authenticated_client')),
  status text NOT NULL CHECK (status IN (
    'received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review',
    'on_hold', 'closed', 'declined', 'cancelled'
  )),
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  workflow_state jsonb NOT NULL CHECK (jsonb_typeof(workflow_state) = 'object'),
  client_user_id text,
  contact_id text,
  project_id text,
  project_display_name text,
  project_client_visible boolean NOT NULL DEFAULT false,
  related_ticket_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  client_updated_at timestamptz NOT NULL DEFAULT now(),
  internal_updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, reference),
  UNIQUE (workspace_id, id, source),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES alpha_private.ticket_contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, related_ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id, client_user_id),
  CHECK (workflow_state->>'id' = id
     AND workflow_state->>'workspaceId' = workspace_id
     AND workflow_state->>'status' = status
     AND workflow_state->>'version' = version::text)
);

CREATE INDEX tickets_workspace_queue_idx
  ON alpha_private.tickets (workspace_id, status, client_updated_at DESC, id);
CREATE INDEX tickets_workspace_internal_queue_idx
  ON alpha_private.tickets (workspace_id, status, internal_updated_at DESC, id);
CREATE INDEX tickets_workspace_project_idx
  ON alpha_private.tickets (workspace_id, project_id, created_at DESC);

CREATE TABLE alpha_private.ticket_requests (
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('public_inquiry', 'authenticated_client')),
  intake_context_id text,
  intake_entry_id text,
  project_preference text NOT NULL CHECK (project_preference IN ('not_sure', 'new_project', 'shared_project')),
  preferred_project_id text,
  requested_project_label text,
  requested_deadline text,
  contact_id text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, ticket_id),
  FOREIGN KEY (workspace_id, ticket_id, source)
    REFERENCES alpha_private.tickets (workspace_id, id, source) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, intake_entry_id)
    REFERENCES alpha_private.ticket_intake_entries (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES alpha_private.ticket_contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, preferred_project_id)
    REFERENCES public.projects (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE alpha_private.ticket_client_grants (
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  client_user_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, ticket_id),
  UNIQUE (workspace_id, ticket_id, client_user_id),
  FOREIGN KEY (workspace_id, ticket_id, client_user_id)
    REFERENCES alpha_private.tickets (workspace_id, id, client_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, client_user_id)
    REFERENCES alpha_private.ticket_service_grants (workspace_id, client_user_id) ON DELETE RESTRICT
);

CREATE INDEX ticket_client_grants_client_idx
  ON alpha_private.ticket_client_grants (client_user_id, active, workspace_id, ticket_id);

CREATE TABLE alpha_private.ticket_client_sessions (
  session_id_hash char(64) PRIMARY KEY CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  provider_user_id text NOT NULL,
  csrf_hash char(64) NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX ticket_client_sessions_user_expiry_idx
  ON alpha_private.ticket_client_sessions (provider_user_id, expires_at);

CREATE TABLE alpha_private.ticket_client_session_audit (
  id text PRIMARY KEY,
  provider_user_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('client_session_created', 'client_session_revoked')),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX ticket_client_session_audit_user_idx
  ON alpha_private.ticket_client_session_audit (provider_user_id, occurred_at, id);

CREATE TABLE alpha_private.ticket_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  contact_binding_id text NOT NULL,
  secret_hash char(64) NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'expired', 'revoked', 'consumed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (workspace_id, ticket_id, id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, contact_binding_id)
    REFERENCES alpha_private.ticket_contacts (workspace_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX ticket_invitations_one_pending_idx
  ON alpha_private.ticket_invitations (workspace_id, ticket_id) WHERE status = 'pending';

CREATE TABLE alpha_private.ticket_scopes (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  public_summary text NOT NULL,
  developer_brief text NOT NULL,
  proposed_by_pm_id text NOT NULL,
  proposed_at timestamptz NOT NULL,
  immutable boolean NOT NULL DEFAULT true CHECK (immutable),
  client_visible boolean NOT NULL DEFAULT true CHECK (client_visible),
  agreed_by_client_id text,
  agreed_at timestamptz,
  PRIMARY KEY (workspace_id, ticket_id, id),
  UNIQUE (workspace_id, ticket_id, version_number),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((agreed_by_client_id IS NULL) = (agreed_at IS NULL))
);

CREATE TABLE alpha_private.ticket_messages (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('pm', 'client')),
  author_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('client', 'internal')),
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, ticket_id, id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  CHECK (author_kind <> 'client' OR audience = 'client')
);

CREATE INDEX ticket_messages_audience_page_idx
  ON alpha_private.ticket_messages (workspace_id, ticket_id, audience, created_at, id);

CREATE TABLE alpha_private.ticket_issue_revisions (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  project_id text NOT NULL,
  issue_id text NOT NULL,
  scope_version_id text NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  previous_revision_id text,
  developer_instructions text,
  source text NOT NULL CHECK (source IN ('initial_authorization', 'request_fixes', 'authorize_correction')),
  created_by_pm_id text NOT NULL,
  created_at timestamptz NOT NULL,
  immutable boolean NOT NULL DEFAULT true CHECK (immutable),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, issue_id, revision_number),
  UNIQUE (workspace_id, issue_id, id),
  UNIQUE (workspace_id, ticket_id, issue_id, id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, issue_id)
    REFERENCES public.issues (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, scope_version_id)
    REFERENCES alpha_private.ticket_scopes (workspace_id, ticket_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, issue_id, previous_revision_id)
    REFERENCES alpha_private.ticket_issue_revisions (workspace_id, ticket_id, issue_id, id) ON DELETE RESTRICT,
  CHECK ((revision_number = 1 AND previous_revision_id IS NULL)
      OR (revision_number > 1 AND previous_revision_id IS NOT NULL)),
  CHECK ((source = 'initial_authorization' AND developer_instructions IS NULL)
      OR (source <> 'initial_authorization' AND developer_instructions IS NOT NULL))
);

CREATE TABLE alpha_private.ticket_work_bindings (
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  project_id text NOT NULL,
  issue_id text NOT NULL,
  scope_version_id text NOT NULL,
  initial_revision_id text NOT NULL,
  current_revision_id text NOT NULL,
  authorized_by_pm_id text NOT NULL,
  authorized_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, ticket_id, issue_id),
  UNIQUE (workspace_id, issue_id),
  UNIQUE (workspace_id, ticket_id, issue_id, current_revision_id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, issue_id)
    REFERENCES public.issues (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, scope_version_id)
    REFERENCES alpha_private.ticket_scopes (workspace_id, ticket_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, issue_id, initial_revision_id)
    REFERENCES alpha_private.ticket_issue_revisions (workspace_id, ticket_id, issue_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, issue_id, current_revision_id)
    REFERENCES alpha_private.ticket_issue_revisions (workspace_id, ticket_id, issue_id, id) ON DELETE RESTRICT
);

CREATE TABLE alpha_private.ticket_execution_claims (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  project_id text NOT NULL,
  issue_id text NOT NULL,
  scope_version_id text NOT NULL,
  issue_revision_id text NOT NULL,
  developer_id text NOT NULL,
  executor_kind text NOT NULL CHECK (executor_kind IN ('agent', 'squad')),
  executor_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('reserved', 'admitted', 'stopped')),
  run_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, ticket_id, issue_id)
    REFERENCES alpha_private.ticket_work_bindings (workspace_id, ticket_id, issue_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, issue_id, issue_revision_id)
    REFERENCES alpha_private.ticket_issue_revisions (workspace_id, ticket_id, issue_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ticket_execution_one_active_claim_idx
  ON alpha_private.ticket_execution_claims (workspace_id, issue_id)
  WHERE phase IN ('reserved', 'admitted');
CREATE INDEX ticket_execution_claim_run_idx
  ON alpha_private.ticket_execution_claims (workspace_id, run_id) WHERE run_id IS NOT NULL;

CREATE TABLE alpha_private.ticket_ready_manifests (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  project_id text NOT NULL,
  scope_version_id text NOT NULL,
  manifest_fingerprint char(64) NOT NULL CHECK (manifest_fingerprint ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  run_id text NOT NULL,
  completion_id text NOT NULL,
  actor_id text NOT NULL,
  operation_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, ticket_id, id),
  UNIQUE (workspace_id, ticket_id, scope_version_id, project_id, manifest_fingerprint),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, scope_version_id)
    REFERENCES alpha_private.ticket_scopes (workspace_id, ticket_id, id) ON DELETE RESTRICT
);

CREATE TABLE alpha_private.ticket_verification_receipts (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('run_admission', 'execution_completion', 'delivery_artifacts')),
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  issue_id text,
  scope_version_id text NOT NULL,
  issue_revision_id text,
  developer_id text NOT NULL,
  run_id text,
  completion_id text,
  artifact_bundle_id text,
  execution_claim_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, scope_version_id)
    REFERENCES alpha_private.ticket_scopes (workspace_id, ticket_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, issue_id, issue_revision_id)
    REFERENCES alpha_private.ticket_issue_revisions (workspace_id, ticket_id, issue_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, execution_claim_id)
    REFERENCES alpha_private.ticket_execution_claims (workspace_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((kind = 'run_admission' AND execution_claim_id IS NOT NULL)
      OR (kind <> 'run_admission' AND execution_claim_id IS NULL)),
  CHECK ((kind = 'execution_completion' AND run_id IS NOT NULL AND completion_id IS NOT NULL)
      OR (kind <> 'execution_completion' AND completion_id IS NULL)),
  CHECK ((kind = 'delivery_artifacts' AND artifact_bundle_id IS NOT NULL)
      OR (kind <> 'delivery_artifacts' AND artifact_bundle_id IS NULL))
);

CREATE INDEX ticket_verification_receipts_current_idx
  ON alpha_private.ticket_verification_receipts (workspace_id, ticket_id, kind, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE alpha_private.ticket_deliveries (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  scope_version_id text NOT NULL,
  pinned_asset_id text NOT NULL,
  issue_revision_ids jsonb NOT NULL CHECK (jsonb_typeof(issue_revision_ids) = 'array'),
  public_summary text NOT NULL,
  assessed_by_pm_id text,
  immutable boolean NOT NULL DEFAULT true CHECK (immutable),
  client_visible boolean NOT NULL DEFAULT true CHECK (client_visible),
  shared_at timestamptz,
  readiness_manifest_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, ticket_id, id),
  UNIQUE (workspace_id, ticket_id, pinned_asset_id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, scope_version_id)
    REFERENCES alpha_private.ticket_scopes (workspace_id, ticket_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, readiness_manifest_id)
    REFERENCES alpha_private.ticket_ready_manifests (workspace_id, ticket_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, ticket_id, id, pinned_asset_id)
);

CREATE TABLE alpha_private.ticket_delivery_files (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  delivery_id text NOT NULL,
  pinned_asset_id text NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain', 'application/pdf', 'image/png', 'image/jpeg')),
  byte_length bigint NOT NULL CHECK (byte_length > 0 AND byte_length <= 33554432),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_verdict text NOT NULL CHECK (scan_verdict = 'clean'),
  scan_sha256 char(64) NOT NULL CHECK (scan_sha256 ~ '^[0-9a-f]{64}$'),
  scan_policy_version text NOT NULL,
  scanned_at timestamptz NOT NULL,
  object_key text NOT NULL,
  object_version text NOT NULL,
  immutable boolean NOT NULL DEFAULT true CHECK (immutable),
  client_visible boolean NOT NULL DEFAULT true CHECK (client_visible),
  PRIMARY KEY (workspace_id, ticket_id, id),
  UNIQUE (workspace_id, ticket_id, delivery_id, object_key, object_version),
  FOREIGN KEY (workspace_id, ticket_id, delivery_id, pinned_asset_id)
    REFERENCES alpha_private.ticket_deliveries (workspace_id, ticket_id, id, pinned_asset_id) ON DELETE RESTRICT,
  CHECK (sha256 = scan_sha256)
);

CREATE TABLE alpha_private.ticket_operation_receipts (
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('pm', 'client', 'developer', 'system')),
  actor_id text NOT NULL,
  operation_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('command', 'message', 'note', 'scope', 'readiness', 'delivery')),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, ticket_id, actor_kind, actor_id, operation_id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE alpha_private.ticket_creation_operations (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  client_id text NOT NULL,
  operation_id text NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  ticket_id text NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, client_id, operation_id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE alpha_private.ticket_intake_operations (
  workspace_id text NOT NULL,
  entry_id text NOT NULL,
  operation_id text NOT NULL,
  ticket_id text NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_key_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, entry_id, operation_id),
  FOREIGN KEY (workspace_id, entry_id)
    REFERENCES alpha_private.ticket_intake_entries (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE alpha_private.ticket_admission_operations (
  workspace_id text NOT NULL,
  issue_id text NOT NULL,
  actor_id text NOT NULL,
  operation_id text NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  claim_id text NOT NULL,
  issue_revision_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, issue_id, actor_id, operation_id),
  FOREIGN KEY (workspace_id, issue_id)
    REFERENCES public.issues (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, issue_id, issue_revision_id)
    REFERENCES alpha_private.ticket_issue_revisions (workspace_id, issue_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, claim_id)
    REFERENCES alpha_private.ticket_execution_claims (workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE alpha_private.ticket_audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  ticket_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('pm', 'client', 'developer', 'system', 'anonymous')),
  actor_id text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_audit_ticket_timeline_idx
  ON alpha_private.ticket_audit_events (workspace_id, ticket_id, occurred_at, id);

CREATE TABLE alpha_private.ticket_outbox_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  ticket_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ticket_changed', 'ticket_created', 'ticket_client_activated', 'ticket_invitation_requested')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'retry', 'dead', 'discarded')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token_hash char(64),
  lease_until timestamptz,
  delivered_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN (
    'provider_failure', 'secret_unavailable', 'secret_integrity_failure', 'attempt_limit_reached'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'leased' AND lease_token_hash IS NOT NULL AND lease_until IS NOT NULL)
      OR (status <> 'leased' AND lease_token_hash IS NULL AND lease_until IS NULL)),
  CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (event_type <> 'ticket_invitation_requested' OR NOT (payload ? 'email'))
);

CREATE INDEX ticket_outbox_due_idx
  ON alpha_private.ticket_outbox_events (available_at, created_at, id)
  WHERE status IN ('pending', 'retry', 'leased');

CREATE TABLE alpha_private.ticket_intake_rate_buckets (
  workspace_id text NOT NULL,
  entry_id text NOT NULL,
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('source', 'entry')),
  subject_hash char(64) NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  attempts integer NOT NULL CHECK (attempts >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, entry_id, bucket_kind, subject_hash, window_started_at),
  FOREIGN KEY (workspace_id, entry_id)
    REFERENCES alpha_private.ticket_intake_entries (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_intake_rate_cleanup_idx
  ON alpha_private.ticket_intake_rate_buckets (window_started_at, window_seconds);

-- All ticket tables stay server-only. RLS is deny-by-default for any future
-- exposed/API role; the cloud application must still authorize every query
-- explicitly because its database-owner connection bypasses RLS.
ALTER TABLE alpha_private.ticket_service_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_intake_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_client_project_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_client_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_client_session_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_issue_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_work_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_execution_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_ready_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_delivery_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_creation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_intake_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_admission_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_intake_rate_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  alpha_private.ticket_service_grants,
  alpha_private.ticket_intake_entries,
  alpha_private.ticket_client_project_access,
  alpha_private.ticket_contacts,
  alpha_private.tickets,
  alpha_private.ticket_requests,
  alpha_private.ticket_client_grants,
  alpha_private.ticket_client_sessions,
  alpha_private.ticket_client_session_audit,
  alpha_private.ticket_invitations,
  alpha_private.ticket_scopes,
  alpha_private.ticket_messages,
  alpha_private.ticket_issue_revisions,
  alpha_private.ticket_work_bindings,
  alpha_private.ticket_execution_claims,
  alpha_private.ticket_ready_manifests,
  alpha_private.ticket_verification_receipts,
  alpha_private.ticket_deliveries,
  alpha_private.ticket_delivery_files,
  alpha_private.ticket_operation_receipts,
  alpha_private.ticket_creation_operations,
  alpha_private.ticket_intake_operations,
  alpha_private.ticket_admission_operations,
  alpha_private.ticket_audit_events,
  alpha_private.ticket_outbox_events,
  alpha_private.ticket_intake_rate_buckets
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON SCHEMA alpha_private IS
  'Server-only Alpha control plane. Ticket/client records are private and are never exposed directly through the Supabase Data API.';
