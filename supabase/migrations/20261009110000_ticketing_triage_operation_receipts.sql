-- Phase 2 only. Append-only receipts provide retry/reconciliation for PM triage.
CREATE TABLE alpha_private.ticket_operation_receipts (
  workspace_id text NOT NULL,
  ticket_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('pm', 'client', 'developer', 'system')),
  actor_id text NOT NULL,
  operation_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('command', 'message', 'note', 'scope', 'readiness', 'delivery')),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, ticket_id, actor_kind, actor_id, operation_id),
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets (workspace_id, id) ON DELETE RESTRICT
);
ALTER TABLE alpha_private.ticket_operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE alpha_private.ticket_operation_receipts
  FROM PUBLIC, anon, authenticated, service_role;
