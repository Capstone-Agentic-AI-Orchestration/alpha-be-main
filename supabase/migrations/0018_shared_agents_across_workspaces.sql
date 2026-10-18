-- Shared agent profiles are materialized per workspace so existing project,
-- issue, squad, and run references keep their workspace-local agent IDs.
-- `shared_key` links those copies; machine configuration remains in SQLite.
alter table agents add column if not exists shared_key text;

create unique index if not exists idx_agents_workspace_shared_key
  on agents (workspace_id, shared_key)
  where shared_key is not null;
