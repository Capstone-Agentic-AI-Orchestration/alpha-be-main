-- Cover the child side of composite ticket workflow foreign keys. These indexes are
-- intentionally idempotent because the base workflow migration also creates
-- them for fresh installations.
create index if not exists ticket_work_bindings_scope_fk_idx
  on alpha_private.ticket_work_bindings(workspace_id,ticket_id,scope_version_id);

create index if not exists ticket_ready_manifests_scope_fk_idx
  on alpha_private.ticket_ready_manifests(workspace_id,ticket_id,scope_version_id);

create index if not exists ticket_delivery_registrations_ready_manifest_fk_idx
  on alpha_private.ticket_delivery_registrations(workspace_id,ticket_id,ready_manifest_id);
