-- Phase 5 ticket conversations and private document versions.
-- Additive only: existing ticket, project, issue, and public tables are untouched.

CREATE TABLE alpha_private.ticket_documents (
  id text NOT NULL,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  document_group_id text NOT NULL,
  version_number integer NOT NULL CHECK (version_number BETWEEN 1 AND 10000),
  replaces_document_id text,
  author_kind text NOT NULL CHECK (author_kind IN ('pm', 'client')),
  author_id text NOT NULL,
  operation_id text NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 10485760),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL UNIQUE,
  change_proposed boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available')),
  created_at timestamptz NOT NULL,
  available_at timestamptz,
  PRIMARY KEY (workspace_id, ticket_id, id),
  UNIQUE (workspace_id, ticket_id, document_group_id, version_number),
  UNIQUE (workspace_id, ticket_id, author_kind, author_id, operation_id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, replaces_document_id)
    REFERENCES alpha_private.ticket_documents (workspace_id, ticket_id, id) ON DELETE RESTRICT,
  CHECK ((version_number = 1 AND replaces_document_id IS NULL AND change_proposed = false)
      OR (version_number > 1 AND replaces_document_id IS NOT NULL AND change_proposed = true)),
  CHECK ((status = 'pending' AND available_at IS NULL) OR (status = 'available' AND available_at IS NOT NULL))
);

CREATE INDEX ticket_documents_ticket_versions_idx
  ON alpha_private.ticket_documents (workspace_id, ticket_id, document_group_id, version_number DESC);
CREATE INDEX ticket_documents_ticket_status_idx
  ON alpha_private.ticket_documents (workspace_id, ticket_id, status, created_at, id);

CREATE TABLE alpha_private.ticket_communication_notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  ticket_id text NOT NULL,
  notification_kind text NOT NULL CHECK (notification_kind IN ('message', 'document')),
  object_id text NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'retry', 'dead', 'discarded')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token_hash char(64),
  lease_until timestamptz,
  delivered_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN ('provider_failure', 'attempt_limit_reached')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'leased' AND lease_token_hash IS NOT NULL AND lease_until IS NOT NULL)
      OR (status <> 'leased' AND lease_token_hash IS NULL AND lease_until IS NULL)),
  CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX ticket_communication_notifications_due_idx
  ON alpha_private.ticket_communication_notifications (available_at, created_at, id)
  WHERE status IN ('pending', 'retry', 'leased');
CREATE INDEX ticket_communication_notifications_ticket_idx
  ON alpha_private.ticket_communication_notifications (workspace_id, ticket_id, created_at, id);

ALTER TABLE alpha_private.ticket_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_communication_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE
  alpha_private.ticket_documents,
  alpha_private.ticket_communication_notifications
FROM PUBLIC, anon, authenticated, service_role;

-- Browser access remains proxied through the authenticated Alpha backend.
-- The service-role key is never sent to the browser and the bucket is private.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('alpha-ticket-documents', 'alpha-ticket-documents', false, 10485760,
        ARRAY['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv']::text[])
ON CONFLICT (id) DO NOTHING;
