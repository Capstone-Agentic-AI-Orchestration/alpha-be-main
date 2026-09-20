-- Alpha cloud control plane — schema
--
-- What belongs here, and what deliberately does not.
--
-- Alpha's 24 SQLite tables split three ways, not two:
--
--   1. SHARED CANONICAL  — the board everyone works from. Here.
--   2. PER-DEVELOPER      — someone's own runs, calls and conversations.
--                           Here too, with an owner column and RLS.
--   3. MACHINE-LOCAL      — `allowed_paths`, `runtimes`, `thread_sessions`,
--                           `meta`, `local_project_bindings`. NOT here, and
--                           moving them would be actively wrong: a path like
--                           C:\Code\checkout is meaningless on another
--                           machine, and a CLI session id is a pointer into
--                           ~/.claude/projects on one disk.
--
-- The rule: if a row names a path, a PID, a binary location or a session
-- file, it stays in SQLite. Everything else lives here.
--
-- Identifiers are TEXT, not uuid. The application already mints ids like
-- `member-<uuid>` and `ws-default`, and rewriting that is a separate change
-- from moving the storage. `auth.uid()` is unusable for the same reason — it
-- casts to uuid, and Alpha's subject is a GitHub login. Policies read
-- `auth.jwt()` claims directly instead; see 0002_rls.sql.

create schema if not exists alpha;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. WORKSPACES AND MEMBERSHIP
-- ─────────────────────────────────────────────────────────────────────────

-- The union of two SQLite definitions: sqliteService creates this table and
-- workspaceRegistry ALTERs columns onto it. Reproduced whole so a fresh cloud
-- database does not inherit that split history.
create table if not exists workspaces (
  id            text primary key,
  name          text not null,
  slug          text not null unique,
  organization  text,
  status        text not null default 'active',
  join_code     text,
  created_by    text not null default 'system',
  settings_json jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Partial, because rows predating the column carry NULL and NULLs are not
-- distinct for a plain UNIQUE in every engine. Mirrors the SQLite index.
create unique index if not exists idx_workspaces_join_code
  on workspaces (join_code) where join_code is not null;

create table if not exists workspace_members (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id      text not null,
  role         text not null check (role in ('client', 'dev', 'pm', 'admin')),
  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists idx_members_user on workspace_members (user_id, status);

create table if not exists workspace_project_assignments (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  project_id   text not null,
  user_id      text not null,
  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, project_id, user_id)
);

create table if not exists workspace_squad_owners (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  squad_id     text not null,
  user_id      text not null,
  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, squad_id, user_id)
);

create table if not exists workspace_squad_projects (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  squad_id     text not null,
  project_id   text not null,
  relationship text not null default 'assigned',
  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, squad_id, project_id)
);

