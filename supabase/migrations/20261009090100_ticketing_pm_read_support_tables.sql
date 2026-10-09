-- Private read support for the existing PM ticket detail API.
-- Additive only: no existing rows/tables are changed or removed.
-- These tables are server-only; RLS is enabled and direct API-role access revoked.

CREATE TABLE alpha_private.ticket_scopes (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  ticket_id text NOT NULL,
  public_summary text NOT NULL,
  developer_brief text NOT NULL,
  immutable boolean NOT NULL,
  client_visible boolean NOT NULL,
  proposed_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, ticket_id, id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_scopes_workspace_ticket_idx
  ON alpha_private.ticket_scopes (workspace_id, ticket_id, proposed_at DESC, id);

CREATE TABLE alpha_private.ticket_deliveries (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  ticket_id text NOT NULL,
  scope_version_id text NOT NULL,
  pinned_asset_id text NOT NULL,
  issue_revision_ids jsonb NOT NULL CHECK (jsonb_typeof(issue_revision_ids) = 'array'),
  immutable boolean NOT NULL,
  client_visible boolean NOT NULL,
  public_summary text NOT NULL,
  shared_at timestamptz,
  PRIMARY KEY (workspace_id, ticket_id, id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, ticket_id, scope_version_id)
    REFERENCES alpha_private.ticket_scopes (workspace_id, ticket_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_deliveries_workspace_ticket_idx
  ON alpha_private.ticket_deliveries (workspace_id, ticket_id, shared_at DESC, id);

CREATE TABLE alpha_private.ticket_messages (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  ticket_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('pm', 'client')),
  author_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('client', 'internal')),
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, ticket_id, id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_messages_audience_page_idx
  ON alpha_private.ticket_messages (workspace_id, ticket_id, audience, created_at, id);

ALTER TABLE alpha_private.ticket_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ticket_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  alpha_private.ticket_scopes,
  alpha_private.ticket_deliveries,
  alpha_private.ticket_messages
FROM PUBLIC, anon, authenticated, service_role;
