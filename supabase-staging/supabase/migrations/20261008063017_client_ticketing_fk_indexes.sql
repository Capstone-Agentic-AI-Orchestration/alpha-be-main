-- Cover the ticket-domain foreign keys flagged by the staging performance advisor.
-- These indexes are scoped to the private schema and do not alter the legacy
-- public Issues/Projects tables or their policies.

create index if not exists ticket_admission_operations_workspace_claim_idx
  on alpha_private.ticket_admission_operations (workspace_id, claim_id);
create index if not exists ticket_admission_operations_workspace_issue_revision_idx
  on alpha_private.ticket_admission_operations (workspace_id, issue_id, issue_revision_id);

create index if not exists ticket_client_grants_workspace_client_user_idx
  on alpha_private.ticket_client_grants (workspace_id, client_user_id);
create index if not exists ticket_client_project_access_workspace_project_idx
  on alpha_private.ticket_client_project_access (workspace_id, project_id);
create index if not exists ticket_creation_operations_workspace_ticket_idx
  on alpha_private.ticket_creation_operations (workspace_id, ticket_id);

create index if not exists ticket_deliveries_workspace_ticket_manifest_idx
  on alpha_private.ticket_deliveries (workspace_id, ticket_id, readiness_manifest_id);
create index if not exists ticket_deliveries_workspace_ticket_scope_idx
  on alpha_private.ticket_deliveries (workspace_id, ticket_id, scope_version_id);
create index if not exists ticket_delivery_files_workspace_ticket_delivery_asset_idx
  on alpha_private.ticket_delivery_files (workspace_id, ticket_id, delivery_id, pinned_asset_id);

-- One longer prefix index covers both the issue and issue-revision FKs.
create index if not exists ticket_execution_claims_workspace_issue_revision_idx
  on alpha_private.ticket_execution_claims (workspace_id, ticket_id, issue_id, issue_revision_id);

create index if not exists ticket_intake_operations_workspace_ticket_idx
  on alpha_private.ticket_intake_operations (workspace_id, ticket_id);
create index if not exists ticket_invitations_workspace_contact_binding_idx
  on alpha_private.ticket_invitations (workspace_id, contact_binding_id);

create index if not exists ticket_issue_revisions_workspace_project_idx
  on alpha_private.ticket_issue_revisions (workspace_id, project_id);
create index if not exists ticket_issue_revisions_workspace_ticket_issue_previous_idx
  on alpha_private.ticket_issue_revisions (workspace_id, ticket_id, issue_id, previous_revision_id);
create index if not exists ticket_issue_revisions_workspace_ticket_scope_idx
  on alpha_private.ticket_issue_revisions (workspace_id, ticket_id, scope_version_id);
create index if not exists ticket_outbox_events_workspace_ticket_idx
  on alpha_private.ticket_outbox_events (workspace_id, ticket_id);

create index if not exists ticket_ready_manifests_workspace_project_idx
  on alpha_private.ticket_ready_manifests (workspace_id, project_id);

create index if not exists ticket_requests_workspace_contact_idx
  on alpha_private.ticket_requests (workspace_id, contact_id);
create index if not exists ticket_requests_workspace_intake_entry_idx
  on alpha_private.ticket_requests (workspace_id, intake_entry_id);
create index if not exists ticket_requests_workspace_preferred_project_idx
  on alpha_private.ticket_requests (workspace_id, preferred_project_id);
create index if not exists ticket_requests_workspace_ticket_source_idx
  on alpha_private.ticket_requests (workspace_id, ticket_id, source);

create index if not exists ticket_verification_receipts_workspace_execution_claim_idx
  on alpha_private.ticket_verification_receipts (workspace_id, execution_claim_id);
create index if not exists ticket_verification_receipts_workspace_ticket_issue_revision_idx
  on alpha_private.ticket_verification_receipts (workspace_id, ticket_id, issue_id, issue_revision_id);
create index if not exists ticket_verification_receipts_workspace_ticket_scope_idx
  on alpha_private.ticket_verification_receipts (workspace_id, ticket_id, scope_version_id);

create index if not exists ticket_work_bindings_workspace_project_idx
  on alpha_private.ticket_work_bindings (workspace_id, project_id);
create index if not exists ticket_work_bindings_workspace_ticket_issue_initial_revision_idx
  on alpha_private.ticket_work_bindings (workspace_id, ticket_id, issue_id, initial_revision_id);
create index if not exists ticket_work_bindings_workspace_ticket_scope_idx
  on alpha_private.ticket_work_bindings (workspace_id, ticket_id, scope_version_id);

create index if not exists tickets_workspace_contact_idx
  on alpha_private.tickets (workspace_id, contact_id);
create index if not exists tickets_workspace_related_ticket_idx
  on alpha_private.tickets (workspace_id, related_ticket_id);
