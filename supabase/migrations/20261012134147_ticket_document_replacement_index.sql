-- Cover the self-referencing replacement FK and keep version lookups indexed.
CREATE INDEX ticket_documents_replacement_idx
  ON alpha_private.ticket_documents (workspace_id, ticket_id, replaces_document_id);
