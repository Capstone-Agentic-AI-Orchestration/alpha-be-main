-- STAGING ONLY: fresh Alpha Ticketing Staging control-plane baseline.
-- User approved matching deployed live SQL through 0015; excludes 0016/0017.
-- Source: read-only migration history from gupmckxxaaxlameekihy, 7 October 2026.
-- No application/Auth/Storage rows, credentials or live migration-ledger changes.
-- Keep historical supabase/migrations files unchanged.
-- Run only via the reviewed staging workflow for pvbppmajgsbkrnvxlzrn.
set local search_path = public;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
do $staging_preflight$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','alpha','alpha_private')
      and c.relkind in ('r','p','v','m','S','f')
  ) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('alpha','alpha_private')
  ) then
    raise exception 'Staging baseline requires empty application schemas; do not replay over existing work.';
  end if;
end
$staging_preflight$;

-- Recorded source: 20260921145036 control_plane_schema
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


-- Recorded source: 20260921145305 row_level_security
-- Alpha cloud control plane — row level security
--
-- Why this file is the security boundary, and not merely defence in depth.
--
-- The desktop app talks to Postgres directly. It has to: Render's free tier
-- cold-starts at around thirty seconds, and a developer will not accept that
-- on every board action, so writes cannot be proxied through the API. That
-- means a developer's machine holds a token which reaches this database, and
-- the authorization checks in the Express routes are simply not in that path.
--
-- What stands between one developer's session and another's conversations is
-- the policies below. Nothing else.
--
-- ── The claims contract ──────────────────────────────────────────────────
--
-- Alpha mints its own short-lived JWT from a session and Supabase is
-- configured to trust that issuer, so `auth.jwt()` returns Alpha's claims:
--
--   sub          GitHub login, e.g. 'LloydLim1'
--   workspace_id the active workspace for this token
--   alpha_role   'client' | 'dev' | 'pm' | 'admin'
--
-- `auth.uid()` is deliberately unused: it casts to uuid, and Alpha's subject
-- is a login. Claims are read as text throughout.
--
-- The role travels in the token rather than being read from workspace_members
-- on every check. A membership lookup inside a policy runs per row, and the
-- token is already minted from a session that resolved the role at sign-in.
-- The cost is that a role change takes effect at next token refresh.

-- ─────────────────────────────────────────────────────────────────────────
-- Claim accessors
-- ─────────────────────────────────────────────────────────────────────────
--
-- `stable` so the planner evaluates them once per statement rather than once
-- per row — the difference between an index scan and a sequential one on a
-- table of any size.

create or replace function alpha.login() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

create or replace function alpha.workspace() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'workspace_id', '')
$$;

-- Not named `role`: that is a reserved word in Postgres and `current_role` is
-- a built-in meaning something else entirely.
create or replace function alpha.alpha_role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'alpha_role', 'client')
$$;

-- "Can see the whole workspace." PMs and admins oversee delivery; developers
-- and clients are scoped to what they own or are assigned.
create or replace function alpha.is_overseer() returns boolean
language sql stable as $$
  select alpha.alpha_role() in ('pm', 'admin')
$$;

create or replace function alpha.is_admin() returns boolean
language sql stable as $$
  select alpha.alpha_role() = 'admin'
$$;

-- A row in the caller's active workspace.
create or replace function alpha.in_workspace(row_workspace text) returns boolean
language sql stable as $$
  select row_workspace is not distinct from alpha.workspace()
$$;

-- A policy runs as the caller, so every accessor above is resolved with the
-- caller's privileges. Functions are executable by PUBLIC by default; a new
-- schema is not usable by anyone but its owner. Without this grant every
-- policy below fails with "permission denied for schema alpha" -- an error
-- raised before the policy has decided anything.
--
-- `authenticated` is the role Alpha's minted tokens ask for. `anon` is granted
-- too, so a tokenless request is refused by the policies and returns no rows,
-- rather than erroring on the schema first.
grant usage on schema alpha to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Enable RLS everywhere
-- ─────────────────────────────────────────────────────────────────────────
--
-- A table with RLS enabled and no policy denies everything, which is the right
-- default: a table added later and forgotten here fails closed and loudly,
-- rather than being readable by every token in the system.

