-- Alpha cloud control plane — index the foreign keys
--
-- Postgres indexes a primary key but not the column that references one.
-- Supabase's advisor flagged fifteen, and they matter here for two reasons:
--
--   - almost every policy filters on `workspace_id`, so an unindexed one is a
--     sequential scan behind every read once a table has real rows;
--   - `on delete cascade` from a workspace, project or thread has to find the
--     children, and without an index that is a scan per deleted parent.
--
-- `prototype_runs.workspace_id` is already covered by idx_runs_workspace.

create index if not exists idx_artifacts_workspace   on agent_call_artifacts (workspace_id);
create index if not exists idx_calls_thread          on agent_calls (thread_id);
create index if not exists idx_calls_workspace       on agent_calls (workspace_id);
create index if not exists idx_agents_workspace      on agents (workspace_id);
create index if not exists idx_threads_workspace     on chat_threads (workspace_id);
create index if not exists idx_comments_issue        on issue_comments (issue_id);
create index if not exists idx_issues_agent          on issues (assigned_agent_id);
create index if not exists idx_issues_workspace      on issues (workspace_id);
create index if not exists idx_build_steps_project   on project_build_steps (project_id);
create index if not exists idx_build_steps_workspace on project_build_steps (workspace_id);
create index if not exists idx_runs_issue            on prototype_runs (issue_id);
create index if not exists idx_runs_project          on prototype_runs (project_id);
create index if not exists idx_squad_runs_workspace  on squad_runs (workspace_id);
create index if not exists idx_squads_workspace      on squads (workspace_id);
create index if not exists idx_bindings_workspace    on workspace_entity_bindings (workspace_id);
