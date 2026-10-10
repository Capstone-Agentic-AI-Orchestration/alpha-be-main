CREATE TABLE alpha_private.ticket_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  contact_binding_id text NOT NULL,
  secret_hash char(64) NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','expired','revoked','consumed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  provider_link_envelope text,
  provider_link_type text CHECK (provider_link_type IS NULL OR provider_link_type IN ('invite','magiclink')),
  UNIQUE (workspace_id,id,ticket_id),
  FOREIGN KEY (workspace_id,ticket_id)
    REFERENCES alpha_private.tickets (workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,contact_binding_id)
    REFERENCES alpha_private.ticket_contacts (workspace_id,id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((provider_link_envelope IS NULL) = (provider_link_type IS NULL)),
  CHECK (provider_link_envelope IS NULL OR length(provider_link_envelope) <= 2048),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE UNIQUE INDEX ticket_invitations_one_pending_per_ticket_idx
  ON alpha_private.ticket_invitations (workspace_id,ticket_id)
  WHERE status = 'pending';
CREATE INDEX ticket_invitations_secret_pending_idx
  ON alpha_private.ticket_invitations (secret_hash,expires_at)
  WHERE status = 'pending';

CREATE TABLE alpha_private.ticket_client_sessions (
  session_id_hash char(64) PRIMARY KEY CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  client_user_id text NOT NULL,
  csrf_hash char(64) NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX ticket_client_sessions_client_active_idx
  ON alpha_private.ticket_client_sessions (client_user_id,expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE alpha_private.ticket_client_auth_events (
  id text PRIMARY KEY,
  client_user_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('client_session_created','client_session_revoked')),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX ticket_client_auth_events_client_time_idx
  ON alpha_private.ticket_client_auth_events (client_user_id,occurred_at DESC);

ALTER TABLE alpha_private.ticket_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_client_auth_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE alpha_private.ticket_invitations,
  alpha_private.ticket_client_sessions,
  alpha_private.ticket_client_auth_events
  FROM PUBLIC, anon, authenticated, service_role;