alter table workspaces                    enable row level security;
alter table workspace_members             enable row level security;
alter table workspace_project_assignments enable row level security;
alter table workspace_squad_owners        enable row level security;
alter table workspace_squad_projects      enable row level security;
alter table workspace_entity_bindings     enable row level security;
alter table projects                      enable row level security;
alter table agents                        enable row level security;
alter table squads                        enable row level security;
alter table issues                        enable row level security;
alter table issue_comments                enable row level security;
alter table project_build_steps           enable row level security;
alter table skills                        enable row level security;
alter table chat_threads                  enable row level security;
alter table chat_messages                 enable row level security;
alter table agent_calls                   enable row level security;
alter table agent_call_artifacts          enable row level security;
alter table prototype_runs                enable row level security;
alter table squad_runs                    enable row level security;
alter table remote_actions                enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- Workspace and membership
-- ─────────────────────────────────────────────────────────────────────────

create policy "read own workspace" on workspaces
  for select using (id = alpha.workspace());

create policy "admins update their workspace" on workspaces
  for update using (id = alpha.workspace() and alpha.is_admin());

-- Everyone sees the roster: knowing who your colleagues are is not privileged,
-- and the team view depends on it.
create policy "read the roster" on workspace_members
  for select using (alpha.in_workspace(workspace_id));

-- Only admins change it, and `with check` as well as `using` so an admin
-- cannot move a member into a workspace they do not administer.
create policy "admins manage members" on workspace_members
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_admin())
  with check (alpha.in_workspace(workspace_id) and alpha.is_admin());

create policy "read assignments" on workspace_project_assignments
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers manage assignments" on workspace_project_assignments
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

create policy "read squad owners" on workspace_squad_owners
  for select using (alpha.in_workspace(workspace_id));

create policy "own or oversee squad ownership" on workspace_squad_owners
  for all
  using (alpha.in_workspace(workspace_id) and (user_id = alpha.login() or alpha.is_overseer()))
  with check (alpha.in_workspace(workspace_id) and (user_id = alpha.login() or alpha.is_overseer()));

create policy "read squad projects" on workspace_squad_projects
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers manage squad projects" on workspace_squad_projects
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

create policy "read bindings" on workspace_entity_bindings
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers manage bindings" on workspace_entity_bindings
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

-- ─────────────────────────────────────────────────────────────────────────
-- Shared canonical — the board
-- ─────────────────────────────────────────────────────────────────────────
--
-- Workspace-wide read is intentional and was a decision, not an oversight.
-- Developers could not previously discover projects they were not assigned to,
-- which made "All Workspace Projects" impossible and left people unable to see
-- the work they were about to be asked to do.

create policy "members read projects" on projects
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers write projects" on projects
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

create policy "members read agents" on agents
  for select using (alpha.in_workspace(workspace_id));

create policy "developers write agents" on agents
  for all
  using (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'))
  with check (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'));

create policy "members read squads" on squads
  for select using (alpha.in_workspace(workspace_id));

create policy "developers write squads" on squads
  for all
  using (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'))
  with check (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'));

-- Clients are the exception to workspace-wide read. A client is external, and
-- the issue tracker is internal delivery detail: they see specifications and
-- their own messages, not the engineering board.
create policy "internal roles read issues" on issues
  for select using (alpha.in_workspace(workspace_id) and alpha.alpha_role() <> 'client');

create policy "internal roles write issues" on issues
  for all
  using (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'pm', 'admin'))
  with check (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'pm', 'admin'));

create policy "read comments on visible issues" on issue_comments
  for select using (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and alpha.in_workspace(i.workspace_id)
        and alpha.alpha_role() <> 'client'
    )
  );

create policy "write comments on visible issues" on issue_comments
  for insert with check (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and alpha.in_workspace(i.workspace_id)
        and alpha.alpha_role() in ('dev', 'pm', 'admin')
    )
  );

create policy "members read build steps" on project_build_steps
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers write build steps" on project_build_steps
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

-- Skills are a catalogue of capabilities, not workspace data, so every signed
-- token reads them and only an admin edits.
create policy "everyone reads skills" on skills
  for select using (alpha.login() is not null);

