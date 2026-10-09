-- Minimal Phase 2 persistence for public inquiries and the PM ticket queue.
-- Additive only: no seed/client data, no changes to existing public tables,
-- no email, client sessions, messaging, attachments, project linkage, or work execution.

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
  UNIQUE (workspace_id, id, client_user_id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES alpha_private.ticket_contacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, related_ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  CHECK (workflow_state->>'id' = id
     AND workflow_state->>'workspaceId' = workspace_id
     AND workflow_state->>'status' = status
     AND workflow_state->>'version' = version::text)
);

CREATE INDEX tickets_workspace_queue_idx
  ON alpha_private.tickets (workspace_id, status, client_updated_at DESC, id);
CREATE INDEX tickets_workspace_internal_queue_idx
  ON alpha_private.tickets (workspace_id, status, internal_updated_at DESC, id);
CREATE INDEX tickets_workspace_contact_idx
  ON alpha_private.tickets (workspace_id, contact_id);
CREATE INDEX tickets_workspace_related_ticket_idx
  ON alpha_private.tickets (workspace_id, related_ticket_id);

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
    REFERENCES alpha_private.ticket_contacts (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_requests_workspace_contact_idx
  ON alpha_private.ticket_requests (workspace_id, contact_id);
CREATE INDEX ticket_requests_workspace_intake_entry_idx
  ON alpha_private.ticket_requests (workspace_id, intake_entry_id);

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

CREATE INDEX ticket_intake_operations_workspace_ticket_idx
  ON alpha_private.ticket_intake_operations (workspace_id, ticket_id);

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
CREATE INDEX ticket_outbox_events_workspace_ticket_idx
  ON alpha_private.ticket_outbox_events (workspace_id, ticket_id);

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

-- Server-only tables: deny direct API-role privileges and retain RLS as
-- deny-by-default defense in depth. The backend must still authorize its own
-- privileged database connection per workspace and actor.
ALTER TABLE alpha_private.ticket_service_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_intake_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_client_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_intake_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_intake_rate_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  alpha_private.ticket_service_grants,
  alpha_private.ticket_intake_entries,
  alpha_private.ticket_contacts,
  alpha_private.tickets,
  alpha_private.ticket_requests,
  alpha_private.ticket_client_grants,
  alpha_private.ticket_intake_operations,
  alpha_private.ticket_audit_events,
  alpha_private.ticket_outbox_events,
  alpha_private.ticket_intake_rate_buckets
FROM PUBLIC, anon, authenticated, service_role;