create table if not exists workspace_entity_bindings (
  entity_type  text not null,
  entity_id    text not null,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (entity_type, entity_id)
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. SHARED CANONICAL — the board
-- ─────────────────────────────────────────────────────────────────────────

-- `resources` holds repository links and, historically, `local_path` entries.
-- Those are machine-specific and must not be written here: a path from one
-- developer's disk in a shared row is how the web app ends up rendering a
-- folder nobody else has. Enforced in the write path rather than by a
-- constraint, because the column is a heterogeneous list.
create table if not exists projects (
  id            text primary key,
  workspace_id  text not null references workspaces(id) on delete cascade,
  name          text not null,
  key           text not null unique,
  description   text,
  color         text,
  icon          text,
  status        text,
  priority      text,
  start_date    timestamptz,
  target_date   timestamptz,
  lead_type     text,
  lead_name     text,
  lead_agent_id text,
  resources     jsonb not null default '[]'::jsonb,
  github_org    text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_projects_workspace on projects (workspace_id);

create table if not exists agents (
  id                text primary key,
  workspace_id      text not null references workspaces(id) on delete cascade,
  name              text not null,
  role              text not null,
  avatar            text,
  color             text,
  description       text,
  owner             text default 'You',
  is_mine           boolean default true,
  model_provider    text not null,
  model_name        text not null,
  reasoning_effort  text,
  system_prompt     text default '',
  autonomy_level    text not null,
  temperature       real default 0.7,
  skills            jsonb not null default '[]'::jsonb,
  mcp_servers       jsonb not null default '[]'::jsonb,
  custom_cli_args   text default '',
  env_vars          jsonb not null default '[]'::jsonb,
  concurrency_limit integer default 2,
  is_archived       boolean default false,
  created_at        timestamptz not null default now()
);

create table if not exists squads (
  id                    text primary key,
  workspace_id          text not null references workspaces(id) on delete cascade,
  name                  text not null,
  topology              text not null,
  leader_agent_id       text,
  member_agent_ids      jsonb not null default '[]'::jsonb,
  mission               text not null,
  description           text,
  avatar                text,
  color                 text,
  active_runs_count     integer default 0,
  completed_runs_count  integer default 0
);

create table if not exists issues (
  id                text primary key,
  workspace_id      text not null references workspaces(id) on delete cascade,
  identifier        text not null unique,
  title             text not null,
  description       text,
  status            text not null,
  priority          text not null,
  project_id        text not null references projects(id) on delete cascade,
  assigned_agent_id text references agents(id) on delete set null,
  assigned_squad_id text,
  assigned_human    text,
  created_by        text,
  labels            jsonb not null default '[]'::jsonb,
  subtasks          jsonb not null default '[]'::jsonb,
  branch_name       text,
  pr_url            text,
  github_repo       text,
  github_number     integer,
  github_url        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_issues_project on issues (project_id, status);

create table if not exists issue_comments (
  id            text primary key,
  issue_id      text not null references issues(id) on delete cascade,
  author_type   text not null,
  author_name   text not null,
  author_avatar text,
  agent_id      text,
  content       text not null,
  github_id     bigint,
  is_thinking   boolean default false,
  created_at    timestamptz not null default now()
);

create table if not exists project_build_steps (
  id            text primary key,
  workspace_id  text not null references workspaces(id) on delete cascade,
  project_id    text not null references projects(id) on delete cascade,
  label         text not null,
  phase         text not null,
  agent_id      text,
  squad_id      text,
  position      integer not null default 0,
  enabled       boolean not null default true,
  required      boolean not null default true,
  approval_gate boolean not null default false,
  depends_on    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists skills (
  id              text primary key,
  name            text not null,
  category        text not null,
  permissions     text not null,
  description     text not null,
  is_enabled      boolean default true,
  command_example text,
  source          text default 'builtin',
  path            text,
  installed       boolean default false
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. PER-DEVELOPER — owned rows, private by policy
-- ─────────────────────────────────────────────────────────────────────────
--
-- Everything below carries `owner_id`: the GitHub login of the developer whose
-- work it is. That column is the whole isolation mechanism. Six separate
-- databases would give the same privacy and destroy every cross-developer
-- query the product is for — the PM dashboard, the Live Build Room, analytics.

-- `owner_id` is new. In SQLite this table has only `workspace_id`, so
-- `GET /chat/threads` returned every thread in the workspace to every member:
-- any developer could read any other developer's prompts. There was no column
-- to filter on, which is why the filter was never written.
create table if not exists chat_threads (
  id                   text primary key,
  workspace_id         text not null references workspaces(id) on delete cascade,
  owner_id             text not null,
  project_id           text,
  title                text not null,
  last_message_snippet text,
  last_message_at      timestamptz not null default now(),
  agent_ids            jsonb not null default '[]'::jsonb,
  target_agent_id      text,
  target_squad_id      text,
  created_at           timestamptz not null default now()
);

create index if not exists idx_threads_owner on chat_threads (owner_id, last_message_at desc);

-- No owner of its own: a message belongs to whoever owns its thread, and a
-- second copy of that fact is a second thing to keep in step. Policies join.
create table if not exists chat_messages (
  id                text primary key,
  thread_id         text not null references chat_threads(id) on delete cascade,
  sender_type       text not null,
  sender_name       text not null,
  agent_id          text,
  content           text not null,
  thinking_process  text,
  tools_executed    jsonb not null default '[]'::jsonb,
  message_type      text default 'assistant',
  agent_call_id     text,
  squad_id          text,
  operation_mode    text,
  agent_call_status text,
  revision_target   text,
  timestamp         timestamptz not null default now()
);

create index if not exists idx_messages_thread on chat_messages (thread_id, timestamp);

-- `requested_by` already existed in SQLite and was never enforced on read.
-- Kept under that name rather than renamed to owner_id: it is the column the
-- application writes, and a rename is churn the policies do not need.
create table if not exists agent_calls (
  id                    text primary key,
  workspace_id          text not null references workspaces(id) on delete cascade,
  project_id            text not null,
  thread_id             text not null references chat_threads(id) on delete cascade,
  message_id            text,
  squad_id              text not null,
  agent_id              text not null,
  requested_by          text not null,
  operation_mode        text not null,
  status                text not null,
  revision_target_type  text,
  revision_target_id    text,
  revision_target_label text,
  instruction           text not null,
  working_copy_id       text,
  result_message_id     text,
  error                 text,
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  completed_at          timestamptz
);

create index if not exists idx_calls_requested_by on agent_calls (requested_by, created_at desc);

-- Artifacts are deliberately more visible than the call that produced them.
-- A patch is work product a PM has to be able to review; the instruction that
-- asked for it is a conversation.
--
-- `workspace_id` and `owner_id` are copied down from the parent call rather
-- than joined to, and that is load-bearing rather than an optimisation.
--
-- RLS composes through subqueries: a policy that reads another table sees that
-- table's policies too. The first version of this checked
-- `exists (select 1 from agent_calls ...)`, which cannot work here, because
-- the whole point is to grant a PM access to an artifact whose parent call
-- they are forbidden to read. The subquery returned no row and the grant never
-- fired. A policy may only widen access beyond its parent if it does not have
-- to read that parent to decide.
create table if not exists agent_call_artifacts (
  id                text primary key,
  agent_call_id     text not null references agent_calls(id) on delete cascade,
  workspace_id      text not null references workspaces(id) on delete cascade,
  owner_id          text not null,
  artifact_type     text not null,
  path              text,
  content_reference text,
  content           text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_artifacts_call on agent_call_artifacts (agent_call_id);

-- `owner_id` and `machine_id` are both new. owner_id answers "whose run is
-- this"; machine_id answers "which of their machines is executing it", which
-- the Live Build Room needs and which SQLite already anticipated — its
-- thread_sessions table has carried machine_id in its primary key since before
-- any of this, with a comment saying it "starts varying the day threads sync
-- through Supabase".
create table if not exists prototype_runs (
  id                  text primary key,
  workspace_id        text not null references workspaces(id) on delete cascade,
  owner_id            text not null,
  machine_id          text,
  issue_id            text not null references issues(id) on delete cascade,
  project_id          text not null references projects(id) on delete cascade,
  agent_id            text not null,
  status              text not null,
  scenario            text default 'success',
  plan                jsonb not null default '[]'::jsonb,
  current_stage_index integer default 0,
  stages              jsonb not null default '[]'::jsonb,
  branch_name         text,
  pr_url              text,
  changed_files       integer default 0,
  insertions          integer default 0,
  deletions           integer default 0,
  test_summary        text,
  activities          jsonb not null default '[]'::jsonb,
  squad_run_id        text,
  squad_order         integer,
  input_tokens        integer,
  output_tokens       integer,
  cache_read_tokens   integer,
  cache_creation_tokens integer,
  thinking_tokens     integer,
  cost_usd            real,
  num_turns           integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_runs_workspace on prototype_runs (workspace_id, updated_at desc);
create index if not exists idx_runs_owner on prototype_runs (owner_id, updated_at desc);

create table if not exists squad_runs (
  id                   text primary key,
  workspace_id         text not null references workspaces(id) on delete cascade,
  owner_id             text not null,
  machine_id           text,
  squad_id             text not null,
  issue_id             text not null,
  project_id           text not null,
  branch_name          text not null,
  member_agent_ids     jsonb not null default '[]'::jsonb,
  current_member_index integer not null default 0,
  status               text not null,
  mission              text not null default '',
  plan                 jsonb not null default '[]'::jsonb,
  stopped_reason       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- The audit log. Append-only by policy: an actor who can delete their own
-- audit rows has not been audited.
create table if not exists remote_actions (
  id           text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  run_id       text,
  agent_id     text,
  issue_id     text,
  actor        text not null,
  action       text not null,
  target       text,
  detail       text,
  succeeded    boolean not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_actions_workspace on remote_actions (workspace_id, created_at desc);