create policy "admins write skills" on skills
  for all using (alpha.is_admin()) with check (alpha.is_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- Per-developer — the privacy boundary
-- ─────────────────────────────────────────────────────────────────────────
--
-- Conversations are owner-only, with NO overseer bypass. That is deliberate
-- and is the decision this whole split was made for: a developer's prompts are
-- their working notes, not managed output. A PM sees the work — runs, stages,
-- patches, pull requests — and not the thinking that produced it.
--
-- It is also the one place where a policy differs in shape from the existing
-- `canAccessSquad`, which does grant pm/admin a bypass. The difference is
-- intentional; squads are configuration, conversations are not.

create policy "own threads" on chat_threads
  for all
  using (alpha.in_workspace(workspace_id) and owner_id = alpha.login())
  with check (alpha.in_workspace(workspace_id) and owner_id = alpha.login());

-- A message inherits its thread's owner rather than carrying a second copy of
-- that fact, which could drift out of step with it.
create policy "messages in own threads" on chat_messages
  for all
  using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = alpha.login()
    )
  )
  with check (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = alpha.login()
    )
  );

-- `instruction` is the prompt, so the call is as private as the conversation.
create policy "own agent calls" on agent_calls
  for all
  using (alpha.in_workspace(workspace_id) and requested_by = alpha.login())
  with check (alpha.in_workspace(workspace_id) and requested_by = alpha.login());

