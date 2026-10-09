-- Cover two composite foreign keys that need their own child-side indexes.
CREATE INDEX ticket_client_grants_workspace_client_idx
  ON alpha_private.ticket_client_grants (workspace_id, client_user_id);

CREATE INDEX ticket_requests_workspace_ticket_source_idx
  ON alpha_private.ticket_requests (workspace_id, ticket_id, source);
