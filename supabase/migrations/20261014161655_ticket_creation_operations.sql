-- Authenticated client ticket creation needs a durable retry key before the
-- new ticket ID is known. Keep that key in the private schema; the shared
-- operation receipt table is ticket-scoped and intentionally cannot represent
-- a pre-ticket create operation.
CREATE TABLE alpha_private.ticket_creation_operations (
  workspace_id text NOT NULL,
  client_id text NOT NULL,
  operation_id text NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  ticket_id text NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, client_id, operation_id),
  UNIQUE (workspace_id, ticket_id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);

ALTER TABLE alpha_private.ticket_creation_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE alpha_private.ticket_creation_operations
  FROM PUBLIC, anon, authenticated, service_role;