-- Artifacts are the exception, and the line worth being precise about: a patch
-- is work product that has to be reviewable, so overseers read it. They still
-- cannot read the instruction that produced it.
--
-- Decided from the artifact's own columns, never by reading the parent call.
-- RLS applies inside a policy's subqueries, so `exists (select 1 from
-- agent_calls ...)` would be evaluated under the *caller's* access to
-- agent_calls -- which for a PM is none, by the policy directly above. The
-- grant would silently never fire. A policy can only widen access beyond its
-- parent if it can decide without reading that parent.
create policy "read own or overseen artifacts" on agent_call_artifacts
  for select using (
    alpha.in_workspace(workspace_id) and (owner_id = alpha.login() or alpha.is_overseer())
  );

create policy "write own artifacts" on agent_call_artifacts
  for insert with check (
    alpha.in_workspace(workspace_id) and owner_id = alpha.login()
  );

-- Runs are telemetry, and telemetry is what oversight is made of. This is the
-- Live Build Room: a PM watching a developer's squad hand off between agents.
create policy "read own or overseen runs" on prototype_runs
  for select using (
    alpha.in_workspace(workspace_id) and (owner_id = alpha.login() or alpha.is_overseer())
  );

create policy "write own runs" on prototype_runs
  for all
  using (alpha.in_workspace(workspace_id) and owner_id = alpha.login())
  with check (alpha.in_workspace(workspace_id) and owner_id = alpha.login());

create policy "read own or overseen squad runs" on squad_runs
  for select using (
    alpha.in_workspace(workspace_id) and (owner_id = alpha.login() or alpha.is_overseer())
  );

create policy "write own squad runs" on squad_runs
  for all
  using (alpha.in_workspace(workspace_id) and owner_id = alpha.login())
  with check (alpha.in_workspace(workspace_id) and owner_id = alpha.login());

-- ─────────────────────────────────────────────────────────────────────────
-- Audit
-- ─────────────────────────────────────────────────────────────────────────
--
-- Insert and select only. No update policy, no delete policy — and with RLS
-- enabled, an operation with no policy is denied. An actor who can rewrite
-- their own audit trail has not been audited, so the omission is the feature.

create policy "read own or overseen audit" on remote_actions
  for select using (
    alpha.in_workspace(workspace_id) and (actor = alpha.login() or alpha.is_overseer())
  );

create policy "append to own audit" on remote_actions
  for insert with check (alpha.in_workspace(workspace_id) and actor = alpha.login());


-- Recorded source: 20260921231218 agent_exec_config_stays_local
-- Alpha cloud control plane — an agent's execution config stays on the machine
--
-- `custom_cli_args` and `env_vars` are input to a process the desktop spawns:
-- flags appended to the agent CLI's command line, and variables merged over
-- its environment. In a shared table they are writable by every developer in
-- the workspace ("developers write agents") and readable by every member
-- ("members read agents"). So:
--
--   - a developer could set NODE_OPTIONS, PATH or BASH_ENV on a shared agent
--     and have it run code on every teammate's machine that runs that agent.
--     `custom_cli_args` is filtered by a denylist, which is a weaker promise
--     than never receiving the value at all;
--   - an API key someone kept in env_vars -- which is what it is for -- would
--     be readable by every member of the workspace, clients included.
--
-- Neither is shared state. Like a path, they only mean something on one
-- machine, and they stay in the desktop's SQLite: the rule 0001 states for
-- paths applies to anything that would execute there, too.
--
-- Dropped rather than locked with column privileges. Supabase grants table
-- privileges to `authenticated`, and in Postgres a column-level REVOKE does not
-- subtract from a table-level GRANT -- `revoke update (env_vars) on agents`
-- would have run cleanly and changed nothing.
--
-- The store driver must not map these two fields onto cloud rows.

alter table agents drop column if exists custom_cli_args;
alter table agents drop column if exists env_vars;


-- Recorded source: 20260921231230 trust_only_alpha_tokens
-- Alpha cloud control plane — trust only tokens Alpha issued
--
-- The claim accessors in 0002 read whatever `auth.jwt()` returns. Supabase
-- verifies a token's signature, not who issued it, and more than Alpha signs
-- with this project's secret: Supabase Auth mints session tokens (sign-ups are
-- off today, but that is one dashboard toggle), and the project's API keys are
-- JWTs too. A Supabase Auth session carries a `sub`, and "everyone reads
-- skills" granted read to any token with a subject.
--
-- So the accessors now take claims only from a token whose issuer is 'alpha',
-- which `supabaseTokenService` stamps on every token it mints. Anything else
-- reads as no login, no workspace and the lowest role -- the same as the anon
-- key. One accessor holds the check, so no policy can read around it.
--
-- `create or replace` keeps each function's grants and every policy that calls
-- it; nothing else needs recreating.
--
-- Left as they are, on purpose, and flagged by Supabase's advisors:
--
--   - `search_path` is not pinned on these functions. A SET clause stops a SQL
--     function being inlined, so every policy would call it once per row. They
--     are SECURITY INVOKER -- they run with the caller's own rights -- and
--     PostgREST callers cannot set search_path, so pinning it buys nothing
--     until the policies are rewritten to call them as `(select ...)` initplans.
--   - "multiple permissive policies": each `for all` write policy also applies
--     to SELECT beside its read policy. A cost per row, not a hole; worth
--     splitting when the tables are large enough to notice.

create or replace function alpha.claims() returns jsonb
language sql stable as $$
  select case when auth.jwt() ->> 'iss' = 'alpha' then auth.jwt() else '{}'::jsonb end
$$;

create or replace function alpha.login() returns text
language sql stable as $$
  select nullif(alpha.claims() ->> 'sub', '')
$$;

create or replace function alpha.workspace() returns text
language sql stable as $$
  select nullif(alpha.claims() ->> 'workspace_id', '')
$$;

create or replace function alpha.alpha_role() returns text
language sql stable as $$
  select coalesce(alpha.claims() ->> 'alpha_role', 'client')
$$;


-- Recorded source: 20260921231234 index_foreign_keys
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


-- Recorded source: 20260922032515 private_run_channels
create policy "listen to runs you can see" on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and exists (
      select 1 from public.prototype_runs r
      where 'run:' || r.id = realtime.topic()
    )
  );

create policy "publish to your own runs" on realtime.messages
  for insert to authenticated
  with check (
    extension = 'broadcast'
    and exists (
      select 1 from public.prototype_runs r
      where 'run:' || r.id = realtime.topic()
        and r.owner_id = alpha.login()
    )
  );

-- Recorded source: 20260922032523 server_sessions
create schema if not exists alpha_private;
revoke all on schema alpha_private from public, anon, authenticated;

create table if not exists alpha_private.sessions (
  id           text primary key,
  login        text not null,
  name         text,
  role         text not null check (role in ('client', 'dev', 'pm', 'admin')),
  token_cipher text not null,
  token_iv     text not null,
  token_tag    text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz
);

create index if not exists idx_sessions_login on alpha_private.sessions (login);
create index if not exists idx_sessions_expires on alpha_private.sessions (expires_at);

alter table alpha_private.sessions enable row level security;
revoke all on alpha_private.sessions from public, anon, authenticated;

-- Recorded source: 20260922032528 one_owner_per_squad
alter table workspace_squad_owners
  drop constraint if exists workspace_squad_owners_workspace_id_squad_id_user_id_key;

alter table workspace_squad_owners
  add constraint workspace_squad_owners_workspace_id_squad_id_key
  unique (workspace_id, squad_id);

-- Recorded source: 20260922032535 issue_assignee_without_roster
alter table issues
  drop constraint if exists issues_assigned_agent_id_fkey;

comment on column issues.assigned_agent_id is
  'Agent that owns this issue. Not a foreign key while the roster is per-machine; see 0009.';

-- Recorded source: 20260922032543 agent_visibility_and_templates
alter table agents add column if not exists allowed_users    text;
alter table agents add column if not exists template_key     text;
alter table agents add column if not exists template_version integer;
alter table agents add column if not exists phase            text;
alter table agents add column if not exists is_seeded        boolean not null default false;

create unique index if not exists idx_agents_workspace_template
  on agents (workspace_id, template_key)
  where template_key is not null;

-- Recorded source: 20260922090006 shared_roster
drop policy if exists "members read agents" on agents;

create policy "members read agents they may address" on agents
  for select using (
    alpha.in_workspace(workspace_id) and (
      coalesce(allowed_users, 'team') = 'everyone'
      or (coalesce(allowed_users, 'team') = 'team' and alpha.alpha_role() <> 'client')
      or (allowed_users = 'admins' and alpha.is_admin())
      or (allowed_users = 'private' and owner = alpha.login())
    )
  );

drop policy if exists "developers write agents" on agents;

create policy "developers add agents" on agents
  for insert
  with check (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  );

create policy "developers change agents" on agents
  for update
  using (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  )
  with check (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  );

create policy "developers remove agents" on agents
  for delete
  using (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  );

update issues
   set assigned_agent_id = null
 where assigned_agent_id is not null
   and not exists (select 1 from agents a where a.id = issues.assigned_agent_id);

alter table issues
  drop constraint if exists issues_assigned_agent_id_fkey;

alter table issues
  add constraint issues_assigned_agent_id_fkey
  foreign key (assigned_agent_id) references agents(id) on delete set null;

comment on column issues.assigned_agent_id is
  'Agent that owns this issue. A real reference again since 0011; cleared if that agent is deleted.';

-- Recorded source: 20260922111102 live_board
create or replace function alpha.broadcast_board_change()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
declare
  board_workspace text;
begin
  if tg_op = 'DELETE' then
    board_workspace := old.workspace_id;
  else
    board_workspace := new.workspace_id;
  end if;

  if board_workspace is null then
    return null;
  end if;

  perform realtime.broadcast_changes(
    'workspace:' || board_workspace || ':board',
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

comment on function alpha.broadcast_board_change() is
  'Announces a board write on the workspace channel. SECURITY DEFINER so the announcement is not subject to the writer''s own row policies.';

drop trigger if exists broadcast_issue_changes on issues;
create trigger broadcast_issue_changes
  after insert or update or delete on issues
  for each row execute function alpha.broadcast_board_change();

drop trigger if exists broadcast_project_changes on projects;
create trigger broadcast_project_changes
  after insert or update or delete on projects
  for each row execute function alpha.broadcast_board_change();

drop policy if exists "listen to your workspace board" on realtime.messages;
create policy "listen to your workspace board" on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and alpha.workspace() is not null
    and realtime.topic() = 'workspace:' || alpha.workspace() || ':board'
  );

-- Recorded source: 20260922130230 policy_hygiene
create or replace function alpha.claims() returns jsonb
language sql stable set search_path = '' as $$
  select case when auth.jwt() ->> 'iss' = 'alpha' then auth.jwt() else '{}'::jsonb end
$$;

create or replace function alpha.login() returns text
language sql stable set search_path = '' as $$
  select nullif(alpha.claims() ->> 'sub', '')
$$;

create or replace function alpha.workspace() returns text
language sql stable set search_path = '' as $$
  select nullif(alpha.claims() ->> 'workspace_id', '')
$$;

create or replace function alpha.alpha_role() returns text
language sql stable set search_path = '' as $$
  select coalesce(alpha.claims() ->> 'alpha_role', 'client')
$$;

create or replace function alpha.is_overseer() returns boolean
language sql stable set search_path = '' as $$
  select alpha.alpha_role() in ('pm', 'admin')
$$;

create or replace function alpha.is_admin() returns boolean
language sql stable set search_path = '' as $$
  select alpha.alpha_role() = 'admin'
$$;

create or replace function alpha.in_workspace(row_workspace text) returns boolean
language sql stable set search_path = '' as $$
  select row_workspace is not distinct from alpha.workspace()
$$;

drop policy if exists "read own workspace" on workspaces;
create policy "read own workspace" on workspaces
  for select using (id = (select alpha.workspace()));

drop policy if exists "admins update their workspace" on workspaces;
create policy "admins update their workspace" on workspaces
  for update using (id = (select alpha.workspace()) and (select alpha.is_admin()));

drop policy if exists "read the roster" on workspace_members;
create policy "read the roster" on workspace_members
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "admins manage members" on workspace_members;
create policy "admins add members" on workspace_members
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()));
create policy "admins change members" on workspace_members
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()));
create policy "admins remove members" on workspace_members
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()));

drop policy if exists "read assignments" on workspace_project_assignments;
create policy "read assignments" on workspace_project_assignments
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers manage assignments" on workspace_project_assignments;
create policy "overseers add assignments" on workspace_project_assignments
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change assignments" on workspace_project_assignments
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove assignments" on workspace_project_assignments
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "read squad owners" on workspace_squad_owners;
create policy "read squad owners" on workspace_squad_owners
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "own or oversee squad ownership" on workspace_squad_owners;
create policy "claim squad ownership" on workspace_squad_owners
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  );
create policy "change squad ownership" on workspace_squad_owners
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  );
create policy "release squad ownership" on workspace_squad_owners
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "read squad projects" on workspace_squad_projects;
create policy "read squad projects" on workspace_squad_projects
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers manage squad projects" on workspace_squad_projects;
create policy "overseers assign squads" on workspace_squad_projects
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change squad assignments" on workspace_squad_projects
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers unassign squads" on workspace_squad_projects
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "read bindings" on workspace_entity_bindings;
create policy "read bindings" on workspace_entity_bindings
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers manage bindings" on workspace_entity_bindings;
create policy "overseers add bindings" on workspace_entity_bindings
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change bindings" on workspace_entity_bindings
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove bindings" on workspace_entity_bindings
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "members read projects" on projects;
create policy "members read projects" on projects
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers write projects" on projects;
create policy "overseers add projects" on projects
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change projects" on projects
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove projects" on projects
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "members read agents" on agents;
drop policy if exists "developers write agents" on agents;
drop policy if exists "members read agents they may address" on agents;
create policy "members read agents they may address" on agents
  for select using (
    workspace_id is not distinct from (select alpha.workspace()) and (
      coalesce(allowed_users, 'team') = 'everyone'
      or (coalesce(allowed_users, 'team') = 'team' and (select alpha.alpha_role()) <> 'client')
      or (allowed_users = 'admins' and (select alpha.is_admin()))
      or (allowed_users = 'private' and owner = (select alpha.login()))
    )
  );

drop policy if exists "developers add agents" on agents;
drop policy if exists "developers change agents" on agents;
drop policy if exists "developers remove agents" on agents;
create policy "developers add agents" on agents
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );
create policy "developers change agents" on agents
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );
create policy "developers remove agents" on agents
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );

drop policy if exists "members read squads" on squads;
create policy "members read squads" on squads
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "developers write squads" on squads;
create policy "developers add squads" on squads
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  );
create policy "developers change squads" on squads
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  );
create policy "developers remove squads" on squads
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  );

drop policy if exists "internal roles read issues" on issues;
create policy "internal roles read issues" on issues
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) <> 'client'
  );

drop policy if exists "internal roles write issues" on issues;
create policy "internal roles add issues" on issues
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  );
create policy "internal roles change issues" on issues
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  );
create policy "internal roles remove issues" on issues
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  );

drop policy if exists "read comments on visible issues" on issue_comments;
create policy "read comments on visible issues" on issue_comments
  for select using (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and i.workspace_id is not distinct from (select alpha.workspace())
        and (select alpha.alpha_role()) <> 'client'
    )
  );

drop policy if exists "write comments on visible issues" on issue_comments;
create policy "write comments on visible issues" on issue_comments
  for insert with check (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and i.workspace_id is not distinct from (select alpha.workspace())
        and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    )
  );

drop policy if exists "members read build steps" on project_build_steps;
create policy "members read build steps" on project_build_steps
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers write build steps" on project_build_steps;
create policy "overseers add build steps" on project_build_steps
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change build steps" on project_build_steps
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove build steps" on project_build_steps
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "everyone reads skills" on skills;
create policy "everyone reads skills" on skills
  for select using ((select alpha.login()) is not null);

drop policy if exists "admins write skills" on skills;
create policy "admins add skills" on skills
  for insert with check ((select alpha.is_admin()));
create policy "admins change skills" on skills
  for update using ((select alpha.is_admin())) with check ((select alpha.is_admin()));
create policy "admins remove skills" on skills
  for delete using ((select alpha.is_admin()));

drop policy if exists "own threads" on chat_threads;
create policy "read own threads" on chat_threads
  for select using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "start own threads" on chat_threads
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "change own threads" on chat_threads
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "delete own threads" on chat_threads
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

drop policy if exists "messages in own threads" on chat_messages;
create policy "read messages in own threads" on chat_messages
  for select using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );
create policy "add messages to own threads" on chat_messages
  for insert with check (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );
create policy "change messages in own threads" on chat_messages
  for update using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  )
  with check (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );
create policy "delete messages in own threads" on chat_messages
  for delete using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );

drop policy if exists "own agent calls" on agent_calls;
create policy "read own agent calls" on agent_calls
  for select using (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );
create policy "make own agent calls" on agent_calls
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );
create policy "change own agent calls" on agent_calls
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );
create policy "delete own agent calls" on agent_calls
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );

drop policy if exists "read own or overseen artifacts" on agent_call_artifacts;
create policy "read own or overseen artifacts" on agent_call_artifacts
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (owner_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "write own artifacts" on agent_call_artifacts;
create policy "write own artifacts" on agent_call_artifacts
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

drop policy if exists "read own or overseen runs" on prototype_runs;
create policy "read own or overseen runs" on prototype_runs
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (owner_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "write own runs" on prototype_runs;
create policy "start own runs" on prototype_runs
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "change own runs" on prototype_runs
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "delete own runs" on prototype_runs
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

drop policy if exists "read own or overseen squad runs" on squad_runs;
create policy "read own or overseen squad runs" on squad_runs
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (owner_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "write own squad runs" on squad_runs;
create policy "start own squad runs" on squad_runs
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "change own squad runs" on squad_runs
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "delete own squad runs" on squad_runs
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

drop policy if exists "read own or overseen audit" on remote_actions;
create policy "read own or overseen audit" on remote_actions
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (actor = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "append to own audit" on remote_actions;
create policy "append to own audit" on remote_actions
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and actor = (select alpha.login())
  );

-- Recorded source: 20260922165208 0014_drop_join_code
-- Alpha cloud control plane — the invite code, removed
--
-- Joining a workspace by code is gone: a project manager puts people in one,
-- against a name, as a decision they are accountable for. A code is the
-- opposite of that. It names nobody, it outlives the message it was pasted
-- into, and whoever ends up holding the string decides the staffing.
--
-- The route, the registry method, the directory interface and both store
-- implementations went with that change. This is the column they read, left
-- behind so that dropping it could be its own migration rather than smuggled
-- into a refactor.
--
-- ## Why it goes rather than staying harmlessly
--
-- It is not harmless. `summary()` still handed the code to admins, so the API
-- went on publishing a credential that nothing could redeem -- an invitation
-- to paste it somewhere and wonder why it did nothing. And a column that
-- exists is a column someone can write a query against: the next person to
-- want "let people join" would find a join_code sitting there and build the
-- door again without ever reading why it was closed.
--
-- ## Nothing is lost
--
-- The codes were never a record of anything. They granted access at the moment
-- they were typed and said nothing about who used one; membership itself lives
-- in `workspace_members`, which is untouched. There is no history here to keep.

drop index if exists idx_workspaces_join_code;

alter table workspaces drop column if exists join_code;

-- Recorded source: 20260924151814 0015_pm_project_ownership
-- Projects are started by project managers (fe #32).
--
-- A workspace's catalogue is the projects an active PM created: the
-- organisation's repositories are not all projects, and one with no PM behind
-- it is nobody's to run. `created_by` records that PM. The API sets it from
-- the signed-in person; these policies are the boundary for desktops, which
-- read and write this table directly with their own database token.
--
-- Who may do what:
--   read    developers, PMs and admins: every PM-owned project in the
--           workspace. Clients: only projects they are assigned to.
--   create  project managers, as themselves.
--   update  developers, PMs and admins, on PM-owned projects. Developers run
--           projects day to day; they cannot start or remove one.
--   delete  PMs and admins, on PM-owned projects.
--   owner   `created_by` never changes once set (trigger below).

alter table projects add column if not exists created_by text;

create index if not exists idx_projects_created_by
  on projects (workspace_id, created_by);

-- Backfill: nothing that exists disappears.
update projects p
set created_by = coalesce(
  (
    select w.created_by
    from workspaces w
    join workspace_members m
      on m.workspace_id = w.id and m.user_id = w.created_by
     and m.role = 'pm' and m.status = 'active'
    where w.id = p.workspace_id
  ),
  (
    select m.user_id
    from workspace_members m
    where m.workspace_id = p.workspace_id and m.role = 'pm' and m.status = 'active'
    order by m.created_at asc, m.user_id asc
    limit 1
  )
)
where p.created_by is null;

create or replace function alpha.pm_owned(project_workspace text, project_creator text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select project_creator is not null and exists (
    select 1 from public.workspace_members m
    where m.workspace_id = project_workspace
      and m.user_id = project_creator
      and m.role = 'pm'
      and m.status = 'active'
  )
$$;

revoke all on function alpha.pm_owned(text, text) from public;
grant execute on function alpha.pm_owned(text, text) to authenticated;

drop policy if exists "members read projects" on projects;
drop policy if exists "pm-owned projects" on projects;
drop policy if exists "clients read assigned projects" on projects;
drop policy if exists "overseers write projects" on projects;
drop policy if exists "overseers add projects" on projects;
drop policy if exists "overseers change projects" on projects;
drop policy if exists "overseers remove projects" on projects;
drop policy if exists "pm add projects" on projects;
drop policy if exists "team change projects" on projects;
drop policy if exists "pm change projects" on projects;
drop policy if exists "overseers remove pm-owned projects" on projects;
drop policy if exists "pm remove projects" on projects;

create policy "pm-owned projects" on projects
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  );

create policy "clients read assigned projects" on projects
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'client'
    and exists (
      select 1 from workspace_project_assignments a
      where a.workspace_id = projects.workspace_id
        and a.project_id = projects.id
        and a.user_id = (select alpha.login())
        and a.status = 'active'
    )
  );

create policy "pm add projects" on projects
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'pm'
    and created_by = (select alpha.login())
    and alpha.pm_owned(workspace_id, created_by)
  );

create policy "team change projects" on projects
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  );

create policy "overseers remove pm-owned projects" on projects
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  );

create or replace function alpha.keep_project_owner()
returns trigger
language plpgsql
as $$
begin
  if old.created_by is not null and new.created_by is distinct from old.created_by then
    raise exception 'A project''s creator cannot be changed.' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists keep_project_owner on projects;
create trigger keep_project_owner
  before update of created_by on projects
  for each row execute function alpha.keep_project_owner();
